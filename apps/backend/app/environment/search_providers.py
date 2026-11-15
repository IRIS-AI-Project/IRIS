"""Optional user-selected search APIs. No credentials enter public metadata."""
from __future__ import annotations

import httpx
import re

from apps.backend.app.environment.retrieval import canonical_url, clean_text, parse_date

API_PROVIDERS = ("deepseek", "brave", "tavily", "serper")


def deepseek_query(query: str) -> str:
    if len(query) <= 128:
        return query
    pattern = r"(?<!\S)(?:-?site|lang|after|before):\S+"
    operators = " ".join(re.findall(pattern, query))
    text = re.sub(pattern, "", query).strip()
    if len(operators) < 100:
        return (text[:128 - len(operators) - bool(operators)].rstrip() + (" " + operators if operators else ""))[:128]
    return query[:128]


async def api_search(client: httpx.AsyncClient, provider: str, key: str, query: str,
                     *, mode: str = "web", since: str = "", until: str = "",
                     base_url: str = "https://api.deepseek.com") -> list[dict]:
    news = mode == "news"
    if provider == "deepseek":
        # Date/site operators are prepared by SearchService. The API accepts
        # at most 128 Unicode characters, including those operators.
        response = await client.post(f"{base_url.rstrip('/').removesuffix('/v1')}/v1/tools/search",
            json={"query": deepseek_query(query), "count": 10, "need_content": True},
            headers={"Authorization": f"Bearer {key}"}, timeout=10.0)
    elif provider == "brave":
        params = {"q": query, "count": 10, "search_lang": "ru", "extra_snippets": "true"}
        if since and until:
            params["freshness"] = f"{since[:10]}to{until[:10]}"
        response = await client.get(f"https://api.search.brave.com/res/v1/{'news' if news else 'web'}/search",
                                    params=params, headers={"X-Subscription-Token": key})
    elif provider == "tavily":
        body = {"query": query, "topic": "news" if news else "general", "search_depth": "basic",
                "max_results": 10, "include_answer": False, "include_raw_content": False,
                "include_published_date": True, "auto_parameters": False}
        if since:
            body["start_date"] = since[:10]
        if until:
            body["end_date"] = until[:10]
        response = await client.post("https://api.tavily.com/search", json=body,
                                     headers={"Authorization": f"Bearer {key}"})
    elif provider == "serper":
        body = {"q": query, "num": 10, "hl": "ru", "gl": "ru"}
        if since and until:
            body["tbs"] = f"cdr:1,cd_min:{since[:10]},cd_max:{until[:10]}"
        response = await client.post(f"https://google.serper.dev/{'news' if news else 'search'}",
                                     json=body, headers={"X-API-KEY": key})
    else:
        raise ValueError("Unsupported search provider")
    response.raise_for_status()
    if len(response.content) > 1_000_000:
        raise ValueError("Search response too large")
    payload = response.json()
    if provider == "deepseek":
        items = payload.get("results", [])
    elif provider == "brave":
        items = payload.get("results", []) if news else payload.get("web", {}).get("results", [])
    elif provider == "tavily":
        items = payload.get("results", [])
    else:
        items = payload.get("news" if news else "organic", [])
    if not isinstance(items, list):
        raise ValueError("Invalid search response")
    results = []
    for item in items[:10]:
        if not isinstance(item, dict):
            continue
        url = canonical_url(str(item.get("url") or item.get("link") or ""))
        title = clean_text(str(item.get("title") or ""), 120)
        date = parse_date(str(item.get("published_date") or item.get("page_age") or item.get("date") or ""))
        if url and title:
            page_text = clean_text(str(item.get("content") or ""), 12000) if provider == "deepseek" else ""
            results.append({"title": title, "url": url,
                            "snippet": clean_text(str(item.get("content") or item.get("description") or item.get("snippet") or ""), 300),
                            "published_at": date.isoformat() if date else "", "provider": provider,
                            **({"page_text": page_text, "page_status": "read" if page_text else "not_read",
                                "rerank_score": item.get("rerank_score") if isinstance(item.get("rerank_score"), (int, float)) and not isinstance(item.get("rerank_score"), bool) and 0 <= item["rerank_score"] <= 3 else None,
                                "content_truncated": len(str(item.get("content") or "")) > 12000} if provider == "deepseek" else {})})
    return results
