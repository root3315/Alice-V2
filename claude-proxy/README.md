# claude-proxy — Claude (Max-подписка) как OpenAI-совместимый эндпоинт для Alice

Маленький Python-сервис: наружу даёт `POST /v1/chat/completions` в формате OpenAI,
а внутри гоняет **официальный `claude` CLI** через **OAuth Max-подписки** (как Ami).
Так Alice (которая написана под OpenAI-совместимые эндпоинты) ходит в Claude,
**не меняя свой код** — только конфиг.

## Почему это легально (и не приведёт к бану)

- Внутри крутится тот же самый официальный `claude` CLI, что и в твоём терминале /
  Claude Code. Это **поддерживаемый** способ программно использовать подписку.
- Авторизация — **OAuth Max-подписки**. Ключ `ANTHROPIC_API_KEY` намеренно НЕ
  задаётся (прокси даже вычищает его из окружения дочернего процесса). Если задать
  ключ — CLI уйдёт на платный API, это другой кошелёк.
- Мы **НЕ** дёргаем `api.anthropic.com` напрямую и **НЕ** подменяем OAuth-токен
  в HTTP-заголовках. Именно вот эти хаки и приводят к банам — мы их не делаем.

То есть нагрузка идёт по тем же правилам, что и обычный Claude Code: расходуется
лимит подписки, а не поштучная оплата.

## Что подтверждено рабочим (на этой машине)

`claude` 2.1.173, залогинен, Max-подписка. Прогон `test_proxy.py` через подписку:

```
[PASS] health
[PASS] generateText        -> 'Tokyo'
[PASS] generateObject      -> {'city': 'Tokyo', 'population_millions': 37.5}
[PASS] json_object
```

## Маппинг OpenAI → claude CLI

| OpenAI-запрос Alice | Что делает прокси |
|---|---|
| `messages` (system + диалог) | system → `--system-prompt-file`, остальное → stdin |
| `generateText` (мозг `tick/callLLM`, eval) | `claude -p --output-format json` → `.result` |
| `generateObject` (`response_format: json_schema`) | `--json-schema <schema>` → поле `structured_output` |
| instructor (MD_JSON) / `response_format: json_object` | просим «только JSON», чистим ```` ``` ```` |
| `model` | `sonnet`/`haiku`/`opus` по имени (иначе дефолт) |
| `stream: true` | один SSE-чанк + `[DONE]` |
| картинки (`image_url`/base64) | **experimental**: temp-файл + `--add-dir` + `--allowedTools Read` |

`temperature`, `max_tokens`, `stop` и т.п. CLI не принимает — игнорируются (модель
использует свои дефолты).

## Запуск

```powershell
cd _study\claude-proxy
python -m pip install -r requirements.txt        # fastapi + uvicorn
copy .env.example .env                            # при желании поправь модель/конкурентность
.\start.ps1                                        # → http://127.0.0.1:8787
```

Проверка в отдельном окне:

```powershell
python test_proxy.py
```

Настройки (через `.env` или переменные окружения):

| Переменная | Дефолт | Смысл |
|---|---|---|
| `PROXY_DEFAULT_MODEL` | `sonnet` | модель по умолчанию |
| `PROXY_FALLBACK_MODEL` | (пусто) | автофолбэк при перегрузе, напр. `sonnet` |
| `PROXY_MAX_CONCURRENCY` | `6` | сколько параллельных вызовов claude |
| `PROXY_TIMEOUT_S` | `180` | таймаут одного вызова |
| `PROXY_CLAUDE_CLI` | автопоиск | явный путь к `claude.exe` |

## Как подключена Alice

Уже сделано в склоне `_study/Alice`:

1. **`runtime/config.toml`** — эндпоинты `claude-sonnet` / `claude-haiku` на
   `http://127.0.0.1:8787/v1`. Роутинг: мозг (`first_pass`, `tool_tick`) → sonnet;
   `eval`/`auxiliary`/`reflect` → haiku. `[vision]` → прокси (experimental).
2. **`runtime/src/llm/instructor-client.ts`** — `claude/sonnet/haiku/opus` добавлены
   в `MD_JSON_MODEL_PATTERNS` (иначе instructor шлёт нативные tool-calls, которые
   прокси не эмулирует).
3. **`runtime/.env`** — `LLM_API_KEY=dummy` (openai-клиент требует непустую строку;
   на подписку не влияет).

## ВАЖНО: чтобы запустить саму Alice, нужен Node.js

Alice — это Node/TypeScript (pnpm, better-sqlite3, mtcute…). На машине **Node нет**.
Поставь:

```powershell
# Node 22 LTS + pnpm
winget install OpenJS.NodeJS.LTS
npm install -g pnpm
cd _study\Alice\runtime
pnpm install
pnpm run dev      # предварительно: запущен claude-proxy и заданы Telegram-креды в .env
```

Telegram API ID/HASH/PHONE нужны, чтобы бот реально подключился (получить на
https://my.telegram.org/apps). Без них конфиг грузится, но транспорт не поднимется —
LLM-путь через Claude при этом можно тестировать отдельно (`test_proxy.py`).

## Риски и ограничения (честно)

- **Latency.** Каждый вызов = запуск процесса `claude` (~2–4с холодного старта +
  время модели). Для автономного «думающего» цикла Alice это приемлемо, но не
  мгновенно. Ускорение (тёплый пул процессов / persistent client как в Ami) — TODO.
- **Структурный путь медленнее.** `--json-schema` делает лишний turn (claude сначала
  думает, потом структурирует) — ~в 2 раза дольше обычного текста. Зато надёжно.
- **Vision — самое неустойчивое.** Read-tool по temp-файлу работает, но капризнее и
  медленнее (лишний turn на Read). Если мешает — верни `[vision]` на ohmygpt
  (закомментированный вариант лежит прямо в `config.toml`).
- **Лимиты подписки.** У тебя Max x20 — запас большой, но Alice автономна (тикает
  сама, vision на тик, рефлексия). Если упрёшься в лимит — переведи `eval`/часть
  `auxiliary` обратно на платный ключ или снизь активность тиков. `eval` уже на haiku.
- **temperature недоступна.** Alice местами задаёт `temperature: 0.7` — CLI её
  игнорирует. На поведение влияет слабо, но имей в виду.

## Откат

Верни оригинальный блок `[[llm.endpoints]]` / `[llm.routing]` / `[vision]` в
`config.toml` (deepseek/ohmygpt) и убери claude-паттерны из `instructor-client.ts`.
Прокси при этом просто не используется.
