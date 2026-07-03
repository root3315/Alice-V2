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
import shlex
import shutil
import subprocess
import threading
import time
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
# Web-research (/v1/research): keyless веб через Max — claude сам ходит WebFetch/WebSearch
# в ЧИСТОЙ папке (cwd=CLEAN_CWD), это НЕ репозиторий. Модель/таймаут как у code-analyze.
RESEARCH_MODEL = os.getenv("PROXY_RESEARCH_MODEL", "sonnet")
# Дефолтный таймаут research (сек, 5 мин). Запрос может прислать свой timeout_s.
RESEARCH_TIMEOUT_S = int(os.getenv("PROXY_RESEARCH_TIMEOUT_S", "300"))
# Писчий dev-клон для code-fix (агент правит+тестит+коммитит здесь). НЕ read-only клон.
WORKI_DEV_CLONE = os.getenv("PROXY_WORKI_DEV_CLONE", r"C:\Users\sozda\alice-worki-dev")
# code-fix дольше (правка + тесты): дефолт 10 мин.
CODE_FIX_TIMEOUT_S = int(os.getenv("PROXY_CODE_FIX_TIMEOUT_S", "600"))
WORKI_BASE_BRANCH = os.getenv("PROXY_WORKI_BASE_BRANCH", "main")

# Таймаут для прямого прогона команд (code-test / code-run): дефолт 10 мин. Это
# обычные subprocess-команды (npm/pytest/...), а не агентный claude — но тоже bounded.
CODE_CMD_TIMEOUT_S = int(os.getenv("PROXY_CODE_CMD_TIMEOUT_S", "600"))

# Мультипроект: карта name -> {clone, baseBranch, testCmd} из env JSON. БЕЗ проекта
# (default) всё указывает на одиночный WORKI_DEV_CLONE — полная обратная совместимость.
#   PROXY_WORKI_PROJECTS='{"hh":{"clone":"C:\\...\\hh-dev","baseBranch":"main","testCmd":"npm test"}}'
def _load_projects() -> dict[str, dict]:
    raw = os.getenv("PROXY_WORKI_PROJECTS", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        log.warning("PROXY_WORKI_PROJECTS не распарсился как JSON — игнорирую")
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict] = {}
    for name, cfg in data.items():
        if isinstance(cfg, dict) and cfg.get("clone"):
            out[str(name)] = {
                "clone": str(cfg.get("clone")),
                "baseBranch": str(cfg.get("baseBranch") or WORKI_BASE_BRANCH),
                "testCmd": (str(cfg["testCmd"]) if cfg.get("testCmd") else None),
            }
    return out


WORKI_PROJECTS = _load_projects()

# На Max-подписке ключ должен быть пустым, иначе CLI уйдёт на платный API.
# Подчищаем окружение дочернего процесса от ключа на всякий случай.
_CHILD_ENV = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

# Изолированная пустая рабочая директория для claude. Иначе CLI авто-подхватывает
# CLAUDE.md и auto-memory из дерева проекта (Astracore) — это и лишняя латентность
# (~20k токенов на каждый вызов), и загрязнение промпта Alice чужим контекстом.
# Пустая папка = новый «проект» без памяти → минимальный системный оверхед.
CLEAN_CWD = os.path.join(tempfile.gettempdir(), "claude_proxy_cwd")
os.makedirs(CLEAN_CWD, exist_ok=True)


def _cli_supports_flag(flag: str) -> bool:
    """Разовая проверка при старте: умеет ли установленный claude данный флаг.

    Нужна для сервера, где крутится чисто-JS claude-code 1.0.128 (SEA-бинарник 2.x
    зависает на эмулированном CPU): у 1.0.128 нет --json-schema, и запросы со схемой
    падали бы «unknown option». При недоступности --help считаем CLI современным.
    """
    try:
        proc = subprocess.run(
            [CLAUDE_CLI, "--help"],
            capture_output=True, text=True, encoding="utf-8",
            env=_CHILD_ENV, cwd=CLEAN_CWD, timeout=60,
        )
        return flag in (proc.stdout or "") + (proc.stderr or "")
    except Exception:  # noqa: BLE001
        return True


