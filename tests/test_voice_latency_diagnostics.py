import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.backend.app.voice.latency import (
    VoiceLatencyJournal, VoiceLatencyTrace, current_voice_trace,
    latency_mark, latency_span, voice_trace_scope,
)
from apps.backend.app.voice.live import UtteranceContext, VoiceSessionManager
from apps.backend.app.voice.providers import MockTTSProvider
from scripts.report_voice_latency import load_events, summarize_events


@pytest.fixture
def anyio_backend():
    return "asyncio"


def make_trace(journal, generation=1, candidate_id=1):
    trace = journal.start_trace(session_id="session", generation=generation,
                                candidate_id=candidate_id, started_at=time.perf_counter() - .35)
    trace.mark("input.endpoint_candidate", endpoint_silence_ms=350, origin="server_vad_estimate")
    return trace


@pytest.mark.anyio
async def test_trace_propagates_to_workers_without_leaking_into_other_tasks():
    journal = VoiceLatencyJournal()
    traces = [make_trace(journal, generation=i) for i in (1, 2)]

    async def turn(trace):
        with voice_trace_scope(trace), latency_span("prepare"):
            await asyncio.to_thread(latency_mark, "worker", text="private", prompt="secret", duration_ms=12)
            assert current_voice_trace() is trace
        assert current_voice_trace() is None

    await asyncio.gather(*(turn(trace) for trace in traces))
    assert current_voice_trace() is None
    for item in journal.snapshot()["traces"]:
        events = item["events"]
        worker = next(e for e in events if e["stage"] == "worker")
        start = next(e for e in events if e["stage"] == "prepare" and e["phase"] == "start")
        assert worker["parent_id"] == start["span_id"]
        assert worker["metrics"] == {"duration_ms": 12}
        assert len({e["trace_id"] for e in events}) == 1
        assert "private" not in json.dumps(item) and "secret" not in json.dumps(item)


@pytest.mark.anyio
async def test_cancelled_span_keeps_its_status_and_does_not_turn_into_success():
    journal = VoiceLatencyJournal()
    trace = make_trace(journal)
    started = asyncio.Event()

    async def wait():
        with voice_trace_scope(trace), latency_span("stt.final"):
            started.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(wait())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    trace.finish("cancelled")
    trace.finish("completed")
    item = journal.snapshot()["traces"][0]
    assert item["status"] == "cancelled"
    end = next(e for e in item["events"] if e["stage"] == "stt.final" and e["phase"] == "end")
    assert end["metrics"]["error_type"] == "CancelledError"


@pytest.mark.anyio
async def test_background_journal_is_bounded_rotates_and_flushes_on_close(tmp_path):
    path = tmp_path / "voice.jsonl"
    journal = VoiceLatencyJournal(path, max_bytes=1400, backups=2, max_traces=2, max_events=4)
    for generation in range(4):
        trace = make_trace(journal, generation=generation)
        for i in range(8):
            trace.mark("measurement", duration_ms=i, text="not stored", error="private")
        trace.finish("completed")
    await journal.close()
    snapshot = journal.snapshot()
    assert len(snapshot["traces"]) == 2
    assert all(len(item["events"]) == 4 and item["truncated_events"] > 0 for item in snapshot["traces"])
    assert snapshot["write_errors"] == snapshot["pending_writes"] == 0
    files = list(tmp_path.glob("voice.jsonl*"))
    assert 1 < len(files) <= 3
    events, invalid = load_events(files)
    assert invalid == 0 and events
    assert all(path.stat().st_size < 1800 for path in files)
    assert "private" not in "".join(path.read_text() for path in files)


@pytest.mark.anyio
async def test_slow_disk_drops_diagnostics_instead_of_blocking_turn(tmp_path, monkeypatch):
    release = threading.Event()
    journal = VoiceLatencyJournal(tmp_path / "voice.jsonl", queue_size=2)
    monkeypatch.setattr(journal, "_write", lambda: release.wait(2))
    try:
        trace = make_trace(journal)
        for _ in range(20):
            trace.mark("work")
        assert journal.dropped_events > 0
        assert len(journal.snapshot()["traces"][0]["events"]) == 21
    finally:
        release.set()
        await journal.close()


