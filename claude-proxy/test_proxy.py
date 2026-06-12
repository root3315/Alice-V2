"""Автономный тест claude-proxy без Node/Alice.

Шлёт ровно такие запросы, какие шлёт Alice:
  1) generateText  — обычный chat.completions (мозг tick/callLLM, eval)
  2) generateObject — response_format=json_schema (structured_output)
  3) json_object   — как instructor в MD_JSON

Запуск:
  # терминал 1:  .\start.ps1      (или: python -m uvicorn claude_proxy:app --port 8787)
  # терминал 2:  python test_proxy.py
"""
import json
import os
import sys
import urllib.request

BASE = os.getenv("PROXY_BASE", "http://127.0.0.1:8787")


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer dummy"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=200) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check(name: str, cond: bool, detail: str = "") -> bool:
    mark = "PASS" if cond else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    return cond


def main() -> int:
    ok = True

    # 0) health
    try:
        h = get("/health")
        ok &= check("health", h.get("status") == "ok", h.get("claude_cli", ""))
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] health — {e}\n  -> запущен ли прокси? {BASE}")
        return 1

    # 1) generateText
    r = post("/v1/chat/completions", {
        "model": "sonnet",
        "messages": [
            {"role": "system", "content": "You are terse. Answer with one word only."},
            {"role": "user", "content": "Capital of Japan?"},
        ],
    })
    content = r["choices"][0]["message"]["content"]
    ok &= check("generateText", "tokyo" in content.lower(), repr(content))

    # 2) generateObject (json_schema -> structured_output)
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string"}, "population_millions": {"type": "number"}},
        "required": ["city", "population_millions"],
        "additionalProperties": False,
    }
    r = post("/v1/chat/completions", {
        "model": "haiku",
        "messages": [{"role": "user", "content": "Tokyo population, approx."}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "city_pop", "strict": True, "schema": schema}},
    })
    content = r["choices"][0]["message"]["content"]
    try:
        obj = json.loads(content)
        ok &= check("generateObject", "city" in obj and "population_millions" in obj, repr(obj))
    except json.JSONDecodeError:
        ok &= check("generateObject", False, f"не JSON: {content!r}")

    # 3) json_object (instructor MD_JSON-стиль)
    r = post("/v1/chat/completions", {
        "model": "haiku",
        "messages": [{"role": "user",
                      "content": 'Give {"a":1,"b":2} as JSON with keys a and b.'}],
        "response_format": {"type": "json_object"},
    })
    content = r["choices"][0]["message"]["content"]
    try:
        json.loads(content.strip().strip("`").removeprefix("json").strip())
        ok &= check("json_object", True, repr(content[:80]))
    except json.JSONDecodeError:
        ok &= check("json_object", False, f"не JSON: {content!r}")

    print("\n=== " + ("ВСЁ ОК" if ok else "ЕСТЬ ОШИБКИ") + " ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
