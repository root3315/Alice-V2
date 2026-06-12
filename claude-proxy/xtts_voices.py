"""Витрина голосов XTTS-v2: список + рендер образцов, чтобы выбрать голос Алисе.

Использование (из venv с XTTS):
  python xtts_voices.py                 # просто список встроенных голосов
  python xtts_voices.py --sample        # отрендерить образец КАЖДОГО голоса в voice-samples/
  python xtts_voices.py --sample "своя фраза"   # с своим текстом
  python xtts_voices.py --only "Tammie Ema" "Daisy Studious"   # только эти голоса

После рендера открой папку voice-samples\ , послушай *.wav, выбери понравившийся и
скажи мне имя — я пропишу XTTS_SPEAKER в .env-tts. (Или дай свой WAV-образец 6-30с
чистой речи — тогда склонируем твой голос через XTTS_SPEAKER_WAV.)
"""
from __future__ import annotations

import os
import sys

import tts_proxy  # переиспользуем конфиг (TTS_HOME, модель, COQUI_TOS_AGREED) и загрузчик

SAMPLE_TEXT = (
    "Привет, это я — Алиса. Слышишь, какой у меня теперь голос? "
    "Живой, тёплый, настоящий. Ну как, нравится тебе?"
)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice-samples")


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip()


def main() -> None:
    args = sys.argv[1:]
    do_sample = "--sample" in args
    text = SAMPLE_TEXT
    only: list[str] = []

    # --sample [текст]
    if do_sample:
        i = args.index("--sample")
        if i + 1 < len(args) and not args[i + 1].startswith("--"):
            text = args[i + 1]
    # --only имя1 имя2 ...
    if "--only" in args:
        only = [a for a in args[args.index("--only") + 1:] if not a.startswith("--")]

    speakers = tts_proxy._xtts_speakers()
    if not speakers:
        print("Не удалось получить список голосов (модель не загрузилась?).")
        return

    print(f"Встроенных голосов: {len(speakers)}\n")
    for i, s in enumerate(speakers, 1):
        print(f"{i:>3}. {s}")

    if not do_sample:
        print("\nЗапусти с --sample, чтобы отрендерить образцы в voice-samples\\")
        return

    targets = [s for s in speakers if (not only or s in only)]
    os.makedirs(OUT_DIR, exist_ok=True)
    tts = tts_proxy._get_xtts()
    print(f"\nРендерю {len(targets)} образц(ов) в {OUT_DIR} …")
    for i, s in enumerate(targets, 1):
        out = os.path.join(OUT_DIR, f"{i:02d}_{_safe(s)}.wav")
        try:
            tts.tts_to_file(text=text, speaker=s, language=tts_proxy.XTTS_LANG,
                            file_path=out, split_sentences=True)
            print(f"  [{i}/{len(targets)}] {s} -> {os.path.basename(out)}")
        except Exception as e:  # noqa: BLE001
            print(f"  [{i}/{len(targets)}] {s} — ОШИБКА: {e}")
    print(f"\nГотово. Открой {OUT_DIR}, послушай и скажи имя понравившегося голоса.")


if __name__ == "__main__":
    main()