@pytest.mark.anyio
async def test_incognito_veto_and_disabled_collector_never_open_a_file(tmp_path):
    journal = VoiceLatencyJournal(tmp_path / "voice.jsonl", persist_allowed=lambda: False)
    make_trace(journal).finish("completed")
    await journal.close()
    assert not list(tmp_path.iterdir())
    assert journal.snapshot()["traces"]
    disabled = VoiceLatencyJournal(tmp_path / "disabled.jsonl", enabled=False)
    assert disabled.start_trace(session_id="s", generation=1, candidate_id=1, started_at=0) is None
    await disabled.close()
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_file_error_is_visible_without_breaking_a_turn(tmp_path):
    parent = tmp_path / "not-a-directory"
    parent.write_text("fixture")
    journal = VoiceLatencyJournal(parent / "voice.jsonl")
    make_trace(journal).finish("completed")
    await journal.close()
    assert journal.snapshot()["write_errors"] >= 1


@pytest.mark.anyio
async def test_unity_start_counts_once_and_muted_renderer_cannot_finish_browser_trace():
    journal = VoiceLatencyJournal()
    trace = make_trace(journal)
    trace.bind("utterance")
    manager = VoiceSessionManager(MockTTSProvider())
    context = UtteranceContext("session", "utterance", latency_trace=trace,
                               tracks_end_of_speech=True, started_at=trace.started_at)
    manager._avatar_playback["utterance"] = context
    manager._latency_contexts["utterance"] = context
    manager.set_playback_owner("session", "utterance", "unity")
    manager.playback_started("session", "utterance")  # Wrong owner.
    await manager.avatar_playback_started("utterance")
    await manager.avatar_playback_started("utterance")
    events = journal.snapshot()["traces"][0]["events"]
    points = [e for e in events if e["stage"] == "playback.started"]
    assert len(points) == 1 and points[0]["metrics"]["playback_owner"] == "unity"
    await manager.avatar_playback_finished("utterance")
    assert journal.snapshot()["traces"][0]["status"] == "completed"

    trace2 = make_trace(journal, generation=2)
    context = UtteranceContext("session", "browser", latency_trace=trace2,
                               tracks_end_of_speech=True, started_at=trace2.started_at)
    manager._avatar_playback["browser"] = context
    manager._latency_contexts["browser"] = context
    manager.set_playback_owner("session", "browser", "desktop_ui")
    await manager.avatar_playback_started("browser")
    await manager.avatar_playback_finished("browser")
    assert not trace2.finished
    manager.playback_started("session", "browser")
    manager.playback_finished("session", "browser")
    assert trace2.finished
    points = [e for e in journal.snapshot()["traces"][-1]["events"] if e["stage"] == "playback.started"]
    assert len(points) == 1 and points[0]["metrics"]["playback_owner"] == "desktop_ui"


@pytest.mark.anyio
async def test_late_playback_after_cancellation_cannot_make_trace_successful():
    journal = VoiceLatencyJournal()
    trace = make_trace(journal)
    manager = VoiceSessionManager(MockTTSProvider())
    context = UtteranceContext("session", "old", latency_trace=trace,
                               tracks_end_of_speech=True, started_at=trace.started_at)
    manager._latency_contexts["old"] = context
    manager._avatar_playback["old"] = context
    await manager.cancel("session")
    await manager.avatar_playback_started("old")
    await manager.avatar_playback_finished("old")
    item = journal.snapshot()["traces"][0]
    assert item["status"] == "cancelled"
    assert not any(e["stage"] == "playback.started" for e in item["events"])


def test_diagnostics_endpoint_contains_no_audio_text_and_validates_limit():
    from apps.backend.app.api.routes.voice import router
    journal = VoiceLatencyJournal()
    make_trace(journal).mark("stt.result", provider="gigaam_onnx", text="private", transcript="private")
    app = FastAPI()
    app.state.voice_latency_journal = journal
    app.include_router(router)
    client = TestClient(app)
    result = client.get("/debug/voice/latency?limit=1")
    assert result.status_code == 200
    assert result.json()["origin"] == "server_vad_estimate"
    assert "private" not in result.text
    assert client.get("/debug/voice/latency?limit=121").status_code == 422


