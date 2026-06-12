"""Smoke-тест ASR: грузит whisper и распознаёт указанный аудиофайл.
Запуск (из venv): .venv-xtts\\Scripts\\python.exe asr_test.py [path-to-audio]
По умолчанию берёт voice-samples/ALICE_shim_test.wav (известный текст для проверки точности).
"""
import os
import sys
import time

import asr_proxy as a

HERE = os.path.dirname(os.path.abspath(__file__))
audio = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "voice-samples", "ALICE_shim_test.wav")
print("audio  =", audio)
print("model  =", a.WHISPER_MODEL, "| device =", a.WHISPER_DEVICE, "/", a.WHISPER_COMPUTE)

t0 = time.time()
a._get_model()
print("load: %.1fs" % (time.time() - t0))

t0 = time.time()
text = a.transcribe(audio)
print("transcribe: %.1fs" % (time.time() - t0))
print("TEXT:", text)
