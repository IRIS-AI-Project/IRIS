"""Summarize local numeric voice traces without starting Iris or calling an API."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from datetime import datetime
from collections import Counter, defaultdict
from pathlib import Path


def distribution(values: list[float]) -> dict:
    ordered = sorted(values)
    return {"n": len(ordered), "p50_ms": round(statistics.median(ordered), 3) if ordered else None,
            "p95_ms": round(ordered[math.ceil(len(ordered) * .95) - 1], 3) if ordered else None}


def summarize_events(events: list[dict], *, owner: str | None = None,
                     since: float | None = None, until: float | None = None) -> dict:
    grouped = defaultdict(dict)
    for event in events:
        if event.get("version") == 1 and isinstance(event.get("trace_id"), str) and isinstance(event.get("sequence"), int):
            grouped[event["trace_id"]][event["sequence"]] = event
    statuses = Counter()
    owners = Counter()
    stages = defaultdict(list)
    intervals = defaultdict(list)
    playback = defaultdict(list)
    llm = defaultdict(list)
    incomplete = 0
    lookup_acknowledgements = 0
    missing_events = 0
    for records in grouped.values():
        points = [records[key] for key in sorted(records)]
        timestamp = points[0].get("timestamp")
        if ((since is not None and (timestamp is None or timestamp < since))
                or (until is not None and (timestamp is None or timestamp >= until))):
            continue
        started = next((e for e in points if e["stage"] == "playback.started"), None)
        claimed = next((e for e in reversed(points) if e["stage"] == "playback.owner"), None)
        playback_owner = (started or claimed or {}).get("metrics", {}).get("playback_owner", "unknown")
        if owner is not None and owner != playback_owner:
            continue
        terminal = next((e for e in points if e["stage"] == "trace.finished"), None)
        status = terminal["phase"] if terminal else "in_progress"
        statuses[status] += 1
        missing_events += max(records) - len(records)
        owners[playback_owner] += 1
        has_origin = any(e["stage"] == "input.endpoint_candidate" for e in points)
        if not has_origin or (status == "completed" and started is None):
            incomplete += 1
        acknowledged = any(e["stage"] == "lookup.acknowledgement" for e in points)
        lookup_acknowledgements += acknowledged
        # Cancelled/in-flight answers remain separate; never silently improve the successful P95.
        if started is not None and has_origin:
            muted = (started or {}).get("metrics", {}).get("muted") is True
            kind = "muted" if muted else "lookup_acknowledgement_possible" if acknowledged else "answer"
            playback[f"{playback_owner}/{status}/{kind}"].append(started["elapsed_ms"])
        span_starts = {e["span_id"]: e for e in points if e["phase"] == "start"}

        def first_tts_job(event):
            current, seen = event, set()
            while current is not None:
                if current["stage"] == "tts.job":
                    return current["metrics"].get("segment_id", 0) == 0
                parent = current.get("parent_id")
                if parent is None or parent in seen:
                    break
                seen.add(parent)
                current = span_starts.get(parent)
            return True

        for event in points:
            if event["phase"] == "end" and "duration_ms" in event["metrics"] and "error_type" not in event["metrics"]:
                if not event["stage"].startswith("tts.") or first_tts_job(event):
                    stages[event["stage"]].append(event["metrics"]["duration_ms"])
        for first, last, label in (
            ("llm.first_raw_text", "agent.first_delta", "raw_text_to_agent_delta"),
            ("agent.guard_released", "agent.truthfulness_released", "truthfulness_buffer"),
            ("agent.first_delta", "speech.first_segment", "speech_fragment_wait"),
            ("speech.first_segment", "audio.segment_ready", "first_speech_to_audio_ready"),
            ("audio.segment_ready", "playback.started", "audio_ready_to_playback_ack"),
            ("tts.infer_lock_requested", "tts.infer_lock_acquired", "tts_infer_lock_wait"),
            ("tts.native_lock_requested", "tts.native_lock_acquired", "tts_native_lock_wait"),
            ("stt.lock_requested", "stt.lock_acquired", "stt_lock_wait"),
        ):
            start = next((e for e in points if e["stage"] == first and e["metrics"].get("segment_id", 0) == 0), None)
            end = next((e for e in points if e["stage"] == last and e["metrics"].get("segment_id", 0) == 0), None)
            if start is not None and end is not None and end["elapsed_ms"] >= start["elapsed_ms"]:
                intervals[label].append(end["elapsed_ms"] - start["elapsed_ms"])
        requests = defaultdict(dict)
        for event in points:
            metrics = event["metrics"]
            if event["stage"].startswith("llm.") and metrics.get("request_id"):
                key = (metrics["request_id"], metrics.get("attempt", 1))
                requests[key].setdefault(event["stage"], event)
        for request in requests.values():
            begin = request.get("llm.request_started")
            if begin is None:
                continue
            purpose = begin["metrics"].get("purpose", "unknown")
            outcome = request.get("llm.request_completed", {}).get("metrics", {}).get("reason", "in_progress")
            for point, metric in (("llm.first_raw_text", "first_raw_text"), ("llm.first_tool_delta", "first_tool_delta"),
                                  ("llm.first_released_text", "first_released_text"), ("llm.request_completed", "complete")):
                if point in request:
                    delta = request[point]["elapsed_ms"] - begin["elapsed_ms"]
                    if delta >= 0:
                        llm[f"{purpose}/{outcome}/{metric}"].append(delta)
            if "llm.first_raw_text" in request and "llm.first_released_text" in request:
                delta = request["llm.first_released_text"]["elapsed_ms"] - request["llm.first_raw_text"]["elapsed_ms"]
                if delta >= 0:
                    llm[f"{purpose}/{outcome}/provider_buffering"].append(delta)
    return {"version": 1, "measurement": "software_playback_ack", "origin": "server_vad_estimate",
            "traces": sum(statuses.values()), "statuses": dict(statuses), "owners": dict(owners),
            "incomplete_traces": incomplete, "lookup_acknowledgement_traces": lookup_acknowledgements,
            "missing_events": missing_events,
            "playback": {k: distribution(v) for k, v in sorted(playback.items())},
            "stages": {k: distribution(v) for k, v in sorted(stages.items())},
            "intervals": {k: distribution(v) for k, v in sorted(intervals.items())},
            "llm": {k: distribution(v) for k, v in sorted(llm.items())}}


def load_events(paths: list[Path]) -> tuple[list[dict], int]:
    events, invalid = [], 0
    for path in paths:
        with path.open(encoding="utf-8-sig") as stream:
            for line in stream:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    if (not isinstance(event, dict) or not isinstance(event.get("trace_id"), str)
                            or not isinstance(event.get("sequence"), int)
                            or not isinstance(event.get("stage"), str) or not isinstance(event.get("phase"), str)
                            or not isinstance(event.get("metrics"), dict)
                            or not isinstance(event.get("elapsed_ms"), (int, float))
                            or not math.isfinite(event["elapsed_ms"])):
                        raise ValueError("Invalid trace record")
                    events.append(event)
                except (ValueError, TypeError):
                    invalid += 1
    return events, invalid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", type=Path, nargs="+", help="JSONL journal and, optionally, its .1/.2 rotations")
    parser.add_argument("--owner", choices=["unity", "desktop_ui"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--since", help="Start of a trace, ISO 8601 with timezone, inclusive")
    parser.add_argument("--until", help="Start of a trace, ISO 8601 with timezone, exclusive")
    args = parser.parse_args()
    def boundary(value):
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Timezone required")
            return parsed.timestamp()
        except ValueError:
            parser.error("Time boundaries must be ISO 8601 with an explicit timezone")
    events, invalid = load_events(args.paths)
    since, until = boundary(args.since), boundary(args.until)
    if since is not None and until is not None and since >= until:
        parser.error("--until must be later than --since")
    report = summarize_events(events, owner=args.owner, since=since, until=until)
    report["invalid_lines"] = invalid
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