def test_report_keeps_cancelled_missing_and_lookup_answers_separate():
    events = []
    clock = [10.0]
    def emit(trace, stage, at, **fields):
        clock[0] = at
        trace.mark(stage, **fields)
    for number, status in enumerate(("completed", "cancelled", "completed")):
        trace = VoiceLatencyTrace(events.append, session_id="s", generation=number,
                                  candidate_id=number, started_at=10, clock=lambda: clock[0])
        emit(trace, "input.endpoint_candidate", 10.35)
        if number == 2:
            emit(trace, "lookup.acknowledgement", 10.4)
        emit(trace, "playback.started", 10.5 + number, playback_owner="unity")
        trace.finish(status)
    report = summarize_events(events + events)  # Rotations/snapshots may overlap.
    assert report["traces"] == 3
    assert report["statuses"] == {"completed": 2, "cancelled": 1}
    assert report["playback"]["unity/completed/answer"]["p50_ms"] == 500
    assert report["playback"]["unity/cancelled/answer"]["n"] == 1
    assert report["playback"]["unity/completed/lookup_acknowledgement_possible"]["n"] == 1
    assert summarize_events(events, owner="desktop_ui")["traces"] == 0


def test_report_filters_whole_traces_by_start_and_counts_broken_lines(tmp_path):
    events = []
    trace = VoiceLatencyTrace(events.append, session_id="s", generation=1, candidate_id=1,
                              started_at=0, clock=lambda: 1)
    trace.mark("input.endpoint_candidate")
    trace.finish("completed")
    events[0]["timestamp"] = 100
    events[1]["timestamp"] = 200
    assert summarize_events(events, since=150)["traces"] == 0
    assert summarize_events(events, since=100, until=101)["traces"] == 1
    path = tmp_path / "partial.jsonl"
    path.write_text(json.dumps(events[0]) + '\n{"incomplete":' + '\n{}\n', encoding="utf-8")
    loaded, invalid = load_events([path])
    assert loaded == events[:1] and invalid == 2


@pytest.mark.anyio
async def test_lookup_acknowledgement_is_marked_at_the_shared_source(monkeypatch):
    from apps.backend.app.agents.character.agent import CharacterAgent
    from tests.test_live_voice import StreamingProvider
    from tests.test_search_recovery import History

    monkeypatch.setattr("apps.backend.app.agents.character.agent._SEARCH_ACK_DELAY_SECONDS", 0)
    agent = CharacterAgent(StreamingProvider(), History(), 8)
    agent._planned_bridge = "Сейчас посмотрю."
    release = asyncio.Event()
    async def lookup():
        await release.wait()
        return "result"

    journal = VoiceLatencyJournal()
    trace = make_trace(journal)
    with voice_trace_scope(trace):
        stream = agent._wait_for_lookup(lookup(), acknowledge=True)
        try:
            acknowledgement, result = await anext(stream)
            assert acknowledgement and result is None
            release.set()
            assert await anext(stream) == ("", "result")
        finally:
            await stream.aclose()
    assert len([e for e in journal.snapshot()["traces"][0]["events"] if e["stage"] == "lookup.acknowledgement"]) == 1


@pytest.mark.anyio
async def test_native_provider_records_raw_text_before_releasing_buffer(monkeypatch):
    from apps.backend.app.llm.providers import deepseek as module
    from apps.backend.app.llm.providers.deepseek import DeepSeekProvider
    from tests.test_deepseek_provider import FakeClient, _chunk, _messages, _settings

    waiting, release = asyncio.Event(), asyncio.Event()
    class GatedStream:
        def __init__(self):
            self.index = 0
        def __aiter__(self):
            return self
        async def __anext__(self):
            self.index += 1
            if self.index == 1:
                return _chunk("Private answer. ")
            if self.index == 2:
                waiting.set()
                await release.wait()
                return _chunk("The end.")
            raise StopAsyncIteration

    fake = FakeClient([GatedStream()])
    monkeypatch.setattr(module, "_shared_client", lambda *_: fake)
    journal = VoiceLatencyJournal()
    trace = make_trace(journal)
    provider = DeepSeekProvider(_settings())

    async def consume():
        with voice_trace_scope(trace):
            return [part async for part in provider.stream_with_tools(_messages(), tools=[{"type": "function"}])]

    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(waiting.wait(), 1)
        stages = [e["stage"] for e in journal.snapshot()["traces"][0]["events"]]
        assert "llm.first_raw_text" in stages and "llm.first_released_text" not in stages
        assert not task.done()
    finally:
        release.set()
    assert await task == ["Private answer. The end."]  # Existing tool buffering is unchanged.
    records = journal.snapshot()["traces"][0]["events"]
    assert "Private" not in json.dumps(records)
    assert [e["stage"] for e in records].index("llm.first_raw_text") < [e["stage"] for e in records].index("llm.first_released_text")


