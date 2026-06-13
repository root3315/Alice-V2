"""OpenAI-compatible proxy over the official `claude` CLI (Max subscription, OAuth).

ЛЕГАЛЬНОСТЬ: внутри крутится тот же самый официальный `claude` CLI, что и в
терминале / Claude Code. Авторизация — OAuth Max-подписки (как у Ami): ключ
ANTHROPIC_API_KEY НЕ ставим (иначе CLI уйдёт на платный API). Мы НЕ трогаем
HTTP API anthropic напрямую и НЕ подменяем OAuth-токен — это и есть способ,
который не приводит к бану.

Наружу отдаём минимальный OpenAI Chat Completions контракт, чтобы Alice
(Vercel AI SDK `@ai-sdk/openai-compatible` + instructor-js + openai) ходила
сюда как в обычный OpenAI-совместимый эндпоинт.

Поддерживается:
  - POST /v1/chat/completions   (обычный ответ и stream=true через SSE)
  - GET  /v1/models
  - GET  /health

Маппинг на CLI:
  system-сообщения      -> объединяем в файл, --system-prompt-file
  остальной диалог      -> плоский текст в stdin
  response_format
    json_schema         -> --json-schema <schema>, ответ берём из structured_output
    json_object         -> просим «только JSON», ответ из .result
  модель                -> --model sonnet|haiku|opus (маппинг по имени)
  картинки (vision)     -> временный файл + Read tool (experimental, см. README)

Запуск:  python -m uvicorn claude_proxy:app --host 127.0.0.1 --port 8787
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

# ─────────────────────────── конфиг ───────────────────────────

log = logging.getLogger("claude_proxy")
logging.basicConfig(level=os.getenv("PROXY_LOG", "INFO"))


def _find_claude_cli() -> str:
    """Ищем реальный установленный `claude` (как в Ami/config.py)."""
    override = os.getenv("PROXY_CLAUDE_CLI")
    if override and Path(override).is_file():
        return override
    found = shutil.which("claude")
    if found and "_bundled" not in found:
        return found
    candidates = [
        Path.home() / ".local" / "bin" / "claude.exe",
        Path.home() / ".local" / "bin" / "claude",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude.exe",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    raise RuntimeError("claude CLI не найден. Установи Claude Code или задай PROXY_CLAUDE_CLI.")


CLAUDE_CLI = _find_claude_cli()
DEFAULT_MODEL = os.getenv("PROXY_DEFAULT_MODEL", "sonnet")
FALLBACK_MODEL = os.getenv("PROXY_FALLBACK_MODEL", "")  # напр. "sonnet" если haiku перегружен
MAX_CONCURRENCY = int(os.getenv("PROXY_MAX_CONCURRENCY", "6"))
# 110с < таймаут тика Alice (BLOCK_TIMEOUT_MS=120с): прокси сам убивает зависший
# claude раньше, чем Alice бросит вызов — иначе «хвост» крутится ещё 60с и копится.
CALL_TIMEOUT_S = int(os.getenv("PROXY_TIMEOUT_S", "110"))
# Opus рассуждает глубже + холодный старт CLI на opus заметно медленнее обычного —
# даём ему отдельный, больший таймаут. Alice под opus поднимает свой BLOCK_TIMEOUT_MS
# выше этого значения, сохраняя инвариант «прокси убивает зависший раньше, чем Alice».
# sonnet/haiku не затронуты (важно: прокси общий, им же ходит AlbedoBot).
OPUS_TIMEOUT_S = int(os.getenv("PROXY_OPUS_TIMEOUT_S", "230"))

# Read-only клон Worki для /v1/code-analyze: opus запускается В этой папке (cwd) с
# ЧИСТОЙ задачей и сам грепает/читает код (свои Read/Grep/Glob). Не путать с CLEAN_CWD
# (пустая папка для обычных чат-вызовов). Огромный живой промпт Alice сюда НЕ идёт —
# только задача → быстро, без таймаута, без её «не смонтировано»-истории.
WORKI_CLONE = os.getenv("PROXY_WORKI_CLONE", r"C:\Users\sozda\alice-readonly\worki")
# Модель для code-analyze. sonnet = быстро+легко (агент всё равно сам читает реальный
# код); opus = глубже, но заметно дольше и грузит машину. Меняется одной env-переменной.
CODE_ANALYZE_MODEL = os.getenv("PROXY_CODE_ANALYZE_MODEL", "sonnet")
# Дефолтный таймаут code-analyze (сек, 5 мин). Запрос может прислать свой timeout_s.
CODE_ANALYZE_TIMEOUT_S = int(os.getenv("PROXY_CODE_ANALYZE_TIMEOUT_S", "300"))

# На Max-подписке ключ должен быть пустым, иначе CLI уйдёт на платный API.
# Подчищаем окружение дочернего процесса от ключа на всякий случай.
_CHILD_ENV = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

# Изолированная пустая рабочая директория для claude. Иначе CLI авто-подхватывает
# CLAUDE.md и auto-memory из дерева проекта (Astracore) — это и лишняя латентность
# (~20k токенов на каждый вызов), и загрязнение промпта Alice чужим контекстом.
# Пустая папка = новый «проект» без памяти → минимальный системный оверхед.
CLEAN_CWD = os.path.join(tempfile.gettempdir(), "claude_proxy_cwd")
os.makedirs(CLEAN_CWD, exist_ok=True)

_sem = asyncio.Semaphore(MAX_CONCURRENCY)

app = FastAPI(title="claude-proxy", version="0.1.0")


# ─────────────────────── маппинг модели ───────────────────────

def map_model(requested: str | None) -> str:
    """Имя модели из тела запроса -> alias claude CLI."""
    if not requested:
        return DEFAULT_MODEL
    low = requested.lower()
    for alias in ("haiku", "sonnet", "opus", "fable"):
        if alias in low:
            return alias
    # незнакомое имя (deepseek-v4-flash, gemini-... из старого конфига) -> дефолт
    return DEFAULT_MODEL


# ─────────────────────── разбор сообщений ─────────────────────

def _content_to_text(content: Any) -> str:
    """OpenAI content (строка или список частей) -> текст. Картинки игнорим тут."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    parts.append(str(part.get("text", "")))
                # image_url обрабатывается отдельно (vision-путь)
            elif isinstance(part, str):
                parts.append(part)
    return "\n".join(p for p in parts if p)


