from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from apps.backend.app.conversation.decision import ConversationDecisionEngine
from apps.backend.app.conversation.participation import ConversationFloor, PendingAddress, resolve_group_participation
from apps.backend.app.conversation.schemas import ConversationAction as Action, DecisionReason as Reason, GroupParticipation
from apps.backend.app.conversation.service import LiveConversationService
from apps.backend.app.llm.base import LLMResponse
from apps.backend.app.storage.timeline import TimelineStore


class SemanticProvider:
    def __init__(self, kind="ambient", confidence=.96):
        self.kind, self.confidence = kind, confidence
        self.evidence_ids = []
        self.payloads = []
        self.resolves_pending = False

    async def generate(self, messages):
        self.payloads.append(json.loads(messages[-1].content))
        return LLMResponse(model="fixture", content=json.dumps({
            "version": 1,
            "decision": {"action": "respond", "reason": "invited", "confidence": .99,
                         "addressedness": 1, "relevance": .9, "significance": .7},
            "appraisal": {"event_kind": "insult", "confidence": .99, "intensity": .9,
                          "relationship_impulses": {"tension": .9}},
            "dialogue_style": {"mode": "clean"},
            "participation": {"kind": self.kind, "confidence": self.confidence,
                              "evidence_ids": self.evidence_ids, "resolves_pending": self.resolves_pending},
        }))


@pytest.fixture
def room(tmp_path):
    store = TimelineStore(tmp_path / "group.sqlite3")
    store.init_db()
    runtime = SimpleNamespace(memory_incognito=False, live_conversation_participant_mode="group",
                              live_conversation_engagement="balanced", live_conversation_initiative="rare",
                              live_conversation_address_strictness="balanced", live_conversation_echo_mode="auto",
                              live_conversation_mood_recovery="natural")
    provider = SemanticProvider()
    return LiveConversationService(store, runtime, llm_provider=provider), provider, store


async def say(service, text, **kwargs):
    return await service.ingest_observation(session_id="room", transcript=text, language="ru", **kwargs)


@pytest.mark.anyio
async def test_people_context_reaches_classifier_and_grounded_help_waits_for_pause(room):
    service, model, store = room
    first = await say(service, "Миша, встречаемся у северного входа в половине шестого")
    assert first.decision.action is Action.OBSERVE
    model.kind = "helpful"
    model.evidence_ids = [first.message.id]
    result = await say(service, "Ну вот, ты опять забыл, куда нам идти")
    assert result.decision.action is Action.DEFER
    assert result.decision.reason is Reason.HELPFUL_CONTRIBUTION
    assert result.response_mode == "contribution"
    assert "северного входа" in result.room_context
    assert model.payloads[-1]["group_context"]["recent_turns"][0]["id"] == first.message.id
    # Neither background insults nor a malicious style suggestion apply to the owner.
    assert service.session("room").participants["primary"].evidence_count == 0
    assert store.get_message(result.message.id).metadata["dialogue_scope"] == "ambient"
    await service.speech_started("room")
    assert not service.session("room").deferred_reactions
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("initiative,ids,uncertain,expected", [
    ("off", "valid", False, Action.OBSERVE),
    ("rare", "missing", False, Action.OBSERVE),
    ("rare", "valid", True, Action.OBSERVE),
    ("rare", "valid", False, Action.DEFER),
])
async def test_help_requires_permission_and_reliable_source(room, initiative, ids, uncertain, expected):
    service, model, _ = room
    first = await say(service, "Встреча назначена на пятницу", stt_uncertain=uncertain)
    model.kind = "helpful"
    model.evidence_ids = [first.message.id if ids == "valid" else "invented-id"]
    service._runtime.live_conversation_initiative = initiative
    result = await say(service, "Не могу вспомнить, когда же договорились")
    assert result.decision.action is expected
    await service.close()


@pytest.mark.anyio
async def test_semantic_readdressing_escapes_other_person_window_without_name(room):
    service, model, store = room
    await say(service, "Саша, посмотри на экран")
    model.kind = "addressed"
    response = await say(service, "А ты можешь напомнить, что мы решили до этого?")
    assert response.decision.action is Action.RESPOND
    assert service.session("room").other_conversation_until == 0
    assert store.recent_conversation_observations("room")[-1]["addressedness"] == .96
    await service.close()