@pytest.mark.anyio
@pytest.mark.parametrize("owner", ["unity", "desktop_ui"])
async def test_pcm_to_playback_trace_survives_input_and_generation_task_boundaries(tmp_path, monkeypatch, owner):
    from apps.backend.app.agents.character.agent import CharacterAgent
    from apps.backend.app.llm.providers import deepseek as module
    from apps.backend.app.llm.providers.deepseek import DeepSeekProvider
    from apps.backend.app.storage.sqlite_history import SQLiteMessageHistory
    from apps.backend.app.voice.input import VoiceInputSessionManager
    from tests.test_deepseek_provider import FakeClient, FakeStream, _chunk, _settings
    from tests.test_live_voice import FakeVoiceConnection
    from tests.test_voice_pcm_input import ControlledTurnDetector, FakeSocket, SequenceVad

    journal = VoiceLatencyJournal(tmp_path / f"pipeline-{owner}.jsonl")
    fake = FakeClient([FakeStream([_chunk("Готово, я тебя услышала."), _chunk(finish_reason="stop")])])
    monkeypatch.setattr(module, "_shared_client", lambda *_: fake)
    history = SQLiteMessageHistory(tmp_path / "history.db")
    history.init_db()
    agent = CharacterAgent(DeepSeekProvider(_settings()), history, 8)
    output = VoiceSessionManager(MockTTSProvider())
    output._connections["session"] = FakeVoiceConnection()
    generated = []

    class PCMService:
        async def transcribe_pcm16(self, *_args):
            raise AssertionError("The callback owns transcription in this controlled replay")

    async def on_utterance(session_id, audio, language, connection):
        assert current_voice_trace() is connection.latency_trace
        with latency_span("stt.final"):
            latency_mark("stt.result", provider="mock", device="cpu", warm=True)
        with latency_span("conversation.decision"):
            latency_mark("conversation.decision_ready", action="respond")
        generated.append(await output.start(
            session_id=session_id, utterance_id="answer", transcript="private-user-phrase",
            language=language, voice="ru_f1", agent=agent, pipeline_started_at=connection.pipeline_started_at,
        ))

    inputs = VoiceInputSessionManager(
        PCMService(), on_utterance, vad=SequenceVad([.9, .9, 0, 0]),
        turn_detector=ControlledTurnDetector([True]), latency_journal=journal,
    )
    await inputs.register("session", FakeSocket())
    await inputs.start("session", sample_rate=16000, channels=1, language="ru")
    session = inputs._sessions["session"]
    session.gate.start_ms = session.gate.end_ms = 0
    try:
        for _ in range(4):
            await inputs.feed("session", b"\1\0" * 160)
        await inputs._settle_session_tasks(session, cancel=False)
        assert len(generated) == 1
        await asyncio.wait_for(generated[0], 2)
        assert not any(e["type"] == "voice.error" for e in output._connections["session"].events)
        assert "session" not in output._active  # Playback can start after generation is complete.
        output.set_playback_owner("session", "answer", owner)
        if owner == "unity":
            await output.avatar_playback_started("answer")
            await output.avatar_playback_finished("answer")
        else:
            output.playback_timing("session", "answer", {"stage": "decoded", "segment_id": 0, "decode_ms": 5})
            output.playback_started("session", "answer")
            output.playback_finished("session", "answer")
    finally:
        await inputs.close()
        await output.close()
        await journal.close()
    events, invalid = load_events([tmp_path / f"pipeline-{owner}.jsonl"])
    assert invalid == 0
    stages = {e["stage"] for e in events}
    assert {"input.endpoint_candidate", "endpoint.result", "stt.result", "agent.prompt_ready",
            "llm.first_raw_text", "llm.first_released_text", "agent.first_delta", "speech.first_segment",
            "tts.job", "audio.segment_ready", "playback.started", "trace.finished"} <= stages
    assert len({e["trace_id"] for e in events}) == 1
    assert all(e["candidate_id"] == 1 for e in events)
    assert "private-user-phrase" not in json.dumps(events, ensure_ascii=False)
    report = summarize_events(events)
    assert report["statuses"] == {"completed": 1}
    assert report["playback"][f"{owner}/completed/answer"]["n"] == 1
    assert report["incomplete_traces"] == 0
