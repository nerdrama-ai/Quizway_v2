# pdf_service.py
"""
Advanced PDF extraction microservice (improved).

Endpoints:
- POST /extract-text      -> Backwards-compatible text extraction (keeps old behavior).
- POST /extract-advanced  -> Returns rich JSON { text, pages, attachments } with images, OCR and optional LaTeX.

Notes:
- Requires system packages: tesseract and poppler-utils (for pdf2image).
- Attachments contain base64 image data. If you want S3 uploads performed here, we can add that later.
- This file intentionally tolerates missing optional libraries (e.g. layoutparser) and falls back gracefully.
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
import tempfile
import shutil

# Optional: layoutparser (if available)
try:
    import layoutparser as lp  # type: ignore
    HAS_LAYOUTPARSER = True
except Exception:
    HAS_LAYOUTPARSER = False

# Optional: pix2tex (LaTeX-OCR) integration
HAS_PIX2TEX = False
latex_model = None
try:
    # Do not import at top-level if we might not have torch installed in some environments.
    from pix2tex.cli import LatexOCR  # type: ignore
    HAS_PIX2TEX = True
except Exception:
    HAS_PIX2TEX = False

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pdf_service")

# Environment / limits
MAX_FILE_SIZE_BYTES = int(os.getenv("MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024))  # 50 MB default
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", 80))  # 80 pages default (tweakable)
PAGE_IMAGE_DPI = int(os.getenv("PAGE_IMAGE_DPI", 150))  # DPI used when rendering pages
TEMP_DIR = os.getenv("PDF_SERVICE_TMP_DIR", "/tmp")

MATHPIX_API_KEY = os.getenv("MATHPIX_API_KEY")
MATHPIX_APP_ID = os.getenv("MATHPIX_APP_ID")
MATHPIX_APP_KEY = os.getenv("MATHPIX_APP_KEY")

# Ensure tmp dir exists
os.makedirs(TEMP_DIR, exist_ok=True)

app = FastAPI(title="Quizway PDF Service (advanced, improved)")

# ---------------------------
# Text normalization helpers
# ---------------------------
def fix_mojibake(s: str) -> str:
    if not s:
        return s
    s = s.replace("\u00A0", " ")
    s = s.replace("\u200b", "")
    s = s.replace("\ufeff", "")
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
    s = s.replace("\u200b", "").replace("\ufeff", "")
    s = s.replace("\uFFFD", "")
    tokens = re.split(r'(\s+)', s)
    out_tokens = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.fullmatch(r"[A-Za-z]", tok):
            run = [tok]
            j = i + 1
            while j + 1 < len(tokens) and re.fullmatch(r'\s+', tokens[j]) and re.fullmatch(r'[A-Za-z]', tokens[j+1]):
                run.append(tokens[j+1])
                j += 2
            if len(run) >= 3:
                joined = "".join(run)
                out_tokens.append(joined)
                i = j
                continue
        out_tokens.append(tok)
        i += 1
    return "".join(out_tokens)


def normalize_text(s: str) -> str:
    if not s:
        return s
    s = s.replace("\x00", "")
    s = s.replace("\xa0", " ")
    s = fix_mojibake(s)
    s = collapse_letter_gaps(s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = s.strip()
    return s


# ---------------------------
# Math detection & MathPix wrapper -> now prefers pix2tex
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


# New wrapper: prefer local LaTeX-OCR (pix2tex), fallback to Mathpix API if configured.
def mathpix_recognize(image_path: str, timeout: int = 20) -> str:
    """
    Backwards-compatible wrapper:
    - If pix2tex (LaTeX-OCR) is installed and model initialized, use it synchronously here (caller should run it in a thread).
    - Otherwise, if Mathpix credentials present, call Mathpix API.
    - Returns LaTeX string on success or None on failure.
    """
    # 1) Prefer pix2tex if available
    global HAS_PIX2TEX, latex_model
    if HAS_PIX2TEX and latex_model is not None:
        try:
            img = Image.open(image_path).convert("RGB")
            # latex_model(...) returns a string (or list/tuple depending on version)
            out = latex_model(img)
            if isinstance(out, (list, tuple)):
                out = out[0] if out else None
            if isinstance(out, str):
                return out.strip()
            return None
        except Exception as e:
            logger.exception("pix2tex inference failed (falling back if possible): %s", e)
            # fall through to Mathpix fallback if configured

    # 2) Fallback: call Mathpix REST API if credentials set
    if not (MATHPIX_API_KEY or (MATHPIX_APP_ID and MATHPIX_APP_KEY)):
        return None

    logger.info("mathpix_recognize: calling Mathpix fallback")
    with open(image_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    url = "https://api.mathpix.com/v3/text"
    headers = {"Content-type": "application/json"}
    if MATHPIX_API_KEY:
        headers["Authorization"] = f"Bearer {MATHPIX_API_KEY}"
    else:
        headers["app_id"] = MATHPIX_APP_ID
        headers["app_key"] = MATHPIX_APP_KEY
    payload = {
        "src": f"data:image/png;base64,{b64}",
        "formats": ["latex_simplified", "text"],
        "ocr": {"math_inline_delimiters": [["$", "$"], ["\\(", "\\)"]]},
    }
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=timeout)
        r.raise_for_status()
        resp = r.json()
        latex = None
        if isinstance(resp, dict):
            for key in ("latex_simplified", "latex", "text"):
                val = resp.get(key)
                if isinstance(val, str) and val.strip():
                    latex = val.strip()
                    break
            if not latex and isinstance(resp.get("data"), list) and resp["data"]:
                entry = resp["data"][0]
                for key in ("latex_simplified", "latex", "text"):
                    if key in entry and isinstance(entry[key], str) and entry[key].strip():
                        latex = entry[key].strip()
                        break
        return latex
    except Exception as e:
        logger.exception("Mathpix request failed: %s", e)
        return None


# ---------------------------
# Initialize pix2tex model at startup (if available)
# ---------------------------
@app.on_event("startup")
async def load_latex_model_at_startup():
    """
    If pix2tex is installed, initialize the model on startup.
    This triggers checkpoint download (if not already cached) and keeps a singleton model instance.
    """
    global HAS_PIX2TEX, latex_model
    if not HAS_PIX2TEX:
        logger.info("pix2tex not installed — will use Mathpix fallback if configured.")
        return
    try:
        logger.info("Initializing pix2tex (LaTeX-OCR) model at startup — this may take a while (downloads) ...")
        # run model initialization off the event loop
        loop = asyncio.get_running_loop()
        latex_model = await asyncio.to_thread(LatexOCR)  # instantiate in a thread
        logger.info("pix2tex model initialized successfully.")
    except Exception as e:
        latex_model = None
        logger.exception("Failed to initialize pix2tex model at startup: %s", e)


# ---------------------------
# Core endpoints (unchanged except where we await mathpix_recognize in a thread)
# ---------------------------
@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        if not file_bytes:
            return {"success": False, "error": "Empty file"}
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        # Try pdfplumber for better extraction (line-based)
        raw_pages = []
        try:
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                for p in pdf.pages:
                    page_text = p.extract_text() or ""
                    raw_pages.append(page_text)
            raw_text = "\n\n".join(raw_pages)
        except Exception:
            # Fallback to PyPDF2
            try:
                reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
                parts = []
                for p in reader.pages:
                    parts.append(p.extract_text() or "")
                raw_text = "\n\n".join(parts)
            except Exception as inner:
                logger.exception("Both pdfplumber and PyPDF2 extraction failed: %s", inner)
                raise inner

        cleaned = normalize_text(clean_text(raw_text))
        return {"success": True, "text": cleaned, "length": len(cleaned)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("extract-text error: %s", e)
        return {"success": False, "error": str(e)}


@app.post("/extract-advanced")
async def extract_advanced(file: UploadFile = File(...)):
    tmp_files_to_cleanup: List[str] = []
    try:
        file_bytes = await file.read()
        if not file_bytes:
            return {"success": False, "error": "Empty file"}
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        pages_out = []
        attachments: List[Dict[str, Any]] = []

        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            total_pages = len(pdf.pages)
            if total_pages > MAX_PDF_PAGES:
                raise HTTPException(status_code=413, detail=f"PDF has too many pages ({total_pages} > {MAX_PDF_PAGES})")

            logger.info("Processing %d pages (dpi=%d)", total_pages, PAGE_IMAGE_DPI)

            # Convert pages to images on demand using pdf2image
            for idx, p in enumerate(pdf.pages):
                page_num = idx + 1
                page_width = p.width
                page_height = p.height

                # 1) WORD -> group into lines (more robust than raw extract_text)
                words = p.extract_words(x_tolerance=3, y_tolerance=3) or []
                # Group by rounded top coordinate
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

                # 2) Render page to image for cropping / OCR fallbacks
                page_image = None
                try:
                    pil_pages = convert_from_bytes(file_bytes, dpi=PAGE_IMAGE_DPI, first_page=page_num, last_page=page_num)
                    if pil_pages:
                        page_image = pil_pages[0].convert("RGB")
                except Exception as e:
                    logger.warning("Failed to render page %d to image: %s", page_num, e)
                    page_image = None

                # 3) Try detecting embedded images via pdfplumber page.images
                image_blocks: List[Dict[str, Any]] = []
                pdf_images = getattr(p, "images", None) or []
                if page_image and pdf_images:
                    for img_idx, img_obj in enumerate(pdf_images):
                        x0 = img_obj.get("x0") if "x0" in img_obj else img_obj.get("x")
                        top = img_obj.get("top") if "top" in img_obj else img_obj.get("y")
                        x1 = img_obj.get("x1") if "x1" in img_obj else (x0 + img_obj.get("width", 0) if x0 is not None else None)
                        bottom = img_obj.get("bottom") if "bottom" in img_obj else (top + img_obj.get("height", 0) if top is not None else None)

                        if None not in (x0, top, x1, bottom):
                            try:
                                scale_x = page_image.width / max(1.0, page_width)
                                scale_y = page_image.height / max(1.0, page_height)
                                left = int(max(0, round(x0 * scale_x)))
                                upper = int(max(0, round(top * scale_y)))
                                right = int(min(page_image.width, round(x1 * scale_x)))
                                lower = int(min(page_image.height, round(bottom * scale_y)))
                                if right - left > 4 and lower - upper > 4:
                                    crop = page_image.crop((left, upper, right, lower))
                                    unique = uuid4().hex
                                    fname = f"page{page_num}_img{img_idx}_{unique}.png"
                                    tmp_path = os.path.join(TEMP_DIR, fname)
                                    crop.save(tmp_path, format="PNG")
                                    tmp_files_to_cleanup.append(tmp_path)

                                    # OCR the crop
                                    try:
                                        ocr_text = pytesseract.image_to_string(crop)
                                        ocr_text = normalize_text(ocr_text)
                                    except Exception:
                                        ocr_text = ""

                                    # Decide if this is a formula and optionally try LaTeX-OCR (pix2tex) or Mathpix
                                    latex = None
                                    block_like = False
                                    if is_likely_formula(ocr_text):
                                        rel_h = (lower - upper) / max(1.0, page_image.height)
                                        block_like = rel_h > 0.08  # heuristic threshold
                                        # call the recognition wrapper in a thread (non-blocking)
                                        try:
                                            latex = await asyncio.to_thread(mathpix_recognize, tmp_path)
                                        except Exception:
                                            latex = None

                                    with open(tmp_path, "rb") as fh:
                                        b64 = base64.b64encode(fh.read()).decode()
                                    attachments.append({
                                        "filename": fname,
                                        "mimetype": "image/png",
                                        "base64": b64,
                                        "ocr_text": ocr_text,
                                        "latex": latex,
                                        "block": bool(block_like),
                                        "temp_path": tmp_path,
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
                                        "block": bool(block_like),
                                        "temp_path": tmp_path,
                                    })
                            except Exception as e:
                                logger.exception("Failed to crop embedded image on page %d: %s", page_num, e)

                # 4) If page has little or no textual content, keep a page-level image (for scanned PDFs)
                full_page_included = False
                if page_image and (len(line_items) == 0 or len(image_blocks) > 0):
                    try:
                        unique = uuid4().hex
                        fname = f"page{page_num}_full_{unique}.png"
                        tmp_path = os.path.join(TEMP_DIR, fname)
                        page_image.save(tmp_path, format="PNG")
                        tmp_files_to_cleanup.append(tmp_path)
                        try:
                            page_ocr = pytesseract.image_to_string(page_image)
                            page_ocr = normalize_text(page_ocr)
                        except Exception:
                            page_ocr = ""
                        latex = None
                        block_like = False
                        if is_likely_formula(page_ocr):
                            block_like = True
                            try:
                                latex = await asyncio.to_thread(mathpix_recognize, tmp_path)
                            except Exception:
                                latex = None
                        with open(tmp_path, "rb") as fh:
                            b64 = base64.b64encode(fh.read()).decode()
                        attachments.append({
                            "filename": fname,
                            "mimetype": "image/png",
                            "base64": b64,
                            "ocr_text": page_ocr,
                            "latex": latex,
                            "block": bool(block_like),
                            "temp_path": tmp_path,
                        })
                        image_blocks.insert(0, {
                            "type": "image",
                            "filename": fname,
                            "top": 0,
                            "x0": 0,
                            "x1": page_width,
                            "bottom": page_height,
                            "ocr_text": page_ocr,
                            "latex": latex,
                            "block": bool(block_like),
                            "temp_path": tmp_path,
                        })
                        full_page_included = True
                    except Exception as e:
                        logger.exception("Failed to save page image for page %d: %s", page_num, e)

                # 5) Combine line text blocks and image blocks into page blocks ordered by reading order
                combined_blocks = []
                combined_blocks.extend(line_items)
                combined_blocks.extend(image_blocks)
                combined_blocks.sort(key=lambda b: (b.get("top", 0), b.get("x0", 0)))
                # Minor normalization of text blocks
                for cb in combined_blocks:
                    if cb.get("type") == "text":
                        cb["text"] = normalize_text(cb.get("text", ""))
                pages_out.append({
                    "page": page_num,
                    "blocks": combined_blocks
                })

        # Produce a flattened text field with placeholders [IMG:filename] and [MATH:latex_key] / [MATHBLOCK:...]
        flattened_segments: List[str] = []
        math_index = 1
        for p in pages_out:
            for b in p["blocks"]:
                if b["type"] == "text":
                    txt = b.get("text", "")
                    if txt and txt.strip():
                        flattened_segments.append(txt)
                elif b["type"] == "image":
                    fname = b.get("filename")
                    att = next((a for a in attachments if a.get("filename") == fname), None)
                    if att and att.get("latex"):
                        key = f"latex_{math_index}"
                        if att.get("block"):
                            tag = f"[MATHBLOCK:{key}]"
                        else:
                            tag = f"[MATH:{key}]"
                        flattened_segments.append(tag)
                        att["latex_key"] = key
                        math_index += 1
                    else:
                        flattened_segments.append(f"[IMG:{fname}]")
            flattened_segments.append("\n")  # separate pages

        flattened_text = "\n".join([seg for seg in flattened_segments if seg is not None])
        cleaned_text = normalize_text(clean_text(flattened_text))

        # Cleanup temp files (we already encoded base64 for attachments)
        for fpath in tmp_files_to_cleanup:
            try:
                if os.path.exists(fpath):
                    os.remove(fpath)
            except Exception:
                pass

        response = {
            "success": True,
            "text": cleaned_text,
            "length": len(cleaned_text),
            "pages": pages_out,
            "attachments": attachments,
        }
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("extract-advanced error: %s", e)
        try:
            for p in tmp_files_to_cleanup:
                if os.path.exists(p):
                    os.remove(p)
        except Exception:
            pass
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000, reload=True)