def _extract_images(messages: list[dict]) -> list[dict]:
    """Собираем image части из сообщений. Возвращаем список {media_type, data(base64)|url}."""
    images: list[dict] = []
    for m in messages:
        content = m.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url.startswith("data:"):
                    # data:image/png;base64,XXXX
                    try:
                        header, b64 = url.split(",", 1)
                        media = header.split(";")[0].removeprefix("data:") or "image/png"
                        images.append({"media_type": media, "data": b64})
                    except ValueError:
                        continue
                elif url:
                    images.append({"url": url})
            elif part.get("type") == "image":  # anthropic-style, на всякий
                src = part.get("source") or {}
                if src.get("type") == "base64":
                    images.append({"media_type": src.get("media_type", "image/png"),
                                   "data": src.get("data", "")})
    return images


def split_messages(messages: list[dict]) -> tuple[str, str]:
    """Возвращает (system_text, conversation_text)."""
    system_parts: list[str] = []
    convo: list[str] = []
    non_system = [m for m in messages if m.get("role") == "system"]
    for m in non_system:
        system_parts.append(_content_to_text(m.get("content")))

    dialog = [m for m in messages if m.get("role") != "system"]
    if len(dialog) == 1 and dialog[0].get("role") == "user":
        convo.append(_content_to_text(dialog[0].get("content")))
    else:
        for m in dialog:
            role = m.get("role", "user")
            label = {"user": "User", "assistant": "Assistant", "tool": "Tool"}.get(role, role)
            convo.append(f"## {label}\n{_content_to_text(m.get('content'))}")
    return "\n\n".join(p for p in system_parts if p), "\n\n".join(convo)


def extract_json_schema(response_format: Any) -> dict | None:
    """Достаём JSON Schema из OpenAI response_format, если это json_schema."""
    if not isinstance(response_format, dict):
        return None
    if response_format.get("type") != "json_schema":
        return None
    js = response_format.get("json_schema")
    if isinstance(js, dict):
        # OpenAI кладёт реальную схему в .schema; иногда сам объект уже схема
        schema = js.get("schema")
        if isinstance(schema, dict):
            return schema
        if js.get("type") or js.get("properties"):
            return js
    return None


def wants_json_object(response_format: Any) -> bool:
    return isinstance(response_format, dict) and response_format.get("type") == "json_object"


# ─────────────────────── вызов claude CLI ─────────────────────

