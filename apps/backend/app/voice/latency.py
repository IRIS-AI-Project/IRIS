"""Bounded, content-free voice traces. Disk I/O never runs on the audio path."""

from __future__ import annotations

import asyncio
import json
import math
import queue
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from logging import Formatter, LogRecord, INFO
from logging.handlers import RotatingFileHandler
from pathlib import Path
from uuid import uuid4


_trace: ContextVar[VoiceLatencyTrace | None] = ContextVar("voice_latency_trace", default=None)
_parent: ContextVar[int | None] = ContextVar("voice_latency_parent", default=None)
_NUMBER_FIELDS = frozenset({
    "duration_ms", "endpoint_silence_ms", "audio_ms", "sample_rate", "sample_position",
    "input_processing_ms", "input_max_frame_ms", "input_max_gap_ms", "candidate_id",
    "segment_id", "queue_depth", "text_length", "words", "attempt", "tools_count",
    "message_count", "input_chars", "prompt_tokens", "completion_tokens", "cache_hit_tokens",
    "cache_miss_tokens", "precomputed_chunks", "decode_ms", "schedule_lead_ms",
    "buffer_wait_ms", "base_latency_ms", "output_latency_ms", "client_latency_ms",
    "audio_bytes", "threads", "warm", "fallback", "complete", "muted", "streaming",
    "synthesis_ms", "websocket_send_ms", "tempo_processing_ms", "playback_ms",
    "required_sentences",
    "unlock_ms", "receive_to_decode_ms",
    "source_sample_rate", "stt_process_while_speaking", "parallel_appraisal",
    "first_segment_chars", "first_idle_flush_ms", "tts_threads", "stt_threads",
})
_LABEL_FIELDS = frozenset({
    "provider", "model", "revision", "device", "purpose", "request_id", "playback_owner",
    "origin", "measurement", "error_type", "reason", "action", "hold_reason", "format",
    "app_version", "launch_kind", "capture_profile", "vad_provider",
})
_LABEL = re.compile(r"[A-Za-z0-9_./:+-]{1,128}\Z")
_STATUSES = frozenset({"completed", "cancelled", "superseded", "observed", "empty", "error", "disconnected"})


def _metrics(fields: dict) -> dict:
    """An allowlist prevents transcripts, prompts, URLs and errors entering traces."""
    result = {}
    for key, value in fields.items():
        if key in _NUMBER_FIELDS and isinstance(value, (int, float)) and math.isfinite(value):
            result[key] = round(value, 3) if isinstance(value, float) else value
        elif key in _LABEL_FIELDS and isinstance(value, str) and _LABEL.fullmatch(value):
            result[key] = value
    return result


class VoiceLatencyTrace:
    def __init__(self, sink: Callable[[dict], None], *, session_id: str, generation: int,
                 candidate_id: int, started_at: float, clock: Callable[[], float] = time.perf_counter) -> None:
        self.trace_id = uuid4().hex
        self.session_id = session_id
        self.generation = generation
        self.candidate_id = candidate_id
        self.started_at = started_at
        self.utterance_id: str | None = None
        self.finished = False
        self._clock = clock
        self._sink = sink
        self._lock = threading.RLock()
        self._sequence = 0
        self._span = 0
        self._seen: set[tuple] = set()

    def once(self, stage: str, **fields) -> None:
        key = (stage, fields.get("hold_reason"), fields.get("request_id"))
        with self._lock:
            if key not in self._seen and len(self._seen) < 256:
                self._seen.add(key)
                self.mark(stage, **fields)

    def bind(self, utterance_id: str) -> None:
        with self._lock:
            if self.utterance_id == utterance_id:
                return
            self.utterance_id = utterance_id
            self.mark("utterance.bound")

    def mark(self, stage: str, *, phase: str = "point", span_id: int | None = None,
             parent_id: int | None = None, **fields) -> None:
        with self._lock:
            self._sequence += 1
            event = {
                "version": 1, "trace_id": self.trace_id, "session_id": self.session_id,
                "generation": self.generation, "candidate_id": self.candidate_id,
                "utterance_id": self.utterance_id, "sequence": self._sequence,
                "timestamp": time.time(), "elapsed_ms": round(max(0, self._clock() - self.started_at) * 1000, 3),
                "stage": stage, "phase": phase, "span_id": span_id,
                "parent_id": parent_id if parent_id is not None else _parent.get(),
                "metrics": _metrics(fields),
            }
            # Diagnostic failures must never alter the conversation.
            try:
                self._sink(event)
            except Exception:
                pass

    @contextmanager
    def span(self, stage: str, **fields) -> Iterator[None]:
        with self._lock:
            self._span += 1
            span_id = self._span
        parent_id = _parent.get()
        started = self._clock()
        self.mark(stage, phase="start", span_id=span_id, parent_id=parent_id, **fields)
        token = _parent.set(span_id)
        error = None
        try:
            yield
        except BaseException as exc:
            error = type(exc).__name__
            raise
        finally:
            _parent.reset(token)
            self.mark(stage, phase="end", span_id=span_id, parent_id=parent_id,
                      duration_ms=(self._clock() - started) * 1000, error_type=error, **fields)

    def finish(self, status: str, **fields) -> None:
        if status not in _STATUSES:
            raise ValueError("Unknown voice trace status")
        with self._lock:
            if self.finished:
                return
            self.finished = True
            self.mark("trace.finished", phase=status, **fields)