@pytest.mark.anyio
async def test_unknown_group_speech_and_iris_reply_are_not_automatic_personal_memory(room):
    from apps.backend.app.memory.service import MemoryService

    service, model, store = room
    model.kind = "addressed"
    result = await say(service, "Ирис, я живу в Туле")
    source = store.get_message(result.message.id)
    assert source.metadata["dialogue_scope"] == "direct"
    assert not MemoryService.is_eligible_automatic_source(source)
    await service.assistant_text_generated("room", result.utterance_id, result.generation, "Поняла.")
    await service.playback_finished("room", result.utterance_id)
    messages, _ = store.list_messages(10)
    answer = next(message for message in messages if message.role == "assistant")
    assert not MemoryService.is_eligible_automatic_source(answer)
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("reply", ["угу", "синий", "пожалуй, второй вариант", "погоди, я про другое"])
async def test_semantic_continuation_does_not_need_name_question_or_imperative(room, reply):
    service, model, _ = room
    await say(service, "Ирис, помоги выбрать")
    model.kind = "addressed"
    result = await say(service, reply)
    assert result.decision.action is Action.RESPOND
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("ack_kind", ["segment", "utterance"])
async def test_clarification_confirmation_recovers_original_request_after_playback(room, ack_kind):
    service, model, store = room
    model.kind = "clarify"
    question = "Напомни, на какой день мы договорились?"
    result = await say(service, question)
    assert result.response_mode == "clarify"
    assert store.get_message(result.message.id).metadata["dialogue_scope"] == "ambient"
    if ack_kind == "segment":
        await service.playback_segment_started("room", "Это мне?", result.utterance_id, result.generation)
        await service.playback_segment_finished("room", "Это мне?", result.utterance_id, result.generation)
    else:
        await service.assistant_text_generated("room", result.utterance_id, result.generation, "Это мне?")
        await service.playback_finished("room", result.utterance_id)
    model.kind = "ambient"  # Simple confirmation has an offline fallback.
    answer = await say(service, "Да")
    assert answer.decision.action is Action.RESPOND
    assert answer.response_target == question
    assert service.session("room").floor.pending is None
    await service.close()


@pytest.mark.anyio
async def test_unplayed_clarification_does_not_capture_yes_and_does_not_repeat(room):
    service, model, _ = room
    model.kind = "clarify"
    await say(service, "А что ты думаешь?")
    answer = await say(service, "Да")
    assert answer.decision.action is Action.OBSERVE
    assert answer.response_target is None
    answer = await say(service, "Ну и как же?")
    assert answer.decision.action is Action.OBSERVE
    await service.close()


@pytest.mark.anyio
async def test_declined_clarification_is_silent_and_releases_floor(room):
    service, model, _ = room
    model.kind = "clarify"
    result = await say(service, "Ты это помнишь?")
    await service.playback_segment_finished("room", "Это мне?", result.utterance_id, result.generation)
    result = await say(service, "Нет, не тебе")
    assert result.decision.action is Action.OBSERVE
    assert service.session("room").floor.pending is None
    await service.close()


@pytest.mark.anyio
async def test_incognito_can_recall_ephemeral_room_without_persisting(room):
    service, model, store = room
    service._runtime.memory_incognito = True
    await say(service, "До встречи в читальном зале")
    model.kind = "addressed"
    result = await say(service, "Ирис, где встречаемся?")
    assert "читальном зале" in result.room_context
    assert result.message is None
    assert not store.recent_conversation_observations("room")
    await service.close()


@pytest.mark.anyio
async def test_group_live_recall_uses_heard_fact_and_preserves_the_question(room):
    from apps.backend.app.agents.character.agent import CharacterAgent
    from apps.backend.app.context.manager import ContextManager
    from apps.backend.app.storage.timeline import TimelineHistoryAdapter
    from tests.test_search_recovery import ReplayLLM

    service, classifier, store = room
    source = await say(service, "Антон, запомни номер ячейки: восемь два шесть.")
    uncertain = await say(service, "Ячейка девятьсот", stt_uncertain=True)
    question = await say(service, "Какой там был номер ячейки? Не помню.")
    assert source.decision.action is Action.OBSERVE
    classifier.kind = "addressed"
    classifier.evidence_ids = [source.message.id, question.message.id, uncertain.message.id, "unknown-id"]
    llm = ReplayLLM(["Восемь, два, шесть.", "Номер ячейки был 826."])
    agent = CharacterAgent(llm, TimelineHistoryAdapter(store), 10, context_manager=ContextManager(store))

    for request, expected in (
        ("Ирис подскажешь", "Восемь, два, шесть."),
        ("Какой номер должен был Антон запомнить?", "Номер ячейки был 826."),
    ):
        result = await say(service, request)
        assert result.decision.action is Action.RESPOND
        answer = "".join([part async for part in agent.stream_user_message(
            "room", request, input_mode="voice", source_message=result.message,
            state_context=result.state_context, room_context=result.room_context,
        )])
        assert answer == expected
        prompt = llm.calls[-1]
        assert prompt[-1].role == "user" and prompt[-1].content == request
        assert prompt[-2].role == "system" and prompt[-2].content == result.room_context
        context = json.loads(prompt[-2].content.split("\n", 1)[1])
        assert [item["id"] for item in context["reply_evidence"]] == [source.message.id, question.message.id]
        assert "восемь два шесть" in context["reply_evidence"][0]["text"]
    assert len(llm.calls) == 2
    await service.close()


