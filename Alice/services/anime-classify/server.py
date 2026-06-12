"""
AnimeIDF 分类微服务 -- 判断图片是否为动漫/插画风格。

使用 anime-identify 库（ONNX 模型，~40MB，首次启动自动下载）。
返回 anime 概率分数 (0-100)，>50 为动漫，<50 为真实照片。

@see https://github.com/TelechaBot/anime-identify
@see docs/adr/153-sticker-palette-phase3-group-learning.md §D2
"""

import io
import logging
from contextlib import asynccontextmanager

from anime_identify import AnimeIDF
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("anime-classify")

# anime-identify 模型（进程级单例）
_classifier: AnimeIDF | None = None


def get_classifier() -> AnimeIDF:
    global _classifier
    if _classifier is None:
        log.info("Loading AnimeIDF model...")
        _classifier = AnimeIDF()
        log.info("AnimeIDF model loaded")
    return _classifier


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时预加载模型
    get_classifier()
    yield


app = FastAPI(title="AnimeIDF Classify", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/classify")
def classify(file: UploadFile = File(...)):
    """
    接收图片文件，返回动漫分类结果。

    同步 endpoint — FastAPI 自动放入线程池执行，不阻塞 event loop。
    predict_image 是 CPU-bound ONNX 推理（~10-50ms），适合线程池。

    返回:
      - anime: bool — 是否为动漫/插画风格
      - score: float — 动漫概率分数 (0-100)，>50 为动漫
    """
    try:
        data = file.file.read()
        classifier = get_classifier()
        # predict_image 接受 IO 对象，返回 float (0-100)
        # >50 = 动漫/插画，<50 = 真实照片
        score = classifier.predict_image(io.BytesIO(data))
        return {"anime": score > 50, "score": score}
    except Exception as e:
        log.error(f"Classification failed: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("PORT", "39101"))
    uvicorn.run(app, host="0.0.0.0", port=port)
