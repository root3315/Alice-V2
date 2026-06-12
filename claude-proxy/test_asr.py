"""Сквозной тест ASR-шима: POST аудио на /v1/audio/transcriptions (multipart) → текст.
Ровно то, что делает Alice (runtime/src/llm/asr.ts).

Запуск (шим на :5124):  python test_asr.py [path-to-audio]
"""
import json
import os
import sys
import urllib.request
import uuid

URL = "http://127.0.0.1:5124/v1/audio/transcriptions"
HERE = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    HERE, "voice-ref", "i39m-watching-a-movie-plot-story.mp3")

with open(path, "rb") as f:
    audio = f.read()

boundary = "----alice" + uuid.uuid4().hex
CRLF = b"\r\n"
fname = os.path.basename(path).encode("utf-8")
body = (
    b"--" + boundary.encode() + CRLF +
    b'Content-Disposition: form-data; name="file"; filename="' + fname + b'"' + CRLF +
    b"Content-Type: application/octet-stream" + CRLF + CRLF +
    audio + CRLF +
    b"--" + boundary.encode() + CRLF +
    b'Content-Disposition: form-data; name="model"' + CRLF + CRLF +
    b"whisper-1" + CRLF +
    b"--" + boundary.encode() + b"--" + CRLF
)

req = urllib.request.Request(URL, data=body, headers={
    "Content-Type": "multipart/form-data; boundary=" + boundary,
    "Authorization": "Bearer dummy",
})
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.loads(resp.read())

print("FILE:", os.path.basename(path))
print("RESULT:", data.get("text") if isinstance(data, dict) else data)