CLI_HAS_JSON_SCHEMA = _cli_supports_flag("--json-schema")
log.info("claude CLI: --json-schema %s", "поддерживается" if CLI_HAS_JSON_SCHEMA else "НЕТ (схему кладём в промпт)")

_sem = asyncio.Semaphore(MAX_CONCURRENCY)
# Отдельный бюджет для worki (code-analyze/code-fix): фоновый агентный разбор НЕ должен
# занимать слоты разговорных тиков Alice — иначе её ответы тормозят даже на sonnet (HIGH-6).
_worki_sem = asyncio.Semaphore(int(os.getenv("PROXY_WORKI_CONCURRENCY", "2")))

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


# ─────────────────────── worki прогресс-стриминг ─────────────────────
# Живой лог действий агента (code-analyze/code-fix): Alice не молчит 5 минут, а показывает
# «читаю X, запускаю тесты». Склад по task_id; читается эндпоинтом /v1/code-progress/{id}.
_worki_progress: dict[str, dict] = {}
_worki_progress_lock = threading.Lock()


def _progress_line(name: str, inp: dict) -> str | None:
    """tool-use агента → короткая человеческая строка для чата."""
    n = (name or "").lower()

    def _base(k: str) -> str:
        return os.path.basename(str(inp.get(k, ""))).strip()

    if n == "read":
        return f"читаю {_base('file_path')}" if _base("file_path") else "читаю файлы"
    if n == "grep":
        return f"ищу «{str(inp.get('pattern', ''))[:40]}»"
    if n == "glob":
        return f"ищу файлы {str(inp.get('pattern', ''))[:40]}"
    if n in ("edit", "write", "multiedit"):
        return f"правлю {_base('file_path')}" if _base("file_path") else "правлю код"
    if n == "bash":
        return f"запускаю: {str(inp.get('command', ''))[:50]}"
    if n == "task":
        return "разбираюсь…"
    return None


def _set_progress(task_id: str, line: str) -> None:
    if not task_id or not line:
        return
    with _worki_progress_lock:
        e = _worki_progress.get(task_id) or {"recent": [], "updated": 0.0}
        e["latest"] = line
        e["recent"] = (e["recent"] + [line])[-8:]
        e["updated"] = time.time()
        _worki_progress[task_id] = e


def _clear_progress(task_id: str) -> None:
    with _worki_progress_lock:
        _worki_progress.pop(task_id, None)


def _run_claude_streaming_progress(
    argv: list[str], stdin_text: str, timeout_s: int, cwd: str, task_id: str
) -> dict:
    """Как _run_claude_sync, но stream-json: по ходу складывает tool-use агента в прогресс.
    argv ДОЛЖЕН включать --output-format stream-json --verbose. Возвращает финальный result-event."""
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        # stderr СЛИВАЕМ в stdout: иначе на длинной --verbose задаче буфер stderr переполняется,
        # claude блокируется на записи, поток стопорится → соединение рвётся (fetch failed).
        # Один дренируемый поток; не-JSON строки (шум stderr) пропускаются парсером ниже.
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        env=_CHILD_ENV,
        cwd=cwd,
    )
    timer = threading.Timer(timeout_s, proc.kill)
    timer.start()
    result = None
    try:
        if proc.stdin:
            proc.stdin.write(stdin_text)
            proc.stdin.close()
        for line in proc.stdout or []:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = ev.get("type")
            if etype == "assistant":
                for block in ev.get("message", {}).get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        pl = _progress_line(block.get("name", ""), block.get("input") or {})
                        if pl:
                            _set_progress(task_id, pl)
            elif etype == "result":
                result = ev
        proc.wait(timeout=10)
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
    if result is None:
        raise RuntimeError(f"streaming: нет result-event (rc={proc.returncode})")
    return result


