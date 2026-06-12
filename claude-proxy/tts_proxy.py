"""TTS → MiniMax-совместимый шим (бесплатный голос для Alice, без API-ключа).

Alice (runtime/src/llm/tts.ts) шлёт POST {base}/v1/t2a_v2 в формате MiniMax и ждёт
JSON {data:{audio:"<hex MP3>"}, base_resp:{status_code:0}}. Дальше Alice сама
конвертирует MP3→OGG/Opus через ffmpeg. Мы синтезируем речь бесплатно, без ключа.

Движки (TTS_PROXY_ENGINE):
  - gtts (по умолчанию): Google Translate TTS. Простой HTTPS-GET, без websocket/токенов —
    надёжно работает в любом серверном контексте. Голос обычный (не нейронный).
  - edge: edge-tts (Microsoft, нейронный, как у Ami). Лучше по качеству, но на Windows
    в серверном контексте иногда отдаёт NoAudioReceived (троттлинг/контекст). При сбое
    автоматически падаем на gtts.

Сервер — синхронный stdlib http.server (без uvicorn).

Запуск:  python tts_proxy.py            (порт 5123, или TTS_PROXY_PORT)
"""
from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

log = logging.getLogger("tts_proxy")
logging.basicConfig(level=os.getenv("TTS_PROXY_LOG", "INFO"))

HOST = os.getenv("TTS_PROXY_HOST", "127.0.0.1")
PORT = int(os.getenv("TTS_PROXY_PORT", "5123"))
# edge = нейронный голос Microsoft (как Ami), при сбое автофолбэк на gtts.
# gtts = Google TTS, проще/надёжнее, но голос обычный. Переключение: TTS_PROXY_ENGINE.
ENGINE = os.getenv("TTS_PROXY_ENGINE", "edge").lower()  # edge | gtts
GTTS_LANG = os.getenv("TTS_PROXY_LANG", "ru")
# edge-tts голос/просодия — как у Ami (server/ami/config.py): Svetlana, pitch +15Hz, rate +0%.
EDGE_VOICE = os.getenv("TTS_PROXY_VOICE", "ru-RU-SvetlanaNeural")
EDGE_RATE = os.getenv("TTS_PROXY_RATE", "+0%")
EDGE_PITCH = os.getenv("TTS_PROXY_PITCH", "+15Hz")
EDGE_RETRIES = int(os.getenv("TTS_PROXY_RETRIES", "2"))


def _gtts_synth(text: str) -> bytes:
    from gtts import gTTS

    buf = io.BytesIO()
    gTTS(text=text, lang=GTTS_LANG).write_to_fp(buf)
    return buf.getvalue()


def _edge_synth(text: str) -> bytes:
    # edge-tts CLI; текст через UTF-8 файл (argv на Windows бьёт кириллицу).
    last = ""
    for attempt in range(EDGE_RETRIES):
        with tempfile.TemporaryDirectory(prefix="tts_") as d:
            out = os.path.join(d, "out.mp3")
            txt = os.path.join(d, "in.txt")
            with open(txt, "w", encoding="utf-8") as f:
                f.write(text)
            argv = [sys.executable, "-m", "edge_tts", "--voice", EDGE_VOICE, "--file", txt,
                    "--write-media", out]
            if EDGE_RATE:
                argv += ["--rate", EDGE_RATE]
            if EDGE_PITCH:
                argv += ["--pitch", EDGE_PITCH]
            proc = subprocess.run(argv, capture_output=True, timeout=60)
            if proc.returncode == 0 and os.path.exists(out):
                with open(out, "rb") as f:
                    data = f.read()
                if data:
                    return data
            last = proc.stderr.decode("utf-8", "replace")[-200:]
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"edge-tts failed: {last}")


def synthesize(text: str) -> bytes:
    if ENGINE == "edge":
        try:
            return _edge_synth(text)
        except Exception as e:  # noqa: BLE001
            log.warning("edge-tts failed (%s) → fallback gTTS", str(e)[-100:])
    return _gtts_synth(text)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401 — приглушаем access-log
        pass

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            self._json({"status": "ok", "engine": ENGINE, "lang": GTTS_LANG})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/v1/t2a_v2":
            self._json({"error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            self._json({"base_resp": {"status_code": 1, "status_msg": "invalid JSON"}})
            return

        text = (body.get("text") or "").strip()
        if not text:
            self._json({"base_resp": {"status_code": 1, "status_msg": "empty text"}})
            return

        try:
            mp3 = synthesize(text)
        except Exception as e:  # noqa: BLE001
            log.warning("synth failed: %s", e)
            self._json({"base_resp": {"status_code": 1, "status_msg": f"tts failed: {e}"}})
            return

        log.info("synthesized %d chars -> %d bytes MP3 (engine=%s)", len(text), len(mp3), ENGINE)
        self._json({
            "data": {"audio": mp3.hex(), "status": 2},
            "extra_info": {"audio_format": "mp3", "audio_length": len(mp3)},
            "base_resp": {"status_code": 0, "status_msg": "success"},
        })


def main() -> None:
    log.info("TTS shim on http://%s:%d engine=%s lang=%s", HOST, PORT, ENGINE, GTTS_LANG)
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
