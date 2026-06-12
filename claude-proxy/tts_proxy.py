"""TTS → MiniMax-совместимый шим (бесплатный живой голос для Alice, без API-ключа).

Alice (runtime/src/llm/tts.ts) шлёт POST {base}/v1/t2a_v2 в формате MiniMax и ждёт
JSON {data:{audio:"<hex audio>"}, base_resp:{status_code:0}}. Дальше Alice сама
прогоняет аудио через ffmpeg (добавляет паузы в начале/конце и перекодирует в
OGG/Opus для голосового сообщения Telegram). ffmpeg определяет формат по
содержимому, не по расширению, поэтому мы можем отдавать WAV — он его примет.

Движки (TTS_PROXY_ENGINE):
  - xtts (по умолчанию): XTTS-v2 (Coqui) на локальном GPU. Живой, человеческий
    голос; встроенная библиотека из ~58 голосов + клонирование из своего образца.
    Бесплатно, без ключа. Модель грузится один раз при старте (~1.8GB, ~15-20с).
    При ЛЮБОЙ ошибке (нет GPU/модели) — автофолбэк на edge, затем gtts.
  - edge: edge-tts (Microsoft, нейронный). Хорошее качество, но на Windows в
    серверном контексте иногда NoAudioReceived. При сбое → gtts.
  - gtts: Google Translate TTS. Простой HTTPS-GET, максимально надёжно, голос
    обычный (не нейронный). Последний рубеж фолбэка.

Сервер — синхронный stdlib http.server (без uvicorn). XTTS синтезирует по одному
запросу за раз (GPU всё равно сериализует) — single-thread тут в самый раз.

Эндпоинты:
  POST /v1/t2a_v2   — синтез (MiniMax-формат), body {text: "..."}
  GET  /voices      — список встроенных голосов XTTS (для выбора XTTS_SPEAKER)
  GET  /health      — статус

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
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

log = logging.getLogger("tts_proxy")
logging.basicConfig(level=os.getenv("TTS_PROXY_LOG", "INFO"))

HOST = os.getenv("TTS_PROXY_HOST", "127.0.0.1")
PORT = int(os.getenv("TTS_PROXY_PORT", "5123"))

# xtts = живой голос на GPU (по умолчанию). edge/gtts — фолбэки. См. docstring.
ENGINE = os.getenv("TTS_PROXY_ENGINE", "xtts").lower()  # xtts | edge | gtts

# ── XTTS-v2 (Coqui) ──────────────────────────────────────────────────────────
# Кэш модели держим рядом со скриптом (gitignored), чтобы не плодить копии.
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("TTS_HOME", os.path.join(_HERE, "tts-models"))
# Экономная CUDA-аллокация: меньше фрагментации/резерва VRAM (важно — делим 8GB GPU
# с whisper). Должно стоять ДО инициализации torch.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# CPML-лицензия XTTS требует подтверждения. Без этого библиотека ждёт ввод с
# клавиатуры и сервер зависает — поэтому подтверждаем заранее (личное исп-е).
os.environ.setdefault("COQUI_TOS_AGREED", "1")

XTTS_MODEL = os.getenv("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
XTTS_LANG = os.getenv("XTTS_LANG", "ru")
XTTS_DEVICE = os.getenv("XTTS_DEVICE", "cuda")  # cuda | cpu
# Встроенный голос (имя из /voices). Если задан XTTS_SPEAKER_WAV — клонируем его.
XTTS_SPEAKER = os.getenv("XTTS_SPEAKER", "Tammie Ema")
# Путь к WAV-образцу (6-30с чистой речи) для клонирования. Перебивает XTTS_SPEAKER.
XTTS_SPEAKER_WAV = os.getenv("XTTS_SPEAKER_WAV", "").strip()
# Скорость речи: 1.0 = обычная, <1.0 медленнее/спокойнее (напр. 0.95), >1.0 быстрее.
XTTS_SPEED = float(os.getenv("XTTS_SPEED", "1.0"))

# ── edge-tts (фолбэк) ────────────────────────────────────────────────────────
GTTS_LANG = os.getenv("TTS_PROXY_LANG", "ru")
EDGE_VOICE = os.getenv("TTS_PROXY_VOICE", "ru-RU-SvetlanaNeural")
EDGE_RATE = os.getenv("TTS_PROXY_RATE", "+0%")
EDGE_PITCH = os.getenv("TTS_PROXY_PITCH", "+15Hz")
EDGE_RETRIES = int(os.getenv("TTS_PROXY_RETRIES", "2"))

_xtts = None
_xtts_lock = threading.Lock()


def _get_xtts():
    """Лениво (один раз) грузим XTTS-v2 в VRAM. Потокобезопасно."""
    global _xtts
    if _xtts is None:
        with _xtts_lock:
            if _xtts is None:
                from TTS.api import TTS  # тяжёлый импорт — только при движке xtts

                t0 = time.time()
                log.info("loading XTTS-v2 (%s) on %s …", XTTS_MODEL, XTTS_DEVICE)
                _xtts = TTS(XTTS_MODEL).to(XTTS_DEVICE)
                log.info("XTTS-v2 loaded in %.1fs", time.time() - t0)
    return _xtts


def _xtts_speakers() -> list[str]:
    """Имена встроенных голосов модели (для /voices и валидации XTTS_SPEAKER)."""
    try:
        tts = _get_xtts()
        sm = getattr(tts.synthesizer.tts_model, "speaker_manager", None)
        if sm is None:
            return []
        names = getattr(sm, "name_to_id", None) or getattr(sm, "speakers", None) or {}
        return sorted(names.keys())
    except Exception as e:  # noqa: BLE001
        log.warning("cannot list xtts speakers: %s", e)
        return []


def _free_vram() -> None:
    """Возвращаем GPU неиспользуемый кэш PyTorch после синтеза — иначе XTTS держит
    ~7GB зарезервированными и whisper'у на той же 8GB-карте не остаётся места."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _xtts_synth(text: str) -> bytes:
    tts = _get_xtts()
    with tempfile.TemporaryDirectory(prefix="xtts_") as d:
        out = os.path.join(d, "out.wav")
        kwargs = {
            "text": text,
            "language": XTTS_LANG,
            "file_path": out,
            "split_sentences": True,
            "speed": XTTS_SPEED,
        }
        if XTTS_SPEAKER_WAV and os.path.exists(XTTS_SPEAKER_WAV):
            kwargs["speaker_wav"] = XTTS_SPEAKER_WAV
        else:
            kwargs["speaker"] = XTTS_SPEAKER
        tts.tts_to_file(**kwargs)
        with open(out, "rb") as f:
            data = f.read()
    _free_vram()
    return data


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


