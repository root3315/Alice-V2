"""Smoke-тест XTTS-v2: загрузка модели + синтез русской фразы → xtts-test.wav.
Запуск (из venv): .venv-xtts\Scripts\python.exe xtts_test.py
"""
import os
import time

import tts_proxy as t

print("TTS_HOME =", os.environ.get("TTS_HOME"))
print("device   =", t.XTTS_DEVICE, "| speaker =", t.XTTS_SPEAKER)

m = t._get_xtts()
sp = t._xtts_speakers()
print("SPEAKERS", len(sp))
print(sp)

text = "Привет! Это проверка живого голоса. Я Алиса, и теперь я звучу почти как человек."
t0 = time.time()
audio = t._xtts_synth(text)
dt = time.time() - t0

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xtts-test.wav")
with open(out, "wb") as f:
    f.write(audio)
print("SYNTH_OK %d bytes in %.1fs -> %s" % (len(audio), dt, out))