def current_voice_trace() -> VoiceLatencyTrace | None:
    return _trace.get()


@contextmanager
def voice_trace_scope(trace: VoiceLatencyTrace | None) -> Iterator[None]:
    token = _trace.set(trace)
    parent = _parent.set(None)
    try:
        yield
    finally:
        _parent.reset(parent)
        _trace.reset(token)


def latency_mark(stage: str, **fields) -> None:
    if (trace := _trace.get()) is not None:
        trace.mark(stage, **fields)


def latency_once(stage: str, **fields) -> None:
    if (trace := _trace.get()) is not None:
        trace.once(stage, **fields)


async def latency_first_delta(stream, stage: str):
    from contextlib import aclosing

    first = True
    async with aclosing(stream):
        async for delta in stream:
            if first and delta:
                first = False
                latency_mark(stage, text_length=len(delta))
            yield delta


@contextmanager
def latency_span(stage: str, **fields) -> Iterator[None]:
    if (trace := _trace.get()) is None:
        yield
    else:
        with trace.span(stage, **fields):
            yield


class VoiceLatencyJournal:
    """Recent traces plus a lazy, bounded background JSONL writer.

    The writer is deliberately independent of SQLite and the global event bus.
    An overflowing queue drops diagnostics instead of blocking microphone/TTS.
    """

    def __init__(self, path: Path | None = None, *, enabled: bool = True,
                 persist_allowed: Callable[[], bool] = lambda: True,
                 max_traces: int = 120, max_events: int = 256, queue_size: int = 2048,
                 max_bytes: int = 5 * 1024 * 1024, backups: int = 2) -> None:
        self.path, self.enabled = path, enabled
        self._persist_allowed = persist_allowed
        self._max_traces, self._max_events = max_traces, max_events
        self._max_bytes, self._backups = max_bytes, backups
        if min(max_traces, max_events, queue_size, max_bytes) < 1 or backups < 1:
            raise ValueError("Voice trace bounds must be positive")
        self._recent: OrderedDict[str, dict] = OrderedDict()
        self._queue: queue.Queue[dict] = queue.Queue(maxsize=queue_size)
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._closed = False
        self.dropped_events = 0
        self.write_errors = 0

    def start_trace(self, *, session_id: str, generation: int, candidate_id: int,
                    started_at: float) -> VoiceLatencyTrace | None:
        if not self.enabled or self._closed:
            return None
        return VoiceLatencyTrace(self.record, session_id=session_id, generation=generation,
                                 candidate_id=candidate_id, started_at=started_at)

    def record(self, event: dict) -> None:
        with self._lock:
            if self._closed or not self.enabled:
                return
            trace_id = event["trace_id"]
            item = self._recent.setdefault(trace_id, {"trace_id": trace_id, "status": "in_progress", "events": [], "truncated_events": 0})
            if event["phase"] in _STATUSES and event["stage"] == "trace.finished":
                item["status"] = event["phase"]
            if len(item["events"]) >= self._max_events:
                # Keep the origin and the newest milestones/terminal status.
                item["events"].pop(1 if self._max_events > 1 else 0)
                item["truncated_events"] += 1
            item["events"].append(event)
            self._recent.move_to_end(trace_id)
            while len(self._recent) > self._max_traces:
                self._recent.popitem(last=False)
            if self.path is None or not self._persist_allowed():
                return
            try:
                self._queue.put_nowait(event)
            except queue.Full:
                self.dropped_events += 1
                return
            if self._thread is None:
                self._thread = threading.Thread(target=self._write, name="voice-latency-journal", daemon=True)
                self._thread.start()

    def snapshot(self, limit: int = 30) -> dict:
        with self._lock:
            traces = [{**item, "events": list(item["events"])} for item in
                      list(self._recent.values())[-max(1, min(limit, self._max_traces)):]]
            report = {"enabled": self.enabled, "measurement": "software_playback_ack",
                      "origin": "server_vad_estimate", "dropped_events": self.dropped_events,
                      "write_errors": self.write_errors, "pending_writes": self._queue.qsize()}
        # Deep copies/serialization never hold the audio-path collector lock.
        report["traces"] = json.loads(json.dumps(traces))
        return report

    def _write(self) -> None:
        handler = None
        try:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                handler = RotatingFileHandler(self.path, maxBytes=self._max_bytes,
                                              backupCount=self._backups, encoding="utf-8")
                handler.setFormatter(Formatter("%(message)s"))
                # File errors are counted, never printed with event contents.
                handler.handleError = lambda record: self._write_error()
            except Exception:
                self._write_error()
            while not self._closed or not self._queue.empty():
                try:
                    event = self._queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    if handler is not None and self._persist_allowed():
                        handler.emit(LogRecord("voice.latency", INFO, "", 0, json.dumps(event, ensure_ascii=True), (), None))
                except Exception:
                    self._write_error()
                finally:
                    self._queue.task_done()
        finally:
            if handler is not None:
                handler.close()

    def _write_error(self) -> None:
        with self._lock:
            self.write_errors += 1

    async def close(self) -> None:
        with self._lock:
            self._closed = True
            thread = self._thread
        if thread is not None:
            await asyncio.to_thread(thread.join, 2.0)