def synthesize(text: str) -> tuple[bytes, str]:
    """Возвращает (аудио-байты, формат). Формат — для метаданных; ffmpeg у Alice
    определяет реальный контейнер сам."""
    if ENGINE == "xtts":
        try:
            return _xtts_synth(text), "wav"
        except Exception as e:  # noqa: BLE001
            log.warning("xtts failed (%s) → fallback edge", str(e)[-160:])
    if ENGINE in ("xtts", "edge"):
        try:
            return _edge_synth(text), "mp3"
        except Exception as e:  # noqa: BLE001
            log.warning("edge-tts failed (%s) → fallback gTTS", str(e)[-100:])
    return _gtts_synth(text), "mp3"


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
        path = self.path.split("?")[0]
        if path == "/health":
            self._json({"status": "ok", "engine": ENGINE,
                        "speaker": XTTS_SPEAKER_WAV or XTTS_SPEAKER, "lang": XTTS_LANG})
        elif path == "/voices":
            self._json({"engine": ENGINE, "current": XTTS_SPEAKER_WAV or XTTS_SPEAKER,
                        "voices": _xtts_speakers()})
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
            t0 = time.time()
            audio, fmt = synthesize(text)
            dt = time.time() - t0
        except Exception as e:  # noqa: BLE001
            log.warning("synth failed: %s", e)
            self._json({"base_resp": {"status_code": 1, "status_msg": f"tts failed: {e}"}})
            return

        log.info("synthesized %d chars -> %d bytes %s in %.1fs (engine=%s)",
                 len(text), len(audio), fmt, dt, ENGINE)
        self._json({
            "data": {"audio": audio.hex(), "status": 2},
            "extra_info": {"audio_format": fmt, "audio_length": len(audio)},
            "base_resp": {"status_code": 0, "status_msg": "success"},
        })


def main() -> None:
    log.info("TTS shim on http://%s:%d engine=%s", HOST, PORT, ENGINE)
    if ENGINE == "xtts":
        # Прогреваем модель ДО приёма запросов, чтобы первый запрос Alice не упёрся
        # в таймаут (загрузка в VRAM ~15-20с). Если упадёт — синтез уйдёт в фолбэк.
        try:
            _get_xtts()
            log.info("XTTS ready, voices=%d, speaker=%s",
                     len(_xtts_speakers()), XTTS_SPEAKER_WAV or XTTS_SPEAKER)
        except Exception as e:  # noqa: BLE001
            log.warning("XTTS preload failed (%s) — буду фолбэчить на edge/gtts", e)
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