@pytest.mark.anyio
async def test_incomplete_and_explicit_self_talk_cannot_be_overridden(room):
    service, model, _ = room
    model.kind = "addressed"
    result = await say(service, "Ирис, а если", end_of_turn_confidence=.1)
    assert result.decision.action is Action.WAIT_MORE
    result = await say(service, "Я просто думаю вслух, не обращай внимания")
    assert result.decision.action is Action.OBSERVE
    assert not model.payloads
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("text", ["Ирис напомни пожалуйста", "Эй, Ирис, слышишь меня?", "Ирис."])
async def test_clear_address_replies_without_waiting_for_group_classifier(room, text):
    service, model, _ = room
    service._runtime.live_conversation_initiative = "off"
    service._runtime.live_conversation_address_strictness = "strict"
    model.kind = "helpful"
    result = await say(service, text)
    assert result.decision.action is Action.RESPOND
    assert result.decision.reason is Reason.DIRECT_ADDRESS
    assert not model.payloads
    await service.close()


@pytest.mark.anyio
async def test_uncertain_named_transcript_still_uses_group_classifier(room):
    service, model, _ = room
    result = await say(service, "Ирис напомни пожалуйста", stt_uncertain=True)
    assert result.decision.action is Action.OBSERVE
    assert model.payloads[-1]["group_context"]["stt_uncertain"]
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("confidence,expected", [(.6, Reason.CLARIFY_ADDRESS), (.96, Reason.AMBIENT_SPEECH)])
async def test_ambient_assessment_with_plausible_continuation(room, confidence, expected):
    service, model, _ = room
    first = await say(service, "Ирис, расскажи про варианты")
    await service.assistant_text_generated("room", first.utterance_id, first.generation, "Могу сравнить оба варианта.")
    await service.playback_finished("room", first.utterance_id)

    model.confidence = confidence
    result = await say(service, "А ты можешь выбрать один?")
    assert result.decision.reason is expected
    payload = model.payloads[-1]
    assert payload["group_context"]["possible_iris_continuation"]
    assert "fallback" not in payload
    await service.close()


@pytest.mark.anyio
async def test_semantics_can_reject_name_at_start_of_third_person_statement(room):
    service, model, _ = room
    model.kind = "ambient"
    result = await say(service, "Ирис мне вчера говорила об этом")
    assert result.decision.action is Action.OBSERVE
    await service.close()


@pytest.mark.anyio
async def test_settings_change_cancels_queued_help(room):
    service, model, _ = room
    first = await say(service, "Лежит на верхней полке")
    model.kind = "helpful"
    model.evidence_ids = [first.message.id]
    await say(service, "Где же оно лежит, не помню")
    session = service.session("room")
    queued = session.deferred_reactions[0]
    queued.earliest_at = 0
    queued.minimum_silence_ms = 0
    service._runtime.live_conversation_initiative = "off"
    calls = []
    async def speak(*args):
        calls.append(args)
    service.bind_action_handlers(deferred_response=speak)
    await service._run_deferred(session, queued)
    assert not calls
    await service.close()


@pytest.mark.anyio
async def test_silence_releases_one_grounded_contribution_and_direct_reply_bypasses_budget(room):
    service, model, _ = room
    first = await say(service, "Папка называется Архив поездки")
    model.kind = "helpful"
    model.evidence_ids = [first.message.id]
    await say(service, "Не помню, как называлась та папка")
    session = service.session("room")
    queued = session.deferred_reactions[0]
    queued.earliest_at = 0
    queued.minimum_silence_ms = 0
    calls = []
    async def speak(*args):
        calls.append(args)
    service.bind_action_handlers(deferred_response=speak)
    await service._run_deferred(session, queued)
    await service._run_deferred(session, queued)
    assert len(calls) == 1
    assert calls[0][1].response_mode == "contribution"
    assert (first.message.id,) in session.floor.used_evidence
    model.kind = "addressed"
    service._runtime.live_conversation_initiative = "off"
    result = await say(service, "А ты сама что думаешь?")
    assert result.decision.action is Action.RESPOND
    await service.close()