def _run_claude_sync(
    argv: list[str], stdin_text: str, timeout_s: int = CALL_TIMEOUT_S, cwd: str = CLEAN_CWD
) -> dict:
    """Синхронный вызов claude (в отдельном потоке). Возвращает распарсенный envelope."""
    proc = subprocess.run(
        argv,
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_CHILD_ENV,
        cwd=cwd,
        timeout=timeout_s,
    )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"claude вернул пусто (rc={proc.returncode}): {proc.stderr[:500]}")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # на случай если что-то напечаталось до JSON — берём последнюю строку-объект
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        raise RuntimeError(f"не удалось распарсить ответ claude: {out[:500]}")


def _run_claude_streamjson(argv: list[str], message: dict, timeout_s: int = CALL_TIMEOUT_S) -> dict:
    """Вызов claude с stream-json вход/выход (нужно для нативных картинок).
    Возвращает финальный result-event (в нём те же поля: result, structured_output, usage)."""
    proc = subprocess.run(
        argv,
        input=json.dumps(message) + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_CHILD_ENV,
        cwd=CLEAN_CWD,
        timeout=timeout_s,
    )
    result = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "result":
            result = ev
    if result is None:
        raise RuntimeError(
            f"claude stream-json: нет result-event (rc={proc.returncode}): {proc.stderr[:500]}"
        )
    return result


async def call_claude(
    *,
    model: str,
    system_text: str,
    prompt: str,
    json_schema: dict | None,
    images: list[dict] | None,
) -> dict:
    """Готовит argv и зовёт claude. С картинками — нативный multimodal через stream-json."""
    tmpdir = tempfile.mkdtemp(prefix="claude_proxy_")
    try:
        argv = [CLAUDE_CLI, "-p", "--model", model]
        call_timeout = OPUS_TIMEOUT_S if model == "opus" else CALL_TIMEOUT_S
        if FALLBACK_MODEL:
            argv += ["--fallback-model", FALLBACK_MODEL]

        if system_text:
            sys_file = os.path.join(tmpdir, "system.txt")
            Path(sys_file).write_text(system_text, encoding="utf-8")
            argv += ["--system-prompt-file", sys_file]

        if json_schema is not None:
            argv += ["--json-schema", json.dumps(json_schema)]

        if images:
            # Нативное зрение: картинка как content-блок (Claude мультимодальный, видит
            # её напрямую за один проход — быстро, без Read-tool костыля).
            content: list[dict] = [{"type": "text", "text": prompt}]
            for img in images:
                if img.get("data"):
                    content.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.get("media_type") or "image/png",
                            "data": img["data"],
                        },
                    })
                elif img.get("url"):
                    content.append({"type": "image", "source": {"type": "url", "url": img["url"]}})
            message = {"type": "user", "message": {"role": "user", "content": content}}
            argv += ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            async with _sem:
                return await asyncio.to_thread(_run_claude_streamjson, argv, message, call_timeout)

        argv += ["--output-format", "json"]
        async with _sem:
            return await asyncio.to_thread(_run_claude_sync, argv, prompt, call_timeout)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _strip_md_fences(text: str) -> str:
    """Убираем ```json ... ``` ограждения, если модель их добавила."""
    t = text.strip()
    if t.startswith("```"):
        t = t[3:]
        if t[:4].lower() == "json":
            t = t[4:]
        if t.endswith("```"):
            t = t[:-3]
    return t.strip()


def envelope_to_content(envelope: dict, *, structured: bool, json_obj: bool = False) -> str:
    """Из envelope claude достаём текст ответа для OpenAI content."""
    if structured and envelope.get("structured_output") is not None:
        return json.dumps(envelope["structured_output"], ensure_ascii=False)
    result = envelope.get("result", "") or ""
    if json_obj:
        return _strip_md_fences(result)
    return result


def map_usage(envelope: dict) -> dict:
    u = envelope.get("usage") or {}
    pt = int(u.get("input_tokens", 0) or 0)
    ct = int(u.get("output_tokens", 0) or 0)
    return {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct}


def openai_response(content: str, model_label: str, envelope: dict) -> dict:
    finish = "stop"
    if envelope.get("stop_reason") in ("max_tokens", "length"):
        finish = "length"
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_label,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish,
            }
        ],
        "usage": map_usage(envelope),
    }