# ─────────────────────── мультипроект + прямой прогон команд ─────────────────────
# /v1/code-test и /v1/code-run гоняют команды (npm/pytest/...) НАПРЯМУЮ в dev-клоне —
# без агента claude. Те же инварианты: bounded timeout + общий _worki_sem (не отъедать
# слоты разговорных тиков Alice). Команда строго allowlist-нута по первому токену.

# Первый токен команды → разрешён ли. rm/curl/wget/etc. — нет. git только read-only.
_RUN_ALLOWLIST = frozenset({
    "npm", "pnpm", "npx", "node", "python", "pytest",
    "ruff", "tsc", "eslint", "biome", "git", "ls",
})
# Подкоманды git, которые НЕ меняют дерево/историю и безопасны для прогона.
_GIT_SAFE_SUBCMDS = frozenset({"status", "diff", "log"})
# Метасимволы шелла, которыми можно вырваться из клона или сцепить команды.
_SHELL_METACHARS = ("&", "|", ";", ">", "<", "`", "$(", "${", "\n", "\r")


def _resolve_project(name: str | None) -> tuple[str, str, str | None]:
    """name → (clone, baseBranch, testCmd|None). Без name (или 'default') —
    одиночный WORKI_DEV_CLONE для полной обратной совместимости. Бросает KeyError
    на неизвестный проект."""
    nm = (name or "").strip()
    if not nm or nm == "default":
        return WORKI_DEV_CLONE, WORKI_BASE_BRANCH, None
    cfg = WORKI_PROJECTS.get(nm)
    if not cfg:
        raise KeyError(nm)
    return cfg["clone"], cfg["baseBranch"], cfg.get("testCmd")


def _default_test_cmd(clone: str, project_test_cmd: str | None) -> str:
    """Дефолтная тест-команда: из конфига проекта, иначе по содержимому клона
    (package.json → npm test; pyproject/pytest → pytest), иначе npm test."""
    if project_test_cmd:
        return project_test_cmd
    try:
        if os.path.isfile(os.path.join(clone, "package.json")):
            return "npm test"
        if (os.path.isfile(os.path.join(clone, "pyproject.toml"))
                or os.path.isfile(os.path.join(clone, "pytest.ini"))
                or os.path.isfile(os.path.join(clone, "setup.cfg"))):
            return "python -m pytest -q"
    except OSError:
        pass
    return "npm test"


def _check_command_allowed(command: str) -> tuple[list[str] | None, str | None]:
    """Валидирует одиночную allowlist-команду. Возвращает (argv, None) если ок,
    либо (None, причина-ошибки). Запрещает сцепку/редиректы/подстановку шелла."""
    if not command or not command.strip():
        return None, "empty command"
    if any(ch in command for ch in _SHELL_METACHARS):
        return None, "command contains shell metacharacters (chaining/redirect/substitution not allowed)"
    try:
        # posix=False: корректный разбор Windows-путей с обратными слешами.
        argv = shlex.split(command, posix=False)
    except ValueError as e:
        return None, f"cannot parse command: {e}"
    if not argv:
        return None, "empty command"
    head = argv[0].strip().strip('"').lower()
    # Снять возможное .cmd/.exe-расширение (npm.cmd и т.п.).
    head_base = os.path.splitext(os.path.basename(head))[0]
    if head_base not in _RUN_ALLOWLIST:
        return None, f"command '{head_base}' is not allowed (allowed: {', '.join(sorted(_RUN_ALLOWLIST))})"
    if head_base == "git":
        sub = (argv[1].strip().strip('"').lower() if len(argv) > 1 else "")
        if sub not in _GIT_SAFE_SUBCMDS:
            return None, f"git subcommand '{sub or '(none)'}' not allowed (only: {', '.join(sorted(_GIT_SAFE_SUBCMDS))})"
    return argv, None


