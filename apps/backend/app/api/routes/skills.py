import asyncio
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool

from apps.backend.app.api.routes.settings import _commit_runtime_settings_patch
from apps.backend.app.runtime.settings import QuickTextAction
from apps.backend.app.skills.text_editor import EditRequest, TextEditor

router = APIRouter(prefix="/skills")


def _editor(request: Request) -> TextEditor:
    return request.app.state.text_editor


@router.get("")
def catalog(request: Request):
    state = request.app.state
    editor = _editor(request)
    return {
        "web_search": bool(state.runtime_settings.web_search_enabled and state.situational_coordinator.search_service),
        "reminders": state.reminder_service is not None,
        "text_editor": {
            "enabled": editor.enabled, "revision": editor.revision,
            "model_available": editor.provider_factory is not None,
            "quick_actions": editor.runtime.text_editor_quick_actions,
        },
    }


class ToggleEditor(BaseModel):
    enabled: StrictBool | None = None
    quick_actions: list[QuickTextAction] | None = Field(default=None, min_length=1, max_length=5)


@router.patch("/text-editor")
async def toggle(payload: ToggleEditor, request: Request):
    editor = _editor(request)
    async with request.app.state.text_editor_settings_lock:
        changes: dict[str, object] = {}
        toggle_changed = payload.enabled is not None and editor.enabled != payload.enabled
        if toggle_changed:
            changes.update(text_editor_enabled=payload.enabled, text_editor_revision=editor.revision + 1)
        if payload.quick_actions is not None:
            changes["text_editor_quick_actions"] = list(dict.fromkeys(payload.quick_actions))
        if changes:
            await asyncio.to_thread(
                _commit_runtime_settings_patch, request.app.state.runtime_settings_store,
                editor.runtime, changes,
            )
        if toggle_changed:
            editor.revoke()
    return catalog(request)["text_editor"]


def _check_revision(editor: TextEditor, revision: int) -> None:
    if not editor.enabled or editor.revision != revision:
        raise HTTPException(409, "Сессия редактора закрыта.")


class Presence(BaseModel):
    revision: int
    has_draft: StrictBool
    pending_source: StrictBool


@router.put("/text-editor/presence/{editor_id}")
async def presence(editor_id: UUID, payload: Presence, request: Request):
    editor = _editor(request)
    _check_revision(editor, payload.revision)
    editor.set_presence(str(editor_id), payload.has_draft, payload.pending_source)
    return {}


@router.delete("/text-editor/presence/{editor_id}")
async def clear_presence(editor_id: UUID, request: Request):
    _editor(request).clear_presence(str(editor_id))
    return {}


@router.post("/text-editor/edit")
async def edit(request: Request):
    # FastAPI's default validation response echoes invalid input values.
    try:
        payload = EditRequest.model_validate(await request.json())
    except ValueError:
        raise HTTPException(422, "Проверьте текст, указание и согласие на отправку.") from None
    if not payload.text.strip() or not payload.instruction.strip():
        raise HTTPException(422, "Укажите текст и желаемые изменения.")
    editor = _editor(request)
    _check_revision(editor, payload.revision)
    if editor.provider_factory is None:
        raise HTTPException(503, "Добавьте API-ключ DeepSeek в настройках Iris.")
    task = asyncio.create_task(editor.edit(payload))
    editor.jobs.add(task)
    disconnect = asyncio.create_task(request.receive())
    try:
        await asyncio.wait({task, disconnect}, return_when=asyncio.FIRST_COMPLETED)
        _check_revision(editor, payload.revision)
        if not task.done() or task.cancelled():
            raise HTTPException(409, "Правка отменена.")
        result = task.result()
        if result is None:
            raise HTTPException(403, "Указание запрещает отправку текста в интернет.")
        if result.status != "ok":
            raise HTTPException(502, "Модель не завершила правку. Попробуйте ещё раз.")
        return JSONResponse({"text": result.value}, headers={"Cache-Control": "no-store"})
    finally:
        disconnect.cancel()
        task.cancel()
        editor.jobs.discard(task)
