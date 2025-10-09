# pdf_service.py
"""
Advanced PDF extraction microservice.

Endpoints:
- POST /extract-text      -> Backwards-compatible text extraction (keeps old behavior).
- POST /extract-advanced  -> Returns rich JSON { text, pages, attachments } with images, OCR and optional LaTeX.

Notes:
- Requires system packages: tesseract and poppler-utils (for pdf2image).
- Attachments contain base64 image data. If you want S3 uploads performed here, we can add that later.
"""

import os
import io
import re
import base64
import json
import tempfile
import logging
from uuid import uuid4
from typing import List, Dict, Any

from fastapi import FastAPI, File, UploadFile, HTTPException
import uvicorn

# PDF/text/image libs
import PyPDF2
import pdfplumber
from pdf2image import convert_from_bytes
from PIL import Image
import pytesseract
import requests

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pdf_service")

# Environment / limits
MAX_FILE_SIZE_BYTES = int(os.getenv("MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024))  # 50 MB default
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", 50))  # 50 pages default
PAGE_IMAGE_DPI = int(os.getenv("PAGE_IMAGE_DPI", 150))  # DPI used when rendering pages
TEMP_DIR = os.getenv("PDF_SERVICE_TMP_DIR", "/tmp")

MATHPIX_API_KEY = os.getenv("MATHPIX_API_KEY")
MATHPIX_APP_ID = os.getenv("MATHPIX_APP_ID")
MATHPIX_APP_KEY = os.getenv("MATHPIX_APP_KEY")

# Ensure tmp dir exists
os.makedirs(TEMP_DIR, exist_ok=True)

app = FastAPI(title="Quizway PDF Service (advanced)")


def clean_text(raw_text: str) -> str:
    """Cleans extracted text: removes headers, footers, and garbage."""
    if not raw_text:
        return ""

    text = raw_text

    # 🔹 Remove copyright and publisher notices
    text = re.sub(r"©\s*KTBS.*?republish.*?\s*", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"GOVERNMENT OF KARNATAKA", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"Karnataka\s+Textbook\s+Society.*?", " ", text, flags=re.IGNORECASE)

    # 🔹 Remove "Not to be republished", "Page x", etc.
    text = re.sub(r"Not\s+to\s+be\s+republished", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"Page\s*\d+", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"^\s*\d+\s*$", " ", text, flags=re.MULTILINE)

    # 🔹 Remove large "CONTENTS" or index blocks
    text = re.sub(r"CONTENTS[\s\S]*?(LESSON\s*[-–]?\s*\d+)", r"\1", text, flags=re.IGNORECASE)

    # 🔹 Collapse multiple newlines and spaces
    text = re.sub(r"\n{2,}", "\n", text)
    text = re.sub(r"\s{2,}", " ", text)

    # 🔹 Keep only lessons onward if present
    lessons_match = re.search(r"(LESSON\s*[-–]?\s*\d+[\s\S]*)", text, re.IGNORECASE)
    if lessons_match:
        text = lessons_match.group(1)

    # 🔹 Filter out super short / meaningless lines
    lines = [line.strip() for line in text.split("\n") if len(line.strip()) > 25]
    return "\n".join(lines).strip()


def is_likely_formula(ocr_text: str) -> bool:
    """Heuristic to decide if OCR text is likely a math/formula snippet."""
    if not ocr_text:
        return False
    txt = ocr_text.strip()
    # Short texts with lots of math-like symbols or slashes are likely formulas
    math_symbols = set("=√∑∫π×÷^_()[]{}+-/\\<>|")
    sym_count = sum(1 for c in txt if c in math_symbols)
    sym_ratio = sym_count / max(1, len(txt))
    low_alpha_ratio = sum(1 for c in txt if c.isalpha()) / max(1, len(txt))
    keywords = ["frac", "sqrt", "lim", "sum", "int", "\\frac", "\\sqrt", "\\int", "="]

    if any(k in txt.lower() for k in keywords):
        return True
    if sym_ratio > 0.05 and low_alpha_ratio < 0.9:
        return True
    # if short and contains math symbols
    if len(txt) < 60 and sym_count >= 2:
        return True
    return False


def mathpix_recognize(image_path: str, timeout: int = 20) -> str:
    """
    Try to recognize LaTeX using MathPix.
    Supports two header styles:
      - Authorization: Bearer <MATHPIX_API_KEY>
      - app_id & app_key (older style)
    Returns LaTeX string on success or None on failure.
    """
    if not (MATHPIX_API_KEY or (MATHPIX_APP_ID and MATHPIX_APP_KEY)):
        return None

    logger.info("mathpix_recognize: calling MathPix (if configured)")
    with open(image_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()

    # MathPix v3 text endpoint (common)
    url = "https://api.mathpix.com/v3/text"
    headers = {"Content-type": "application/json"}
    if MATHPIX_API_KEY:
        headers["Authorization"] = f"Bearer {MATHPIX_API_KEY}"
    else:
        headers["app_id"] = MATHPIX_APP_ID
        headers["app_key"] = MATHPIX_APP_KEY

    payload = {
        "src": f"data:image/png;base64,{b64}",
        # request LaTeX and plain text
        "formats": ["latex_simplified", "text"],
        "ocr": {"math_inline_delimiters": [["$", "$"], ["\\(", "\\)"]]},
    }

    try:
        r = requests.post(url, json=payload, headers=headers, timeout=timeout)
        r.raise_for_status()
        resp = r.json()

        # Try several common places for LaTeX in MathPix responses
        latex = None
        if isinstance(resp, dict):
            for key in ("latex_simplified", "latex", "text"):
                val = resp.get(key)
                if isinstance(val, str) and len(val.strip()) > 0:
                    latex = val.strip()
                    break
            if not latex and isinstance(resp.get("text"), dict):
                for key in ("latex_simplified", "latex", "text"):
                    val = resp["text"].get(key)
                    if isinstance(val, str) and len(val.strip()) > 0:
                        latex = val.strip()
                        break
            # fallback to data array variants
            if not latex and "data" in resp and isinstance(resp["data"], list) and len(resp["data"]) > 0:
                entry = resp["data"][0]
                for key in ("latex_simplified", "latex", "text"):
                    if key in entry and isinstance(entry[key], str) and entry[key].strip():
                        latex = entry[key].strip()
                        break

        return latex
    except Exception as e:
        logger.exception("MathPix request failed or returned unexpected data: %s", e)
        return None


@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    """
    Backwards-compatible endpoint:
    - Tries to use pdfplumber (better layout) first
    - Falls back to PyPDF2 if pdfplumber fails
    - Returns: { success: True, text: cleaned_text, length: N } on success
    """
    try:
        file_bytes = await file.read()
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        # Try pdfplumber for better extraction
        raw_text = ""
        try:
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                page_texts = []
                for p in pdf.pages:
                    t = p.extract_text() or ""
                    page_texts.append(t)
                raw_text = "\n".join(page_texts)
        except Exception:
            # Fallback to PyPDF2 (original behavior)
            try:
                reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
                parts = []
                for p in reader.pages:
                    parts.append(p.extract_text() or "")
                raw_text = "\n".join(parts)
            except Exception as inner:
                logger.exception("Both pdfplumber and PyPDF2 extraction failed: %s", inner)
                raise inner

        cleaned = clean_text(raw_text)
        return {"success": True, "text": cleaned, "length": len(cleaned)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("extract-text error: %s", e)
        return {"success": False, "error": str(e)}


@app.post("/extract-advanced")
async def extract_advanced(file: UploadFile = File(...)):
    """
    Advanced endpoint:
    Returns structured JSON:
    {
      success: True,
      text: "<flattened_text_with_placeholders>",
      length: 1234,
      pages: [
        { page: 1, blocks: [ { type: 'text', text: '...' , top:..., x0:... }, { type:'image', filename:'...', ocr_text:'...', latex: '...' } ] },
        ...
      ],
      attachments: [
        { filename: 'page1.png', mimetype: 'image/png', base64: '...', ocr_text: '...', latex: '...' },
        ...
      ]
    }
    """
    try:
        file_bytes = await file.read()
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        # Open with pdfplumber
        pages_out = []
        attachments: List[Dict[str, Any]] = []
        try:
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                total_pages = len(pdf.pages)
                if total_pages > MAX_PDF_PAGES:
                    raise HTTPException(status_code=413, detail=f"PDF has too many pages ({total_pages} > {MAX_PDF_PAGES})")

                logger.info("Processing %d pages (dpi=%d)", total_pages, PAGE_IMAGE_DPI)

                # Render pages on demand: we will call convert_from_bytes for each page
                for idx, p in enumerate(pdf.pages):
                    page_num = idx + 1
                    page_width = p.width
                    page_height = p.height

                    # Extract word-level blocks (gives word bbox info)
                    words = p.extract_words() or []
                    text_blocks = []
                    for w in words:
                        # each w includes 'text', 'x0','top','x1','bottom'
                        text_blocks.append({
                            "type": "text",
                            "text": w.get("text", ""),
                            "top": w.get("top", 0),
                            "x0": w.get("x0", 0),
                        })

                    # Prepare to render page image for OCR fallback or cropping
                    page_image = None
                    try:
                        pil_pages = convert_from_bytes(file_bytes, dpi=PAGE_IMAGE_DPI, first_page=page_num, last_page=page_num)
                        if pil_pages and len(pil_pages) > 0:
                            page_image = pil_pages[0]
                    except Exception as e:
                        logger.warning("Failed to render page %d to image: %s", page_num, e)
                        page_image = None

                    # Image blocks (from embedded PDF images) - try to crop them from the rendered page
                    image_blocks = []
                    pdf_images = getattr(p, "images", None) or []
                    if page_image and pdf_images:
                        for img_idx, img_obj in enumerate(pdf_images):
                            # pdfplumber's image objects vary; try a few keys
                            x0 = img_obj.get("x0") if "x0" in img_obj else img_obj.get("x")
                            top = img_obj.get("top") if "top" in img_obj else img_obj.get("y")
                            x1 = img_obj.get("x1") if "x1" in img_obj else (x0 + img_obj.get("width", 0) if x0 is not None else None)
                            bottom = img_obj.get("bottom") if "bottom" in img_obj else (top + img_obj.get("height", 0) if top is not None else None)

                            # If we have a valid bbox and a rendered image, crop and save
                            if None not in (x0, top, x1, bottom):
                                try:
                                    scale_x = page_image.width / max(1.0, page_width)
                                    scale_y = page_image.height / max(1.0, page_height)

                                    left = int(max(0, round(x0 * scale_x)))
                                    upper = int(max(0, round(top * scale_y)))
                                    right = int(min(page_image.width, round(x1 * scale_x)))
                                    lower = int(min(page_image.height, round(bottom * scale_y)))

                                    if right - left > 2 and lower - upper > 2:
                                        crop = page_image.crop((left, upper, right, lower))
                                        unique = uuid4().hex
                                        fname = f"page{page_num}_img{img_idx}_{unique}.png"
                                        tmp_path = os.path.join(TEMP_DIR, fname)
                                        crop.save(tmp_path, format="PNG")
                                        # OCR the crop
                                        try:
                                            ocr_text = pytesseract.image_to_string(crop)
                                        except Exception:
                                            ocr_text = ""
                                        latex = None
                                        if is_likely_formula(ocr_text):
                                            latex = mathpix_recognize(tmp_path)
                                        with open(tmp_path, "rb") as fh:
                                            b64 = base64.b64encode(fh.read()).decode()
                                        attachments.append({
                                            "filename": fname,
                                            "mimetype": "image/png",
                                            "base64": b64,
                                            "ocr_text": ocr_text,
                                            "latex": latex,
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
                                            "temp_path": tmp_path,
                                        })
                                except Exception as e:
                                    logger.exception("Failed to crop embedded image on page %d: %s", page_num, e)

                    # If page_image exists and there was little or no text, or we want a page-level image, include it
                    if page_image and (len(words) == 0 or len(image_blocks) > 0):
                        try:
                            unique = uuid4().hex
                            fname = f"page{page_num}_full_{unique}.png"
                            tmp_path = os.path.join(TEMP_DIR, fname)
                            page_image.save(tmp_path, format="PNG")
                            # OCR the whole page
                            try:
                                page_ocr = pytesseract.image_to_string(page_image)
                            except Exception:
                                page_ocr = ""
                            latex = None
                            if is_likely_formula(page_ocr):
                                latex = mathpix_recognize(tmp_path)
                            with open(tmp_path, "rb") as fh:
                                b64 = base64.b64encode(fh.read()).decode()
                            attachments.append({
                                "filename": fname,
                                "mimetype": "image/png",
                                "base64": b64,
                                "ocr_text": page_ocr,
                                "latex": latex,
                                "temp_path": tmp_path,
                            })
                            # Represent it as an image block covering whole page
                            image_blocks.insert(0, {
                                "type": "image",
                                "filename": fname,
                                "top": 0,
                                "x0": 0,
                                "x1": page_width,
                                "bottom": page_height,
                                "ocr_text": page_ocr,
                                "latex": latex,
                                "temp_path": tmp_path,
                            })
                        except Exception as e:
                            logger.exception("Failed to save page image for page %d: %s", page_num, e)

                    # Combine text and image blocks and sort by reading order (top then x0)
                    combined_blocks = []
                    for t in text_blocks:
                        combined_blocks.append({
                            "type": "text",
                            "text": t.get("text", ""),
                            "top": t.get("top", 0),
                            "x0": t.get("x0", 0),
                        })
                    for im in image_blocks:
                        combined_blocks.append({
                            "type": "image",
                            "filename": im.get("filename"),
                            "top": im.get("top", 0),
                            "x0": im.get("x0", 0),
                            "ocr_text": im.get("ocr_text"),
                            "latex": im.get("latex"),
                            "temp_path": im.get("temp_path"),
                        })

                    combined_blocks.sort(key=lambda b: (b.get("top", 0), b.get("x0", 0)))
                    pages_out.append({
                        "page": page_num,
                        "blocks": combined_blocks
                    })

        except Exception as e:
            logger.exception("Failed to parse PDF with pdfplumber: %s", e)
            raise

        # Produce a flattened text field with placeholders [IMG:filename] and [MATH:latex_x]
        flattened_segments: List[str] = []
        math_index = 1
        for p in pages_out:
            for b in p["blocks"]:
                if b["type"] == "text":
                    flattened_segments.append(b.get("text", ""))
                elif b["type"] == "image":
                    fname = b.get("filename")
                    if b.get("latex"):
                        tag = f"[MATH:latex_{math_index}]"
                        flattened_segments.append(tag)
                        # Attach mapping: add latex_key to the attachment if matching
                        for att in attachments:
                            if att.get("filename") == fname:
                                att["latex_key"] = f"latex_{math_index}"
                                break
                        math_index += 1
                    else:
                        flattened_segments.append(f"[IMG:{fname}]")
            flattened_segments.append("\n")  # separate pages

        flattened_text = "\n".join(flattened_segments)
        cleaned_text = clean_text(flattened_text)

        response = {
            "success": True,
            "text": cleaned_text,                # backward-compatible text
            "length": len(cleaned_text),
            "pages": pages_out,
            "attachments": attachments,
        }
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("extract-advanced error: %s", e)
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    # Run for local/dev: uvicorn pdf_service:app --host 0.0.0.0 --port 8000 --reload
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000, reload=True)