def _run_bounded_command(argv: list[str], cwd: str, timeout_s: int) -> dict:
    """Прогон одной команды в cwd с bounded timeout. Возвращает
    {exitCode, output_tail, timed_out}. Хвост stdout+stderr (последние ~6000 симв.)."""
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_CHILD_ENV,
            cwd=cwd,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as e:
        def _as_text(v: Any) -> str:
            if v is None:
                return ""
            return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
        parts = [p for p in (_as_text(e.stdout), _as_text(e.stderr)) if p]
        return {"exitCode": None, "output_tail": "\n".join(parts)[-6000:], "timed_out": True}
    combined = (proc.stdout or "")
    if proc.stderr:
        combined += ("\n" if combined else "") + proc.stderr
    return {"exitCode": proc.returncode, "output_tail": combined[-6000:], "timed_out": False}


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
        # --strict-mcp-config: НЕ грузить глобальные MCP-серверы (Figma/Canva/Gmail и пр.) — чату
        # Алисы они не нужны, а их init добавляет ~1с к КАЖДОМУ спавну claude. Замер: 6.2с → 5.2с.
        argv = [CLAUDE_CLI, "-p", "--model", model, "--strict-mcp-config"]
        call_timeout = OPUS_TIMEOUT_S if model == "opus" else CALL_TIMEOUT_S
        if FALLBACK_MODEL:
            argv += ["--fallback-model", FALLBACK_MODEL]

        if system_text:
            sys_file = os.path.join(tmpdir, "system.txt")
            Path(sys_file).write_text(system_text, encoding="utf-8")
            argv += ["--system-prompt-file", sys_file]

        if json_schema is not None:
            if CLI_HAS_JSON_SCHEMA:
                argv += ["--json-schema", json.dumps(json_schema)]
            else:
                # Старый чисто-JS CLI (сервер, 1.0.128): флага нет — кладём схему в промпт,
                # JSON достаём из текста ответа (см. envelope_to_content: structured-fallback).
                prompt = (
                    f"{prompt}\n\n"
                    "Ответь СТРОГО одним валидным JSON-объектом по этой JSON Schema — "
                    "без пояснений и без markdown-ограждений, только сам JSON:\n"
                    + json.dumps(json_schema, ensure_ascii=False)
                )

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
    if structured:
        if envelope.get("structured_output") is not None:
            return json.dumps(envelope["structured_output"], ensure_ascii=False)
        # Старый CLI без --json-schema: схема ехала в промпте → JSON лежит в тексте ответа.
        return _strip_md_fences(envelope.get("result", "") or "")
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
    task_id = (body.get("task_id") or "").strip()
    out_fmt = (
        ["--output-format", "stream-json", "--verbose"]
        if task_id
        else ["--output-format", "json"]
    )
    argv = [
        CLAUDE_CLI, "-p",
        "--model", model,
        "--strict-mcp-config",
        "--allowedTools", "Read", "Grep", "Glob",
        *out_fmt,
    ]
    try:
        async with _worki_sem:
            if task_id:
                envelope = await asyncio.to_thread(
                    _run_claude_streaming_progress, argv, prompt, timeout_s, WORKI_CLONE, task_id
                )
            else:
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


