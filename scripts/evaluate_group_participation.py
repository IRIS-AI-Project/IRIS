"""Synthetic, opt-in model replay. No microphone, production history or tools."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from apps.backend.app.conversation.adjudicator import StructuredConversationAdjudicator
from apps.backend.app.conversation.decision import ConversationDecisionEngine
from apps.backend.app.conversation.participation import ConversationFloor, PendingAddress, resolve_group_participation
from apps.backend.app.conversation.schemas import ConversationAction, DecisionReason, EventAppraisal
from apps.backend.app.core.config import Settings
from apps.backend.app.llm.providers.deepseek import DeepSeekProvider, close_shared_clients


async def evaluate(args):
    credentials = json.load(sys.stdin) if args.credentials_stdin else {}
    settings = Settings(deepseek_api_key=credentials.get("api_key"))
    if not settings.llm_api_key:
        raise SystemExit("No configured model key; replay was not run.")
    cases = json.loads((ROOT / "tests/fixtures/group_participation_eval.json").read_text(encoding="utf-8"))
    fallback = ConversationDecisionEngine._decision(ConversationAction.OBSERVE, DecisionReason.AMBIENT_SPEECH, .8, .1, .5, .1)
    rows = []
    provider = DeepSeekProvider(settings, purpose="adjudication")
    classifier = StructuredConversationAdjudicator(provider, first_timeout=args.timeout)
    for case in cases:
        turns = [{"id": f"turn-{i}", "role": role, "text": text, "kind": "spoken" if role == "iris" else "ambient",
                  "uncertain": False} for i, (role, text) in enumerate(case["history"])]
        context = {"recent_turns": turns, "initiative": case.get("initiative", "rare"), "engagement": "balanced",
                   "strictness": "balanced", "speaker_identity": "unknown; no diarization",
                   "pending_address": {"text": case["pending"], "id": "turn-0"} if case.get("pending") else None,
                   "iris_dialogue_active": bool(turns and turns[-1]["role"] == "iris")}
        started = time.perf_counter()
        result = await classifier.adjudicate(case["text"], fallback_decision=fallback, fallback_appraisal=EventAppraisal(),
                                             cause_message_id="current", speaker_role="unknown", group_context=context,
                                             previous_assistant_text=next((t["text"] for t in reversed(turns) if t["role"] == "iris"), None))
        assessment = result.participation
        kind = assessment.kind if assessment else "fallback"
        floor = ConversationFloor()
        now = time.monotonic()
        for turn in turns:
            floor.remember(turn["text"], turn["id"], now=now, kind=turn["kind"], role=turn["role"])
        if case.get("pending"):
            floor.pending = PendingAddress(case["pending"], "turn-0", "clarification", now + 30, heard=True)
        outcome = resolve_group_participation(
            fallback, assessment, floor=floor, transcript=case["text"], now=now,
            direct=ConversationDecisionEngine().is_explicit_iris_address(case["text"]),
            continuation=False, strictness="balanced", initiative=case.get("initiative", "rare"),
            engagement="balanced", cooldown=False, budget_exceeded=False, uncertain=False,
        )
        valid_ids = {turn["id"] for turn in turns if turn["role"] == "human"}
        grounded = bool(assessment and (kind != "helpful" or
                        assessment.evidence_ids and set(assessment.evidence_ids).issubset(valid_ids)))
        passed = kind in case["expected"] and grounded
        expected_actions = {"ambient": "observe", "helpful": "defer", "addressed": "respond", "clarify": "respond"}
        policy_passed = outcome.decision.action.value in {expected_actions[k] for k in case["expected"]}
        if case.get("resolves_pending"):
            passed = passed and assessment.resolves_pending
        row = {"id": case["id"], "expected": case["expected"], "actual": kind, "passed": passed and policy_passed,
               "action": outcome.decision.action.value, "policy_passed": policy_passed,
               "source": result.source, "duration_ms": round((time.perf_counter() - started) * 1000),
               "assessment": assessment.model_dump() if assessment else None}
        rows.append(row)
        print(f"{case['id']}: {kind} -> {row['action']} ({'pass' if row['passed'] else 'review'})", flush=True)
    report = {"model": settings.deepseek_model, "timeout_seconds": args.timeout,
              "synthetic_only": True, "passed": sum(bool(row["passed"]) for row in rows), "total": len(rows), "rows": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{report['passed']}/{len(rows)}; report: {args.output}")


async def main(args):
    try:
        await evaluate(args)
    finally:
        await close_shared_clients()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "output/group-participation-replay.json")
    parser.add_argument("--timeout", type=float, default=3.5)
    parser.add_argument("--credentials-stdin", action="store_true", help="Read api_key JSON from stdin; never store credentials")
    asyncio.run(main(parser.parse_args()))