def sse_chunks(content: str, model_label: str):
    """Минимальный SSE-стрим: один дельта-чанк + финал. Совместимо с OpenAI клиентами."""
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())
    first = {
        "id": cid, "object": "chat.completion.chunk", "created": created, "model": model_label,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
    }
    last = {
        "id": cid, "object": "chat.completion.chunk", "created": created, "model": model_label,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(first, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps(last, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


# ─────────────────────────── роуты ────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "claude_cli": CLAUDE_CLI, "default_model": DEFAULT_MODEL,
            "max_concurrency": MAX_CONCURRENCY}


@app.get("/v1/models")
async def models() -> dict:
    now = int(time.time())
    data = [
        {"id": m, "object": "model", "created": now, "owned_by": "anthropic-max-subscription"}
        for m in ("sonnet", "haiku", "opus")
    ]
    return {"object": "list", "data": data}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})

    messages = body.get("messages") or []
    model = map_model(body.get("model"))
    response_format = body.get("response_format")
    stream = bool(body.get("stream"))
    if body.get("tools"):
        log.warning("запрос пришёл с tools/функциями — прокси их не эмулирует; "
                    "переключи instructor в MD_JSON (см. README)")

    schema = extract_json_schema(response_format)
    json_obj = wants_json_object(response_format)
    system_text, prompt = split_messages(messages)

    if json_obj and not schema:
        system_text = (system_text + "\n\n" if system_text else "") + (
            "Ответь СТРОГО одним валидным JSON-объектом. Без пояснений, без markdown-ограждений."
        )

    images = _extract_images(messages)

    try:
        envelope = await call_claude(
            model=model, system_text=system_text, prompt=prompt,
            json_schema=schema, images=images or None,
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": {"message": "claude timeout"}})
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка вызова claude")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    if envelope.get("is_error"):
        msg = envelope.get("result") or envelope.get("subtype") or "claude error"
        return JSONResponse(status_code=502, content={"error": {"message": str(msg)}})

    content = envelope_to_content(envelope, structured=bool(schema), json_obj=json_obj)
    model_label = body.get("model") or model

    if stream:
        return StreamingResponse(sse_chunks(content, model_label), media_type="text/event-stream")
    return JSONResponse(content=openai_response(content, model_label, envelope))


@app.post("/v1/code-analyze")
async def code_analyze(request: Request):
    """Чистый opus-анализ кода Worki.

    Запускает claude (opus) В read-only клоне (cwd=WORKI_CLONE) с ТОЛЬКО задачей —
    без огромного контекста/истории Alice. Claude сам грепает/читает код своими
    Read/Grep/Glob и возвращает разбор. Обходит и конфабуляцию («не смонтировано»),
    и таймаут живого тика (промпт лёгкий). Тело: {"task": "..."}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})
    task = (body.get("task") or body.get("prompt") or "").strip()
    if not task:
        return JSONResponse(status_code=400, content={"error": {"message": "missing 'task'"}})
    if not WORKI_CLONE or not os.path.isdir(WORKI_CLONE):
        return JSONResponse(
            status_code=503, content={"error": {"message": f"worki clone unavailable: {WORKI_CLONE}"}}
        )

    persona = (body.get("persona") or "").strip()
    # Модель/таймаут по запросу (Alice кладёт по просьбе пользователя), иначе дефолты.
    req_model = (body.get("model") or "").strip().lower()
    model = req_model if req_model in ("sonnet", "opus", "haiku") else CODE_ANALYZE_MODEL
    try:
        timeout_s = int(body.get("timeout_s") or CODE_ANALYZE_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout_s = CODE_ANALYZE_TIMEOUT_S
    timeout_s = max(30, min(timeout_s, 1200))
    analyst = (
        "Текущая папка (cwd) — это репозиторий Worki, read-only. Исследуй код своими "
        "инструментами Read/Grep/Glob и ответь на задачу КОНКРЕТНО, по реальному коду, "
        "с путями к файлам. Бери МИНИМУМ файлов, нужных для ответа — не перечитывай лишнего. "
        "Кратко, по делу, без воды и без выдумок. Отвечай простым текстом для чата — без "
        "**жирного** и markdown-выделения."
    )
    # persona (краткая «душа» от Alice) — чтобы ответ был в её голосе. Без неё — нейтрально.
    system = f"{persona}\n\n{analyst}" if persona else analyst
    prompt = f"{system}\n\nЗАДАЧА: {task}"
    argv = [
        CLAUDE_CLI, "-p",
        "--model", model,
        "--allowedTools", "Read", "Grep", "Glob",
        "--output-format", "json",
    ]
    try:
        async with _sem:
            envelope = await asyncio.to_thread(
                _run_claude_sync, argv, prompt, timeout_s, WORKI_CLONE
            )
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": {"message": "code-analyze timeout"}})
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка code-analyze")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    if envelope.get("is_error"):
        msg = envelope.get("result") or envelope.get("subtype") or "claude error"
        return JSONResponse(status_code=502, content={"error": {"message": str(msg)}})
    return JSONResponse(content={"analysis": envelope.get("result") or "", "usage": envelope.get("usage")})