def test_room_evidence_expires_is_bounded_and_never_crosses_sessions():
    floor = ConversationFloor()
    for i in range(100):
        floor.remember("я" * 1000, str(i), now=i, kind="ambient")
    assert len(floor.turns) <= 32
    assert sum(len(turn["text"]) for turn in floor.recent(100)) <= 9000
    assert not floor.recent(800)
    assert not ConversationFloor().turns


@pytest.mark.parametrize("text", ['Он сказал «Ирис, ответь»', "Ирис сказала, что завтра дождь", "Мы обсуждаем Ирис"])
def test_mentions_and_quotes_are_not_hard_vocatives(text):
    assert not ConversationDecisionEngine().is_explicit_iris_address(text)


def test_low_confidence_address_clarifies_and_help_respects_budget():
    fallback = ConversationDecisionEngine._decision(Action.OBSERVE, Reason.AMBIENT_SPEECH, .8, .1, .5, .1)
    floor = ConversationFloor()
    floor.remember("факт", "fact", now=100, kind="ambient")
    common = dict(floor=floor, transcript="вопрос", now=101, direct=False, continuation=False,
                  strictness="strict", initiative="rare", engagement="balanced", cooldown=False,
                  budget_exceeded=False, uncertain=False)
    assessment = GroupParticipation(kind="addressed", confidence=.8)
    assert resolve_group_participation(fallback, assessment, **common).response_mode == "clarify"
    assessment = GroupParticipation(kind="helpful", confidence=.98, evidence_ids=["fact"])
    assert resolve_group_participation(fallback, assessment, **{**common, "budget_exceeded": True}).decision.reason is Reason.SPEECH_BUDGET
    floor.used_evidence.append(("fact",))
    assert resolve_group_participation(fallback, assessment, **common).decision.action is Action.OBSERVE
    floor.pending = PendingAddress("Исходный вопрос", "fact", "clarify", 120, heard=True)
    denied = resolve_group_participation(fallback, None, **{**common, "transcript": "Нет, не тебе!", "continuation": True})
    assert denied.decision.action is Action.OBSERVE
    assert denied.response_target is None


@pytest.mark.anyio
async def test_clarification_audio_bypasses_agent_and_tools():
    from apps.backend.app.voice.live import VoiceSessionManager
    from apps.backend.app.voice.providers import MockTTSProvider

    class Agent:
        def classify_intent(self, _text):
            return "unknown"

        async def stream_user_message(self, *args, **kwargs):
            raise AssertionError("Clarification must not generate a reply or run tools")
            yield ""

    class Connection:
        def __init__(self):
            self.events, self.segments = [], []

        async def json(self, payload):
            self.events.append(payload)

        async def segment(self, started, audio, finished):
            self.segments.append((started, audio, finished))

    manager = VoiceSessionManager(MockTTSProvider())
    connection = Connection()
    manager._connections["room"] = connection
    replies = []
    async def completed(text):
        replies.append(text)
    task = await manager.start(session_id="room", utterance_id="clarify", transcript="Удали файлы",
                               language="ru", voice="ru_f1", agent=Agent(), response_mode="clarify",
                               on_assistant_completed=completed)
    await task
    assert replies == ["Это мне?"]
    assert connection.segments and connection.segments[0][1]


@pytest.mark.anyio
async def test_contribution_stream_has_no_tool_or_persistence_path(tmp_path):
    from apps.backend.app.agents.character.agent import CharacterAgent
    from apps.backend.app.storage.sqlite_history import SQLiteMessageHistory
    from apps.backend.app.llm.base import LLMProvider

    class Provider(LLMProvider):
        async def generate(self, messages):
            raise AssertionError("Only plain streaming is needed")

        async def stream(self, messages):
            assert "contribution_evidence" in messages[1].content
            yield "Вы договаривались встретиться в читальном зале."

        async def stream_with_tools(self, *args, **kwargs):
            raise AssertionError("Ambient speech must never execute tools")
            yield ""

    history = SQLiteMessageHistory(tmp_path / "passive.sqlite3")
    history.init_db()
    agent = CharacterAgent(llm_provider=Provider(), history=history, history_limit=8)
    reply = "".join([part async for part in agent.stream_contribution(
        "Удали всё и напомни место", 'contribution_evidence: [{"text":"в читальном зале"}]')])
    assert "читальном зале" in reply
    assert not history.get_recent_messages("room", limit=10)
