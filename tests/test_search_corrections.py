"""Spoken corrections must revise a search without losing its subject."""
import json

import httpx
import pytest

from apps.backend.app.agents.character.agent import CharacterAgent
from apps.backend.app.agents.character.search_intent import (
    contextual_query_revision, explicit_query_revision, plan_search,
)
from apps.backend.app.environment.retrieval import relevance
from apps.backend.app.environment.search_service import SearchService
from apps.backend.app.llm.base import ChatMessage
from apps.backend.app.runtime.settings import RuntimeSettings
from tests.test_search_recovery import Environment, History, ReplayLLM


@pytest.fixture
def anyio_backend():
    return "asyncio"


PREVIOUS = {"query": "гендиректор Nvidia Дженсен Хуанг видео ноябрь 2026", "mode": "news",
    "since": "2026-10-15", "status": "empty", "canonical_entity": "", "sources": []}
CORRECTION = "да не ты просто поищи че с ним это не видос нихуя"


@pytest.mark.parametrize("text", [CORRECTION, "просто поищи, что с ним", "поищи просто его биографию"])
def test_contextual_request_is_not_a_literal_query_override(text):
    assert explicit_query_revision(text, PREVIOUS["query"]) is None


@pytest.mark.parametrize("text,expected", [
    ("просто поищи Яндекс дата-центры", "яндекс дата-центры"),
    ("запрос: что с ним", "что с ним"),
    ('поищи просто "что с ним"', "что с ним"),
])
def test_deliberately_literal_replacement_is_still_honored(text, expected):
    request = explicit_query_revision(text, PREVIOUS["query"])
    assert request and request.query == expected


def test_rejected_media_format_is_removed_but_person_company_and_period_survive():
    request = contextual_query_revision(CORRECTION, PREVIOUS)
    assert request and request.force_refresh and request.reason == "context_revision"
    assert "Nvidia Дженсен Хуанг" in request.query and "видео" not in request.query
    assert request.mode == "news" and request.since == "2026-10-15"
    assert plan_search(CORRECTION) is None


@pytest.mark.parametrize("previous,text,expected", [
    ({"query": "Microsoft Satya Nadella viral video news", "mode": "news"}, "нет, это не про ролик, поищи что с ним", "Microsoft Satya Nadella news"),
    ({"query": "Python 3.12 цена лицензии"}, "не про цену, поищи условия", "Python 3.12 лицензии"),
    ({"query": "Marie Curie biography awards"}, "мне не биографию, поищи награды", "Marie Curie awards"),
])
def test_constraint_removal_is_not_specific_to_one_person(previous, text, expected):
    request = contextual_query_revision(text, previous)
    assert request and request.query == expected


@pytest.mark.parametrize("text", ["не Nvidia, а AMD", "не ищи видео", "поищи новости Apple", 'запрос: это не видео', 'я не видео смотрел, а читал книгу', 'не видео, а свежие новости Microsoft', 'не ролик, а новости эппл'])
def test_new_subject_prohibition_literal_query_or_unrelated_comment_is_not_rewritten(text):
    assert contextual_query_revision(text, PREVIOUS) is None


def test_semantic_quality_can_bridge_scripts_but_cannot_remove_product_or_version():
    query = "Nvidia CEO Jensen Huang viral video November 2026"
    russian = "Nvidia Дженсен Хуанг: заявление компании о руководстве"
    assert relevance(query, russian) == 0
    assert relevance(query, russian, semantic_score=2.5) > 0
    assert relevance(query, russian, semantic_score=1.0) == 0
    assert relevance(query, "Microsoft Дженсен Хуанг", semantic_score=3) == 0
    assert relevance("Python 3.12 release", "Python 3.13 release", semantic_score=3) == 0
    assert relevance("гендиректор скандал видео", "любой случайный директор", semantic_score=3) == 0


@pytest.mark.anyio
@pytest.mark.parametrize("live", [False, True])
async def test_observed_correction_reaches_deepseek_with_subject_in_text_and_stream(live):
    requests = []
    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        assert "Nvidia Дженсен Хуанг" in body["query"]
        assert not any(word in body["query"].lower() for word in ("видео", "видос", "нихуя", "с ним"))
        return httpx.Response(200, json={"results": [{"title": "Nvidia: Дженсен Хуанг, заявление компании",
            "url": "https://nvidia.com/news/leadership", "date": "2026-11-14T10:00:00Z",
            "content": "Nvidia опубликовала заявление о руководстве компании. Упомянут Дженсен Хуанг.", "rerank_score": 2.8}]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = SearchService(client, runtime_settings=RuntimeSettings(), credentials={"deepseek": "fixture"})
    class SearchHistory(History):
        def get_recent_retrieval_state(self, session_id):
            return {"web_search": PREVIOUS}
    assessment = json.dumps({"enough": True, "source_ids": ["S1"], "canonical_entity": "Дженсен Хуанг", "query": ""})
    reply = "Нашла заявление компании Nvidia о руководстве."
    llm = ReplayLLM([assessment, reply if live else json.dumps({"reply": reply, "emotion": "neutral", "intent": "question"})])
    llm.supports_native_tools = True
    history = SearchHistory([ChatMessage(role="user", content="Я имел в виду гендиректора Nvidia, которые делают видеокарты")])
    agent = CharacterAgent(llm, history, 12, situational_coordinator=Environment(service))
    try:
        if live:
            visible = "".join([piece async for piece in agent.stream_user_message("s", CORRECTION, persist_reply=False)])
        else:
            visible = (await agent.handle_user_message("s", CORRECTION, persist_reply=False))["reply"]
        assert "Nvidia" in visible and len(requests) == 1
        assert agent.last_web_search_metadata["reason"] == "context_revision"
        assert agent.last_web_search_metadata["evidence_status"] == "sufficient"
    finally:
        await service.close()


@pytest.mark.anyio
async def test_semantically_ranked_russian_article_survives_english_search_request():
    def handler(request):
        return httpx.Response(200, json={"results": [
            {"title": "Nvidia: Дженсен Хуанг, заявление компании", "url": "https://nvidia.com/news/leadership",
             "content": "Nvidia Дженсен Хуанг заявление", "rerank_score": 2.7},
            {"title": "Другой директор Microsoft", "url": "https://microsoft.com/news/leadership",
             "content": "Microsoft CEO news", "rerank_score": 3.0},
        ]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = SearchService(client, runtime_settings=RuntimeSettings(), credentials={"deepseek": "fixture"})
    try:
        result = await service.search("Nvidia CEO Jensen Huang news")
        assert result.status == "ok" and len(result.results) == 1
        assert result.results[0].url == "https://nvidia.com/news/leadership"
    finally:
        await service.close()
