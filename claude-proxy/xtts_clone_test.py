"""Тест клона на XTTS с разной скоростью речи: голос из voice-ref/_reference.wav
озвучивает одну фразу на скоростях, чтобы выбрать комфортный темп.
→ voice-samples/CLONE_speed_*.wav

Запуск (из venv): .venv-xtts\\Scripts\\python.exe xtts_clone_test.py
"""
import os
import time

import tts_proxy as t

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "voice-ref", "_reference.wav")
OUT_DIR = os.path.join(HERE, "voice-samples")
os.makedirs(OUT_DIR, exist_ok=True)

if not os.path.exists(REF):
    raise SystemExit("Нет _reference.wav — сначала запусти make_reference.py")

PHRASE = ("Привет, это я — Алиса. Сегодня весь день шёл дождь, "
          "и я просто сидела у окна с чаем. Знаешь, иногда такая тишина — "
          "это именно то, что нужно. Ну как, нравится тебе мой голос?")

SPEEDS = [0.95]

tts = t._get_xtts()
for s in SPEEDS:
    t0 = time.time()
    out = os.path.join(OUT_DIR, f"CLONE_speed_{int(s * 100)}.wav")
    try:
        tts.tts_to_file(text=PHRASE, speaker_wav=REF, language="ru",
                        file_path=out, speed=s, split_sentences=True)
        print(f"speed {s}: {time.time() - t0:.1f}s -> {os.path.basename(out)}")
    except TypeError as e:
        print(f"speed-param не поддержан ({e}); рендерю без него")
        tts.tts_to_file(text=PHRASE, speaker_wav=REF, language="ru",
                        file_path=out, split_sentences=True)
        break

print("Готово. Слушай voice-samples/CLONE_speed_*.wav (100=обычная, 80=медленнее)")
