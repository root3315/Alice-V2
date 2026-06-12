"""Сквозной тест TTS-шима: POST /v1/t2a_v2 → декод hex-аудио → файл.
Проверяет весь HTTP-путь, которым ходит Alice (а не только функцию синтеза).

Запуск (шим должен быть поднят на :5123):
  python test_tts.py
  python test_tts.py "своя фраза"
"""
import json
import sys
import urllib.request

URL = "http://127.0.0.1:5123/v1/t2a_v2"
TEXT = sys.argv[1] if len(sys.argv) > 1 else (
    "Привет! Это сквозной тест голоса. Если ты это слышишь — значит, всё работает."
)


def main() -> None:
    body = json.dumps({"text": TEXT}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())

    br = data.get("base_resp", {})
    if br.get("status_code") != 0:
        print("FAIL:", br)
        sys.exit(1)

    audio_hex = data["data"]["audio"]
    fmt = data.get("extra_info", {}).get("audio_format", "bin")
    audio = bytes.fromhex(audio_hex)
    out = f"tts-shim-test.{fmt}"
    with open(out, "wb") as f:
        f.write(audio)
    print(f"OK: {len(audio)} bytes {fmt} -> {out}")


if __name__ == "__main__":
    main()
