"""Собирает единый референс для клонирования из множества клипов voice-ref\\*.
Загружает все аудио, обрезает тишину по краям, склеивает в _reference.wav (моно).

Запуск (из venv): .venv-xtts\\Scripts\\python.exe make_reference.py
"""
import glob
import os

import librosa
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
REF_DIR = os.path.join(HERE, "voice-ref")
SR = 22050
GAP = np.zeros(int(SR * 0.25), dtype=np.float32)  # 0.25с тишины между клипами

exts = ("*.mp3", "*.wav", "*.m4a", "*.ogg", "*.m4r", "*.flac")
files = []
for e in exts:
    files += glob.glob(os.path.join(REF_DIR, e))
files = sorted(f for f in files if not os.path.basename(f).startswith("_"))
print(f"Найдено клипов: {len(files)}")

chunks, used, total_s = [], 0, 0.0
for f in files:
    try:
        y, _ = librosa.load(f, sr=SR, mono=True)
        y, _ = librosa.effects.trim(y, top_db=30)  # срезать тишину по краям
        if len(y) < int(SR * 0.2):  # короче 0.2с — пропускаем
            continue
        # лёгкая нормализация громкости
        peak = float(np.max(np.abs(y))) or 1.0
        y = (y / peak) * 0.95
        chunks.append(y.astype(np.float32))
        chunks.append(GAP)
        used += 1
        total_s += len(y) / SR
    except Exception as ex:  # noqa: BLE001
        print(f"  пропуск {os.path.basename(f)}: {ex}")

if not chunks:
    raise SystemExit("Не удалось прочитать ни одного клипа.")

out = np.concatenate(chunks)
out_path = os.path.join(REF_DIR, "_reference.wav")
sf.write(out_path, out, SR)
print(f"Использовано клипов: {used}")
print(f"Длина референса: {total_s:.1f}с чистой речи")
print(f"Сохранено: {out_path}")
