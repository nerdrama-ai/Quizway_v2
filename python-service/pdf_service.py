# pdf_service.py
"""
Quizway PDF Extraction Service (Lightweight)

Endpoints:
- POST /extract-text      -> Basic text extraction (compatible with older version)
- POST /extract-advanced  -> Extracts text + formulas + embedded images and calls LaTeX OCR microservice.

Notes:
- This service focuses only on PDF parsing and OCR detection.
- All heavy math OCR (pix2tex) runs in a separate 'latex-ocr-service' microservice.
- Requires: tesseract and poppler-utils installed in the environment.
"""

import os
import io
import re
import base64
import logging
from uuid import uuid4
from typing import List, Dict, Any
import asyncio

from fastapi import FastAPI, File, UploadFile, HTTPException
import uvicorn

# PDF/text/image libs
import PyPDF2
import pdfplumber
from pdf2image import convert_from_bytes
from PIL import Image
import pytesseract
import requests
import unicodedata

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pdf_service")

# Environment / limits
MAX_FILE_SIZE_BYTES = int(os.getenv("MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024))  # 50 MB
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", 80))  # Max 80 pages
PAGE_IMAGE_DPI = int(os.getenv("PAGE_IMAGE_DPI", 150))
TEMP_DIR = os.getenv("PDF_SERVICE_TMP_DIR", "/tmp")

# External OCR endpoint (from Render env var)
LATEX_OCR_URL = os.getenv("LATEX_OCR_URL", "http://localhost:8502/predict")

os.makedirs(TEMP_DIR, exist_ok=True)
app = FastAPI(title="Quizway PDF Extraction Service")


# ---------------------------
# Text normalization helpers
# ---------------------------
def fix_mojibake(s: str) -> str:
    if not s:
        return s
    s = s.replace("\u00A0", " ").replace("\u200b", "").replace("\ufeff", "")
    if "Ã" in s or "Â" in s or "\ufffd" in s:
        try:
            candidate = s.encode("latin-1", errors="ignore").decode("utf-8", errors="replace")
            if candidate.count("\ufffd") < s.count("\ufffd"):
                s = candidate
        except Exception:
            pass
    try:
        s = unicodedata.normalize("NFKC", s)
    except Exception:
        pass
    s = re.sub(r"[\uFFFD\x00-\x1F\x7F]", "", s)
    s = re.sub(r"[\u0300-\u036f]", "", s)
    s = s.replace("Â", "")
    return s


def collapse_letter_gaps(s: str) -> str:
    if not s:
        return s
    s = s.replace("\u200b", "").replace("\ufeff", "").replace("\uFFFD", "")
    tokens = re.split(r'(\s+)', s)
    out_tokens, i = [], 0
    while i < len(tokens):
        tok = tokens[i]
        if re.fullmatch(r"[A-Za-z]", tok):
            run = [tok]
            j = i + 1
            while j + 1 < len(tokens) and re.fullmatch(r'\s+', tokens[j]) and re.fullmatch(r'[A-Za-z]', tokens[j+1]):
                run.append(tokens[j+1])
                j += 2
            if len(run) >= 3:
                out_tokens.append("".join(run))
                i = j
                continue
        out_tokens.append(tok)
        i += 1
    return "".join(out_tokens)


def normalize_text(s: str) -> str:
    if not s:
        return s
    s = s.replace("\x00", "").replace("\xa0", " ")
    s = fix_mojibake(s)
    s = collapse_letter_gaps(s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


# ---------------------------
# Formula detection + OCR relay
# ---------------------------
def is_likely_formula(ocr_text: str) -> bool:
    if not ocr_text:
        return False
    txt = ocr_text.strip()
    math_symbols = set("=√∑∫π×÷^_()[]{}+-/\\<>|∞≤≥≈·")
    sym_count = sum(1 for c in txt if c in math_symbols)
    sym_ratio = sym_count / max(1, len(txt))
    alpha_count = sum(1 for c in txt if c.isalpha())
    alpha_ratio = alpha_count / max(1, len(txt))
    keywords = ["frac", "sqrt", "lim", "sum", "int", "\\frac", "\\sqrt", "\\int", "sigma", "beta", "alpha", "mu", "="]
    if any(k in txt.lower() for k in keywords):
        return True
    if sym_ratio > 0.05 and alpha_ratio < 0.9:
        return True
    if len(txt) < 200 and sym_count >= 2:
        return True
    return False


def call_latex_ocr_service(image_path: str, timeout: int = 20) -> str:
    """
    Sends image to LaTeX OCR microservice and returns the LaTeX string.
    """
    try:
        with open(image_path, "rb") as f:
            files = {"file": f}
            r = requests.post(LATEX_OCR_URL, files=files, timeout=timeout)
            if r.status_code == 200:
                data = r.json()
                if data.get("success") and data.get("latex"):
                    return data["latex"].strip()
    except Exception as e:
        logger.warning(f"LaTeX OCR service call failed: {e}")
    return None


# ---------------------------
# Core endpoints
# ---------------------------
@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    """
    Simple text extraction only.
    """
    try:
        file_bytes = await file.read()
        if not file_bytes:
            return {"success": False, "error": "Empty file"}
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        raw_pages = []
        try:
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                for p in pdf.pages:
                    page_text = p.extract_text() or ""
                    raw_pages.append(page_text)
            raw_text = "\n\n".join(raw_pages)
        except Exception:
            reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
            parts = [(p.extract_text() or "") for p in reader.pages]
            raw_text = "\n\n".join(parts)

        cleaned = normalize_text(raw_text)
        return {"success": True, "text": cleaned, "length": len(cleaned)}

    except Exception as e:
        logger.exception("extract-text error: %s", e)
        return {"success": False, "error": str(e)}


@app.post("/extract-advanced")
async def extract_advanced(file: UploadFile = File(...)):
    """
    Advanced structured extraction (text + OCR + formulas + embedded images).
    """
    tmp_files_to_cleanup: List[str] = []
    try:
        file_bytes = await file.read()
        if not file_bytes:
            return {"success": False, "error": "Empty file"}
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        pages_out, attachments = [], []

        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            total_pages = len(pdf.pages)
            if total_pages > MAX_PDF_PAGES:
                raise HTTPException(status_code=413, detail=f"Too many pages: {total_pages}")

            logger.info(f"Processing {total_pages} pages at {PAGE_IMAGE_DPI} DPI")

            for idx, p in enumerate(pdf.pages):
                page_num = idx + 1
                page_width, page_height = p.width, p.height
                words = p.extract_words(x_tolerance=3, y_tolerance=3) or []

                lines_dict: Dict[int, List[Dict[str, Any]]] = {}
                for w in words:
                    top_key = int(round(w.get("top", 0)))
                    lines_dict.setdefault(top_key, []).append(w)

                line_items = []
                for top in sorted(lines_dict.keys()):
                    row = sorted(lines_dict[top], key=lambda x: x.get("x0", 0))
                    text_line = " ".join([normalize_text(str(x.get("text", ""))) for x in row])
                    if text_line.strip():
                        line_items.append({"type": "text", "text": text_line, "top": top, "x0": row[0].get("x0", 0)})

                # Render page image
                page_image = None
                try:
                    pil_pages = convert_from_bytes(file_bytes, dpi=PAGE_IMAGE_DPI, first_page=page_num, last_page=page_num)
                    if pil_pages:
                        page_image = pil_pages[0].convert("RGB")
                except Exception as e:
                    logger.warning(f"Page {page_num}: failed to render to image ({e})")

                # Extract embedded images
                image_blocks: List[Dict[str, Any]] = []
                pdf_images = getattr(p, "images", None) or []
                if page_image and pdf_images:
                    for img_idx, img_obj in enumerate(pdf_images):
                        x0 = img_obj.get("x0", 0)
                        top = img_obj.get("top", 0)
                        x1 = img_obj.get("x1", x0 + img_obj.get("width", 0))
                        bottom = img_obj.get("bottom", top + img_obj.get("height", 0))
                        try:
                            scale_x = page_image.width / max(1.0, page_width)
                            scale_y = page_image.height / max(1.0, page_height)
                            left = int(round(x0 * scale_x))
                            upper = int(round(top * scale_y))
                            right = int(round(x1 * scale_x))
                            lower = int(round(bottom * scale_y))
                            if right - left > 4 and lower - upper > 4:
                                crop = page_image.crop((left, upper, right, lower))
                                fname = f"page{page_num}_img{img_idx}_{uuid4().hex}.png"
                                tmp_path = os.path.join(TEMP_DIR, fname)
                                crop.save(tmp_path, format="PNG")
                                tmp_files_to_cleanup.append(tmp_path)

                                # OCR and formula detection
                                try:
                                    ocr_text = pytesseract.image_to_string(crop)
                                    ocr_text = normalize_text(ocr_text)
                                except Exception:
                                    ocr_text = ""

                                latex = None
                                block_like = False
                                if is_likely_formula(ocr_text):
                                    rel_h = (lower - upper) / max(1.0, page_image.height)
                                    block_like = rel_h > 0.08
                                    latex = await asyncio.to_thread(call_latex_ocr_service, tmp_path)

                                with open(tmp_path, "rb") as fh:
                                    b64 = base64.b64encode(fh.read()).decode()
                                attachments.append({
                                    "filename": fname,
                                    "mimetype": "image/png",
                                    "base64": b64,
                                    "ocr_text": ocr_text,
                                    "latex": latex,
                                    "block": block_like,
                                })
                                image_blocks.append({
                                    "type": "image",
                                    "filename": fname,
                                    "top": top,
                                    "x0": x0,
                                    "x1": x1,
                                    "bottom": bottom,
                                    "ocr_text": ocr_text,
                                    "latex": latex,
                                    "block": block_like,
                                })
                        except Exception as e:
                            logger.warning(f"Failed to crop image on page {page_num}: {e}")

                combined_blocks = sorted(line_items + image_blocks, key=lambda b: (b.get("top", 0), b.get("x0", 0)))
                pages_out.append({"page": page_num, "blocks": combined_blocks})

        # Flattened text output
        flattened_segments: List[str] = []
        math_index = 1
        for p in pages_out:
            for b in p["blocks"]:
                if b["type"] == "text":
                    flattened_segments.append(b.get("text", ""))
                elif b["type"] == "image":
                    fname = b.get("filename")
                    att = next((a for a in attachments if a["filename"] == fname), None)
                    if att and att.get("latex"):
                        key = f"latex_{math_index}"
                        tag = f"[MATHBLOCK:{key}]" if att.get("block") else f"[MATH:{key}]"
                        flattened_segments.append(tag)
                        att["latex_key"] = key
                        math_index += 1
                    else:
                        flattened_segments.append(f"[IMG:{fname}]")
            flattened_segments.append("\n")

        flattened_text = "\n".join(flattened_segments)
        cleaned_text = normalize_text(flattened_text)

        # Cleanup
        for fpath in tmp_files_to_cleanup:
            try:
                if os.path.exists(fpath):
                    os.remove(fpath)
            except Exception:
                pass

        return {
            "success": True,
            "text": cleaned_text,
            "length": len(cleaned_text),
            "pages": pages_out,
            "attachments": attachments,
        }

    except Exception as e:
        logger.exception("extract-advanced error: %s", e)
        for f in tmp_files_to_cleanup:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000)
