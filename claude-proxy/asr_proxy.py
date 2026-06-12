"""ASR-шим (слух Алисы) — OpenAI /audio/transcriptions-совместимый, на faster-whisper.

Alice (runtime/src/llm/asr.ts) шлёт multipart POST {base}/audio/transcriptions:
  file=voice.ogg (OGG/Opus, формат голосовых Telegram), model=..., Authorization: Bearer.
Ждёт JSON {"text": "..."}. Всё локально, бесплатно, без ключа, на GPU (или CPU).

OGG/Opus декодируется внутри faster-whisper через PyAV — системный ffmpeg не нужен.
Модель грузится в память ОДИН раз при старте (иначе первый запрос упрётся в таймаут 15с).

Эндпоинты:
  POST /v1/audio/transcriptions  — транскрипция (multipart)
  GET  /health
Запуск:  python asr_proxy.py            (порт 5124, или ASR_PROXY_PORT)
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

log = logging.getLogger("asr_proxy")
logging.basicConfig(level=os.getenv("ASR_PROXY_LOG", "INFO"))

HOST = os.getenv("ASR_PROXY_HOST", "127.0.0.1")
PORT = int(os.getenv("ASR_PROXY_PORT", "5124"))

_HERE = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_ROOT = os.path.join(_HERE, "tts-models", "whisper")  # кэш модели (gitignored)

# large-v3 = лучшее качество для русского. int8_float16 на GPU ~1.5GB VRAM (влезает рядом с XTTS).
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")          # cuda | cpu
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8_float16")  # cuda: int8_float16; cpu: int8
WHISPER_LANG = os.getenv("WHISPER_LANG", "ru")                # "" = автоопределение
WHISPER_BEAM = int(os.getenv("WHISPER_BEAM", "5"))           # меньше = быстрее (1 = greedy), чуть ниже точность

_model = None
_lock = threading.Lock()


def _add_cuda_dll_dirs() -> None:
    """ctranslate2 (движок faster-whisper) на Windows ищет cudnn/cublas DLL в путях
    поиска. Переиспользуем те, что привёз torch (cu121) — иначе CUDA не поднимется
    и всё уедет на медленный CPU."""
    try:
        import torch

        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            os.add_dll_directory(lib)
            log.info("added CUDA dll dir: %s", lib)
    except Exception as e:  # noqa: BLE001
        log.debug("cuda dll dirs: %s", e)


def _get_model():
    """Грузим faster-whisper один раз. При сбое CUDA — фолбэк на CPU/int8."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                if WHISPER_DEVICE == "cuda":
                    _add_cuda_dll_dirs()
                from faster_whisper import WhisperModel

                t0 = time.time()
                try:
                    log.info("loading whisper %s on %s (%s) …",
                             WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
                    _model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE,
                                          compute_type=WHISPER_COMPUTE,
                                          download_root=DOWNLOAD_ROOT)
                except Exception as e:  # noqa: BLE001
                    log.warning("CUDA-загрузка не удалась (%s) → CPU/int8", str(e)[-160:])
                    _model = WhisperModel(WHISPER_MODEL, device="cpu",
                                          compute_type="int8", download_root=DOWNLOAD_ROOT)
                log.info("whisper loaded in %.1fs", time.time() - t0)
    return _model


def transcribe(path: str) -> str:
    model = _get_model()
    kwargs = {"beam_size": WHISPER_BEAM, "vad_filter": True}
    if WHISPER_LANG:
        kwargs["language"] = WHISPER_LANG
    segments, _info = model.transcribe(path, **kwargs)
    return " ".join(s.text.strip() for s in segments).strip()


def _extract_file(body: bytes, boundary: str) -> bytes | None:
    """Минимальный парсер multipart/form-data: достаём содержимое поля name=\"file\"."""
    delim = ("--" + boundary).encode("utf-8")
    for part in body.split(delim):
        if b'name="file"' not in part:
            continue
        header, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]
        return content
    return None


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
            self._json({"status": "ok", "model": WHISPER_MODEL,
                        "device": WHISPER_DEVICE, "lang": WHISPER_LANG})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.split("?")[0].endswith("/audio/transcriptions"):
            self._json({"error": "not found"}, 404)
            return

        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype or "boundary=" not in ctype:
            self._json({"error": "expected multipart/form-data"}, 400)
            return
        boundary = ctype.split("boundary=", 1)[1].strip().strip('"')

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            audio = _extract_file(body, boundary)
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"bad request: {e}"}, 400)
            return

        if not audio:
            self._json({"error": "no file"}, 400)
            return

        try:
            with tempfile.TemporaryDirectory(prefix="asr_") as d:
                p = os.path.join(d, "voice.ogg")
                with open(p, "wb") as f:
                    f.write(audio)
                t0 = time.time()
                text = transcribe(p)
                dt = time.time() - t0
        except Exception as e:  # noqa: BLE001
            log.warning("transcription failed: %s", e)
            self._json({"error": f"asr failed: {e}"}, 500)
            return

        log.info("transcribed %d bytes -> %d chars in %.1fs: %s",
                 len(audio), len(text), dt, text[:80])
        self._json({"text": text})


def main() -> None:
    log.info("ASR shim on http://%s:%d model=%s device=%s", HOST, PORT, WHISPER_MODEL, WHISPER_DEVICE)
    try:
        _get_model()  # прогрев до приёма запросов (иначе первый запрос > таймаута 15с)
        log.info("whisper ready")
    except Exception as e:  # noqa: BLE001
        log.warning("whisper preload failed (%s) — попробую при первом запросе", e)
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
