"""DeepSeek Files API. Originals and remote identifiers stay out of history."""
from __future__ import annotations

import httpx

from apps.backend.app.documents import DocumentError, LIFETIME
from apps.backend.app.llm.providers.deepseek import _trusted_ssl_context


class DeepSeekFiles:
    def __init__(self, settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        self._client = client

    def _http(self):
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(verify=_trusted_ssl_context(), timeout=660, follow_redirects=False)
        return self._client

    def _url(self, suffix=""):
        return self._settings.deepseek_base_url.rstrip('/').removesuffix('/v1') + '/files' + suffix

    def _headers(self):
        key = self._settings.llm_api_key
        if not key:
            raise DocumentError("Для обработки файлов настройте API-ключ DeepSeek.")
        return {"Authorization": f"Bearer {key}"}

    async def upload(self, name: str, data: bytes, purpose: str) -> str:
        try:
            response = await self._http().post(self._url(), headers=self._headers(),
                data={"purpose": purpose, "expires_after[anchor]": "created_at",
                      "expires_after[seconds]": str(LIFETIME)},
                files={"file": (name, data, "application/octet-stream")})
            response.raise_for_status()
            identifier = response.json().get("id")
            if not isinstance(identifier, str) or not identifier.startswith("file-"):
                raise DocumentError("DeepSeek не вернул идентификатор обработанного файла.")
            return identifier
        except httpx.HTTPStatusError as exc:
            message = {400: "DeepSeek не смог прочитать файл. Проверьте формат и защиту паролем.",
                401: "Проверьте API-ключ DeepSeek.", 402: "Недостаточно средств на счёте DeepSeek.",
                413: "Файл слишком большой для DeepSeek.", 429: "DeepSeek занят обработкой файлов. Повторите позже.",
                504: "DeepSeek не успел разобрать файл. Выберите меньшую часть."}.get(
                    exc.response.status_code, "Не удалось обработать файл в DeepSeek. Повторите позже.")
            raise DocumentError(message) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise DocumentError("Не удалось получить обработанный файл от DeepSeek. Повторите загрузку.") from exc

    async def delete(self, identifier: str):
        response = await self._http().delete(self._url('/' + identifier), headers=self._headers(), timeout=5)
        if response.status_code != 404:
            response.raise_for_status()

    async def close(self):
        if self._client is not None:
            await self._client.aclose()
