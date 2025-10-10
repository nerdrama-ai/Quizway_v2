"""
LaTeX OCR microservice for Quizway
Runs pix2tex (LaTeX-OCR) model locally and exposes a simple HTTP API.

Endpoint:
  POST /predict  -> expects an image file (PNG/JPG), returns LaTeX text.
"""

import io
import asyncio
import logging
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image

app = FastAPI(title="Quizway LaTeX OCR Service")
logger = logging.getLogger("latex_ocr_service")

# Lazy-load pix2tex model
HAS_PIX2TEX = False
latex_model = None
try:
    from pix2tex.cli import LatexOCR
    HAS_PIX2TEX = True
except Exception:
    logger.error("pix2tex not installed — please install pix2tex[api] and torch.")


@app.on_event("startup")
async def load_model():
    global latex_model
    if not HAS_PIX2TEX:
        return
    logger.info("Loading LaTeX OCR model (this may take up to a minute)...")
    latex_model = await asyncio.to_thread(LatexOCR)
    logger.info("LaTeX OCR model ready.")


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if latex_model is None:
        return JSONResponse({"success": False, "error": "Model not loaded"}, status_code=500)
    try:
        contents = await file.read()
        img = Image.open(io.BytesIO(contents)).convert("RGB")
        result = await asyncio.to_thread(latex_model, img)
        if isinstance(result, (list, tuple)):
            result = result[0] if result else ""
        return {"success": True, "latex": result.strip()}
    except Exception as e:
        logger.exception("Prediction failed: %s", e)
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("latex_ocr_service:app", host="0.0.0.0", port=8502)
