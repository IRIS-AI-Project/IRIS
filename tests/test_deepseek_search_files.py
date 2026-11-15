"""Contracts for DeepSeek search/fetch and ephemeral whole-file chat input."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from apps.backend.app.agents.character.agent import CharacterAgent
from apps.backend.app.core.config import Settings
from apps.backend.app.documents import DocumentError, DocumentService, LIFETIME
from apps.backend.app.environment.search_providers import deepseek_query
from apps.backend.app.environment.search_service import SearchService, SearchResult
from apps.backend.app.llm.base import ChatMessage
from apps.backend.app.llm.deepseek_files import DeepSeekFiles
from apps.backend.app.llm.providers import deepseek
from apps.backend.app.runtime.settings import RuntimeSettings, RuntimeSettingsStore
from tests.test_deepseek_provider import FakeClient, FakeStream, _chunk, _completion
from tests.test_search_recovery import History, ReplayLLM


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_primary_search_uses_deepseek_content_dates_and_no_other_engine():
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url == "https://api.deepseek.com/v1/tools/search"
        assert request.headers["Authorization"] == "Bearer fixture-key"
        body = json.loads(request.content)
        assert body["need_content"] is True
        assert "after:" in body["query"] and len(body["query"]) <= 128
        return httpx.Response(200, json={"results": [{"title": "Python release notes",
            "url": "https://python.org/release", "snippet": "Python release",
            "content": "Python release notes: this version fixes bugs.", "date": "2026-11-14T12:00:00Z"}]})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = SearchService(client, runtime_settings=RuntimeSettings(), credentials={"deepseek": "fixture-key"})
    result = await service.search("Python release notes", since="2026-11-13T00:00:00Z", until="2026-11-15T00:00:00Z")
    assert result.status == "ok" and result.provider == "deepseek"
    assert result.results[0].page_status == "read"
    assert result.results[0].published_at.startswith("2026-11-14")
    assert "fixes bugs" in result.compact_summary()
    assert len(requests) == 1
    assert (await service.search("Python release notes", since="2026-11-13T00:00:00Z", until="2026-11-15T00:00:00Z")).cached
    await service.close()


@pytest.mark.anyio
@pytest.mark.parametrize("code,status", [(401, "unauthorized"), (402, "insufficient_balance"), (429, "blocked"), (504, "error")])
async def test_search_failure_is_reported_without_silent_provider_switch(code, status):
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(code, json={"error": {"message": "no"}})))
    service = SearchService(client, runtime_settings=RuntimeSettings(), credentials={"deepseek": "fixture"})
    result = await service.search("Python documentation")
    assert result.status == status and result.provider == "deepseek"
    assert not result.results and len(result.attempts) == 1
    await service.close()


@pytest.mark.anyio
async def test_fetch_reads_markdown_through_deepseek():
    def handler(request):
        assert request.url.path == "/v1/tools/fetch"
        assert json.loads(request.content) == {"url": "https://example.com/article"}
        return httpx.Response(200, json={"title": "Example", "content": "# Python\n\nPython details"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = SearchService(client, runtime_settings=RuntimeSettings(), credentials={"deepseek": "fixture"})
    result = await service._page(SearchResult("Python", "", "https://example.com/article"), "Python")
    assert result.page_status == "read" and "Python details" in result.page_text
    await service.close()


def test_long_query_keeps_date_and_site_operators():
    query = deepseek_query("Python documentation " * 15 + " site:python.org after:2026-11-01 before:2026-11-15")
    assert len(query) <= 128
    assert query.endswith("site:python.org after:2026-11-01 before:2026-11-15")


@pytest.mark.anyio
@pytest.mark.parametrize("filename,purpose", [("scan.pdf", "rich_layout_recognition"),
    ("slides.pptx", "rich_layout_recognition"), ("image.png", "rich_layout_recognition"),
    ("sheet.xlsx", "user_data"), ("notes.txt", "user_data")])
async def test_files_upload_uses_correct_purpose_expiration_and_deletes(filename, purpose):
    requests = []
    def handler(request):
        requests.append(request)
        if request.method == "POST":
            assert request.url.path == "/files"
            assert request.content.index(b'name="purpose"') < request.content.index(b'name="file"')
            assert purpose.encode() in request.content and str(LIFETIME).encode() in request.content
            return httpx.Response(200, json={"id": "file-api-fixture"})
        assert request.method == "DELETE" and request.url.path == "/files/file-api-fixture"
        return httpx.Response(200, json={"deleted": True})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    remote = DeepSeekFiles(Settings(_env_file=None, deepseek_api_key="fixture"), client)
    service = DocumentService(remote)
    doc = await service.upload("session", "upload", filename, b"PRIVATE ORIGINAL")
    assert service.current_file_id("session") == "file-api-fixture"
    assert service.current_file_id("other") is None
    prompt, meta = service.current_context("session", "Резюме")
    assert meta["whole_file"] and not meta["partial"]
    assert "file-api-fixture" not in json.dumps(meta) + prompt
    assert "PRIVATE ORIGINAL" not in repr(doc) + prompt + json.dumps(meta)
    service.cancel("session", "upload")
    await service.flush_deletes()
    assert len(requests) == 2 and service.current("session") is None
    await service.close()


@pytest.mark.anyio
async def test_cancelled_upload_cleans_remote_file_and_cannot_replace_current():
    started, release = asyncio.Event(), asyncio.Event()
    class Remote:
        deleted = []
        async def upload(self, *args):
            started.set()
            await release.wait()
            return "file-api-cancelled"
        async def delete(self, identifier):
            self.deleted.append(identifier)
    remote = Remote()
    service = DocumentService(remote)
    service.put("s", "original", "original.txt", (), remote_file_id="file-api-original")
    task = asyncio.create_task(service.upload("s", "new", "scan.pdf", b"scan"))
    await started.wait()
    service.cancel("s", "new")
    release.set()
    with pytest.raises(DocumentError, match="отменено"):
        await task
    assert service.current_file_id("s") == "file-api-original"
    assert remote.deleted == ["file-api-cancelled"]


@pytest.mark.anyio
@pytest.mark.parametrize("live", [False, True])
async def test_character_attaches_file_to_each_followup_without_history_leaks(live):
    service = DocumentService()
    service.put("s", "document", "report.pdf", (), remote_file_id="file-api-private")
    reply = "В отчёте указана сумма 350 рублей."
    llm = ReplayLLM([reply if live else json.dumps({"reply": reply, "emotion": "neutral", "intent": "question"})] * 2)
    agent = CharacterAgent(llm, History(), 8, document_service=service)
    for question in ["Какая сумма в документе?", "Уточни сумму в этом файле"]:
        if live:
            text = "".join([chunk async for chunk in agent.stream_user_message("s", question, persist_reply=False)])
        else:
            text = (await agent.handle_user_message("s", question, persist_reply=False))["reply"]
        assert "350" in text
        assert next(m for m in reversed(llm.calls[-1]) if m.role == "user").file_ids == ["file-api-private"]
        assert "file-api-private" not in json.dumps(agent.last_document_context)


def test_provider_sends_file_blocks_on_supported_flash_model(monkeypatch):
    fake = FakeClient([_completion('{"reply":"ok"}')])
    monkeypatch.setattr(deepseek, "_shared_client", lambda *_: fake)
    provider = deepseek.DeepSeekProvider(Settings(_env_file=None, deepseek_api_key="fixture", deepseek_model="deepseek-v4-pro"))
    message = ChatMessage(role="user", content="Прочитай", file_ids=["file-api-private"])
    assert "file-api-private" not in message.model_dump_json()
    asyncio.run(provider.generate([message]))
    call = fake.completions.calls[0]
    assert call["model"] == "deepseek-flash"
    assert call["messages"][0]["content"] == [{"type": "file", "file_id": "file-api-private"}, {"type": "text", "text": "Прочитай"}]


@pytest.mark.anyio
async def test_stream_provider_passes_file_blocks(monkeypatch):
    fake = FakeClient([FakeStream([_chunk("Ответ", finish_reason="stop")])])
    monkeypatch.setattr(deepseek, "_shared_client", lambda *_: fake)
    provider = deepseek.DeepSeekProvider(Settings(_env_file=None, deepseek_api_key="fixture", deepseek_model="deepseek-v4-pro"))
    text = "".join([chunk async for chunk in provider.stream([ChatMessage(role="user", content="Вопрос", file_ids=["file-api-test"])])])
    assert text == "Ответ"
    assert fake.completions.calls[0]["model"] == "deepseek-flash"
    assert fake.completions.calls[0]["messages"][0]["content"][0] == {"type": "file", "file_id": "file-api-test"}


@pytest.mark.anyio
async def test_document_route_upload_current_delete_and_isolation(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from apps.backend.app.api.routes import documents as routes
    async def require_session(request, session_id):
        if session_id != "session":
            raise HTTPException(409, "inactive")
    monkeypatch.setattr(routes, "require_active_session_async", require_session)
    deleted = []
    class Remote:
        async def upload(self, *args):
            return "file-api-route"
        async def delete(self, identifier):
            deleted.append(identifier)
    app = FastAPI()
    app.include_router(routes.router)
    app.state.document_service = DocumentService(Remote())
    app.state.event_bus = SimpleNamespace(publish=lambda *args: None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        result = await client.post("/documents", data={"session_id": "session", "upload_id": "upload-1234567890"}, files={"file": ("report.docx", b"test")})
        assert result.status_code == 200 and result.json()["provider"] == "deepseek"
        assert "file-api-route" not in result.text
        current = await client.get("/documents/current", params={"session_id": "session"})
        assert current.json()["document"]["whole_file"]
        denied = await client.delete("/documents/upload-1234567890", params={"session_id": "other"})
        assert denied.status_code == 409 and not deleted
        removed = await client.delete("/documents/upload-1234567890", params={"session_id": "session"})
        assert removed.status_code == 200 and deleted == ["file-api-route"]


@pytest.mark.anyio
async def test_replacement_expiry_and_failed_deletion_retry():
    from dataclasses import replace
    class Remote:
        deleted = []
        failed_once = False
        async def delete(self, identifier):
            if not self.failed_once:
                self.failed_once = True
                raise httpx.ConnectError("offline")
            self.deleted.append(identifier)
    remote = Remote()
    service = DocumentService(remote)
    service.put("s", "first", "first.txt", (), remote_file_id="file-api-first")
    service.put("s", "second", "second.txt", (), remote_file_id="file-api-second")
    await service.flush_deletes()
    assert not remote.deleted
    await service.flush_deletes()
    assert remote.deleted == ["file-api-first"]
    current = service.get("s", "second")
    service._documents["second"] = replace(current, created=current.created - LIFETIME - 1)
    await service.flush_deletes()
    assert service.current("s") is None and remote.deleted[-1] == "file-api-second"


def test_existing_settings_migrate_once_and_explicit_free_choice_survives(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"schema_version": 1, "settings": {"web_search_provider": "free"}}))
    store = RuntimeSettingsStore(path)
    loaded = store.load(RuntimeSettings())
    assert loaded.web_search_provider == "deepseek" and not loaded.web_search_free_only
    loaded.web_search_provider = "free"
    store.save(loaded)
    assert store.load(RuntimeSettings()).web_search_provider == "free"