@app.post("/v1/research")
async def research(request: Request):
    """Keyless веб-ресёрч через Max-подписку.

    Зеркало /v1/code-analyze, НО это веб-исследование, а не репозиторий: cwd=CLEAN_CWD
    (чистая папка, НИКОГДА не worki-клон). claude сам ходит в сеть своими веб-инструментами
    (WebSearch/WebFetch — keyless через Max) + Read и возвращает сводку простым текстом.
    Тело: {"task": "<URL или тема>", "task_id"?, "model"?, "persona"?, "timeout_s"?}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})
    task = (body.get("task") or body.get("prompt") or "").strip()
    if not task:
        return JSONResponse(status_code=400, content={"error": {"message": "missing 'task'"}})

    persona = (body.get("persona") or "").strip()
    # Модель/таймаут по запросу (Alice кладёт по просьбе пользователя), иначе дефолты.
    req_model = (body.get("model") or "").strip().lower()
    model = req_model if req_model in ("sonnet", "opus", "haiku") else RESEARCH_MODEL
    try:
        timeout_s = int(body.get("timeout_s") or RESEARCH_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout_s = RESEARCH_TIMEOUT_S
    timeout_s = max(30, min(timeout_s, 1200))
    researcher = (
        "Изучи заданный URL или тему своими веб-инструментами: WebFetch — читать страницы и "
        "ходить по ссылкам, WebSearch — искать. Верни КОНКРЕТНУЮ полезную сводку простым текстом "
        "для чата: ключевые факты, что там, твоё мнение. По-русски, кратко, без markdown-выделения "
        "и без воды."
    )
    # persona (краткая «душа» от Alice) — чтобы ответ был в её голосе. Без неё — нейтрально.
    system = f"{persona}\n\n{researcher}" if persona else researcher
    prompt = f"{system}\n\nЗАДАЧА: {task}"
    task_id = (body.get("task_id") or "").strip()
    out_fmt = (
        ["--output-format", "stream-json", "--verbose"]
        if task_id
        else ["--output-format", "json"]
    )
    argv = [
        CLAUDE_CLI, "-p",
        "--model", model,
        "--strict-mcp-config",
        "--allowedTools", "WebSearch", "WebFetch", "Read",
        *out_fmt,
    ]
    try:
        async with _worki_sem:
            if task_id:
                envelope = await asyncio.to_thread(
                    _run_claude_streaming_progress, argv, prompt, timeout_s, CLEAN_CWD, task_id
                )
            else:
                envelope = await asyncio.to_thread(
                    _run_claude_sync, argv, prompt, timeout_s, CLEAN_CWD
                )
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": {"message": "research timeout"}})
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка research")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    if envelope.get("is_error"):
        msg = envelope.get("result") or envelope.get("subtype") or "claude error"
        return JSONResponse(status_code=502, content={"error": {"message": str(msg)}})
    return JSONResponse(content={"research": envelope.get("result") or "", "usage": envelope.get("usage")})


@app.get("/v1/code-progress/{task_id}")
async def code_progress(task_id: str) -> dict:
    """Живой прогресс worki-агента по task_id (для Alice: «читаю X…»)."""
    with _worki_progress_lock:
        e = _worki_progress.get(task_id)
        return dict(e) if e else {"latest": None, "recent": [], "updated": 0.0}


@app.post("/v1/code-fix")
async def code_fix(request: Request):
    """Fix-агент: правит баг в ПИСЧЕМ dev-клоне Worki, гоняет относящиеся тесты,
    создаёт ветку и коммитит ЛОКАЛЬНО (без push/PR — это отдельный шаг /v1/code-pr).
    Те же model/timeout-оверрайды, что у code-analyze. Тело: {task, model?, timeout_s?, persona?}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})
    task = (body.get("task") or "").strip()
    if not task:
        return JSONResponse(status_code=400, content={"error": {"message": "missing 'task'"}})
    if not WORKI_DEV_CLONE or not os.path.isdir(WORKI_DEV_CLONE):
        return JSONResponse(
            status_code=503, content={"error": {"message": f"dev clone unavailable: {WORKI_DEV_CLONE}"}}
        )
    req_model = (body.get("model") or "").strip().lower()
    model = req_model if req_model in ("sonnet", "opus", "haiku") else CODE_ANALYZE_MODEL
    try:
        timeout_s = int(body.get("timeout_s") or CODE_FIX_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout_s = CODE_FIX_TIMEOUT_S
    timeout_s = max(60, min(timeout_s, 1800))
    # Детерминированно привести dev-клон к ЧИСТОМУ base ПЕРЕД агентом (не доверять агенту:
    # он может пропустить reset и захватить чужие незакоммиченные правки в коммит).
    try:
        subprocess.run(["git", "-C", WORKI_DEV_CLONE, "checkout", "-f", WORKI_BASE_BRANCH], check=True, capture_output=True, timeout=60)
        subprocess.run(["git", "-C", WORKI_DEV_CLONE, "reset", "--hard"], check=True, capture_output=True, timeout=60)
    except Exception as e:  # noqa: BLE001
        log.exception("clean base failed")
        return JSONResponse(status_code=500, content={"error": {"message": f"clean base failed: {e}"}})
    persona = (body.get("persona") or "").strip()
    fix = (
        "Текущая папка (cwd) — ПИСЧИЙ клон Worki, можно править. Исправь описанный баг. Работай БЫСТРО и УЗКО.\n"
        "1. База уже чистая (main, сброшена за тебя). НЕ переключай ветки и НЕ делай reset — сразу к правке.\n"
        "2. Найди причину (Read/Grep/Glob) и внеси МИНИМАЛЬНУЮ правку (Edit/Write). Трогай ТОЛЬКО файлы по задаче.\n"
        "3. Проверь БЫСТРО и УЗКО — КРИТИЧНО: полный прогон ~17 мин, его НЕ запускай. Только одно из:\n"
        "   - import/синтаксис-чек изменённого модуля; ЛИБО\n"
        "   - ОДИН самый релевантный тест-файл (НЕ наборы/каталоги, НЕ весь pytest):\n"
        "     бэкенд: `cd HH-PY && .venv/Scripts/python -m pytest tests/<один_файл> -q -x`;\n"
        "     фронт (быстрее): `cd Worki && npm test -- <один файл>`;\n"
        "   - если быстрой узкой проверки не видно — ПРОПУСТИ тесты и честно пометь «тесты не гонял».\n"
        "4. Проверка зелёная (или осознанно пропущена) → ветка+коммит: `git checkout -b alice/<слаг>`, `git add -A`, `git commit -m 'fix: ...'`. НЕ пушь, PR не открывай.\n"
        "5. Если правка не выходит или нужный тест красный — НЕ коммить, честно опиши проблему.\n"
        "Верни КРАТКО для пересказа в чат: причина, что поправил (файлы), результат проверки, имя ветки."
    )
    system = f"{persona}\n\n{fix}" if persona else fix
    prompt = f"{system}\n\nБАГ/ЗАДАЧА: {task}"
    task_id = (body.get("task_id") or "").strip()
    out_fmt = (
        ["--output-format", "stream-json", "--verbose"]
        if task_id
        else ["--output-format", "json"]
    )
    argv = [
        CLAUDE_CLI, "-p",
        "--model", model,
        "--strict-mcp-config",
        "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write", "Bash",
        *out_fmt,
    ]
    try:
        async with _worki_sem:
            if task_id:
                envelope = await asyncio.to_thread(
                    _run_claude_streaming_progress, argv, prompt, timeout_s, WORKI_DEV_CLONE, task_id
                )
            else:
                envelope = await asyncio.to_thread(_run_claude_sync, argv, prompt, timeout_s, WORKI_DEV_CLONE)
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": {"message": "code-fix timeout"}})
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка code-fix")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})
    if envelope.get("is_error"):
        msg = envelope.get("result") or envelope.get("subtype") or "claude error"
        return JSONResponse(status_code=502, content={"error": {"message": str(msg)}})
    return JSONResponse(content={"report": envelope.get("result") or "", "usage": envelope.get("usage")})


@app.post("/v1/code-test")
async def code_test(request: Request):
    """Гоняет тест-набор проекта в dev-клоне и отдаёт pass/fail.

    Тело: {task_id?, project?, test_cmd?}. Клон/тест-команда резолвятся из
    мультипроект-карты (без project — одиночный WORKI_DEV_CLONE). test_cmd, если
    передан, проходит тот же allowlist, что и /v1/code-run. Прогон — bounded
    subprocess под общим _worki_sem (как code-analyze/code-fix). Возвращает
    {ok, exitCode, output_tail, summary}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})
    try:
        clone, _base, project_test_cmd = _resolve_project(body.get("project"))
    except KeyError as e:
        return JSONResponse(status_code=404, content={"error": {"message": f"unknown project: {e}"}})
    if not clone or not os.path.isdir(clone):
        return JSONResponse(status_code=503, content={"error": {"message": f"dev clone unavailable: {clone}"}})

    req_cmd = (body.get("test_cmd") or "").strip()
    if req_cmd:
        argv, err = _check_command_allowed(req_cmd)
        if err:
            return JSONResponse(status_code=400, content={"error": {"message": err}})
        cmd_str = req_cmd
    else:
        cmd_str = _default_test_cmd(clone, project_test_cmd)
        argv, err = _check_command_allowed(cmd_str)
        if err:
            return JSONResponse(status_code=400, content={"error": {"message": f"default test cmd rejected: {err}"}})

    task_id = (body.get("task_id") or "").strip()
    if task_id:
        _set_progress(task_id, f"запускаю тесты: {cmd_str[:50]}")
    try:
        async with _worki_sem:
            res = await asyncio.to_thread(_run_bounded_command, argv, clone, CODE_CMD_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка code-test")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})
    finally:
        if task_id:
            _clear_progress(task_id)

    if res.get("timed_out"):
        return JSONResponse(status_code=504, content={
            "ok": False, "exitCode": None, "output_tail": res.get("output_tail", ""),
            "summary": f"test timeout after {CODE_CMD_TIMEOUT_S}s",
        })
    ok = res["exitCode"] == 0
    summary = "tests passed" if ok else f"tests failed (exit {res['exitCode']})"
    return JSONResponse(content={
        "ok": ok, "exitCode": res["exitCode"],
        "output_tail": res["output_tail"], "summary": summary,
    })


@app.post("/v1/code-run")
async def code_run(request: Request):
    """Гоняет ОДНУ bounded allowlist-команду в dev-клоне.

    Тело: {command, project?, task_id?}. Первый токен должен быть в allowlist
    (npm/pnpm/npx/node/python/pytest/ruff/tsc/eslint/biome/git[status|diff|log]/ls).
    Сцепка (&&/;/|), редиректы и подстановки шелла запрещены. Возвращает
    {ok, exitCode, output_tail}.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})
    command = (body.get("command") or "").strip()
    if not command:
        return JSONResponse(status_code=400, content={"error": {"message": "missing 'command'"}})
    try:
        clone, _base, _test = _resolve_project(body.get("project"))
    except KeyError as e:
        return JSONResponse(status_code=404, content={"error": {"message": f"unknown project: {e}"}})
    if not clone or not os.path.isdir(clone):
        return JSONResponse(status_code=503, content={"error": {"message": f"dev clone unavailable: {clone}"}})

    argv, err = _check_command_allowed(command)
    if err:
        return JSONResponse(status_code=400, content={"error": {"message": err}})

    task_id = (body.get("task_id") or "").strip()
    if task_id:
        _set_progress(task_id, f"запускаю: {command[:50]}")
    try:
        async with _worki_sem:
            res = await asyncio.to_thread(_run_bounded_command, argv, clone, CODE_CMD_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка code-run")
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})
    finally:
        if task_id:
            _clear_progress(task_id)

    if res.get("timed_out"):
        return JSONResponse(status_code=504, content={
            "ok": False, "exitCode": None, "output_tail": res.get("output_tail", ""),
        })
    return JSONResponse(content={
        "ok": res["exitCode"] == 0, "exitCode": res["exitCode"],
        "output_tail": res["output_tail"],
    })
