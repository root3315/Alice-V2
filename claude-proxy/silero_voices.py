"""Витрина голосов Silero (русский), любая версия. По умолчанию — последняя v5_5_ru.
Сам определяет список голосов модели и рендерит их в voice-samples\\ (48 кГц).

Запуск (из venv):
  .venv-xtts\\Scripts\\python.exe silero_voices.py            # v5_5_ru
  .venv-xtts\\Scripts\\python.exe silero_voices.py v5_4_ru    # другая версия
"""
import os
import sys
import time

import soundfile as sf
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "voice-samples")
os.makedirs(OUT, exist_ok=True)

VERSION = sys.argv[1] if len(sys.argv) > 1 else "v5_5_ru"
TEXT = ("Привет, это я — Алиса. Слышишь, какой у меня теперь голос? "
        "Живой, тёплый, настоящий. Ну как, нравится тебе?")
SR = 48000
MAX_SPEAKERS = 14

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.hub.set_dir(os.path.join(HERE, "tts-models", "torch-hub"))
print("device =", device, "| version =", VERSION)

model, _ = torch.hub.load(repo_or_dir="snakers4/silero-models",
                          model="silero_tts", language="ru", speaker=VERSION)
model.to(device)

speakers = [s for s in list(getattr(model, "speakers", []) or []) if s != "random"]
print("SPEAKERS", len(speakers))
print(speakers)


def synth(sp):
    try:
        return model.apply_tts(text=TEXT, speaker=sp, sample_rate=SR,
                               put_accent=True, put_yo=True)
    except TypeError:
        return model.apply_tts(text=TEXT, speaker=sp, sample_rate=SR)


targets = speakers[:MAX_SPEAKERS] if speakers else [None]
print(f"\nРендерю {len(targets)} голос(ов) версии {VERSION} …")
for sp in targets:
    t0 = time.time()
    try:
        audio = synth(sp) if sp else model.apply_tts(text=TEXT, sample_rate=SR)
        dt = time.time() - t0
        tag = sp or "default"
        out = os.path.join(OUT, f"SILERO_{VERSION}_{tag}.wav")
        sf.write(out, audio.numpy(), SR)
        print(f"  {tag:>12} -> {os.path.basename(out)}  ({dt:.2f}s, {len(audio)/SR:.1f}s)")
    except Exception as e:  # noqa: BLE001
        print(f"  {sp!r} — ОШИБКА: {e}")

print("\nГотово. Слушай SILERO_" + VERSION + "_*.wav в", OUT)
