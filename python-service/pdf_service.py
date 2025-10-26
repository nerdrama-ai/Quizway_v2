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

def sanitize_filename(name):
    import re, os
    if not name:
        return "file.png"
    name = os.path.basename(name)
    name = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
    return name

    HAS_LAYOUTPARSER = True
except Exception:
    HAS_LAYOUTPARSER = False

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
    """
    Try to fix typical mojibake/double-encoding artifacts.
    Heuristics: if string contains 'Ã' / 'Â' / replacement char, attempt re-encoding.
    """
    if not s:
        return s
    # quick replacements for common artifacts
    s = s.replace("\u00A0", " ")  # non-breaking space
    s = s.replace("\u200b", "")  # zero width space
    s = s.replace("\ufeff", "")  # BOM
    # If we see common UTF-8 mis-decode signs, try re-encode-from-latin1
    if "Ã" in s or "Â" in s or "\ufffd" in s:
        try:
            candidate = s.encode("latin-1", errors="ignore").decode("utf-8", errors="replace")
            # If candidate reduces the replacement-char count, keep it
            if candidate.count("\ufffd") < s.count("\ufffd"):
                s = candidate
        except Exception:
            pass
    # Normalize Unicode (NFKC to collapse compatibility chars)
    try:
        s = unicodedata.normalize("NFKC", s)
    except Exception:
        pass
    # Remove stray replacement characters and control chars
    s = re.sub(r"[\uFFFD\x00-\x1F\x7F]", "", s)
    # Remove stray combining marks that sometimes get inserted
    s = re.sub(r"[\u0300-\u036f]", "", s)
    # Remove stray isolated 'Â' or leftover artifacts
    s = s.replace("Â", "")
    return s


def collapse_letter_gaps(s: str) -> str:
    """
    Fix sequences like: 'W�h�a�t' or 'W h a t' caused by weird spacing or replacement chars.
    Heuristic: if we detect long runs where many tokens are single-letter, join them.
    """
    if not s:
        return s
    # remove isolated zero-width / replacement markers first
    s = s.replace("\u200b", "").replace("\ufeff", "")
    s = s.replace("\uFFFD", "")
    # If text has many single-letter tokens separated by non-letter chars, reconstruct words
    tokens = re.split(r'(\s+)', s)  # keep whitespace tokens
    # detect sequences of single-letter tokens interleaved with spaces/markers
    out_tokens = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.fullmatch(r"[A-Za-z]", tok):
            # potential run
            run = [tok]
            j = i + 1
            # gather pattern: (sep, letter)+
            while j + 1 < len(tokens) and re.fullmatch(r'\s+', tokens[j]) and re.fullmatch(r'[A-Za-z]', tokens[j+1]):
                run.append(tokens[j+1])
                j += 2
            if len(run) >= 3:  # join if three or more single-letter tokens in a row
                joined = "".join(run)
                out_tokens.append(joined)
                i = j
                continue
        out_tokens.append(tok)
        i += 1
    return "".join(out_tokens)


def normalize_text(s: str) -> str:
    """Full normalization pass to fix common PDF extraction artifacts."""
    if not s:
        return s
    s = s.replace("\x00", "")  # remove nulls
    s = s.replace("\xa0", " ")
    s = fix_mojibake(s)
    s = collapse_letter_gaps(s)
    # collapse multiple spaces and normalize newlines
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = s.strip()
    return s


# ---------------------------
# Math detection & MathPix
# ---------------------------
def is_likely_formula(ocr_text: str) -> bool:
    """Heuristic to decide if OCR text is likely a math/formula snippet."""
    if not ocr_text:
        return False
    txt = ocr_text.strip()
    # symbols often present in math
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


def mathpix_recognize(image_path: str, timeout: int = 20) -> str:
    """
    Try to recognize LaTeX using MathPix.
    Returns LaTeX string on success or None on failure.
    """
    if not (MATHPIX_API_KEY or (MATHPIX_APP_ID and MATHPIX_APP_KEY)):
        return None

    logger.info("mathpix_recognize: calling MathPix (if configured)")
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
        # Look for typical fields
        latex = None
        if isinstance(resp, dict):
            for key in ("latex_simplified", "latex", "text"):
                val = resp.get(key)
                if isinstance(val, str) and val.strip():
                    latex = val.strip()
                    break
            # fallback to nested 'data' structures
            if not latex and isinstance(resp.get("data"), list) and resp["data"]:
                entry = resp["data"][0]
                for key in ("latex_simplified", "latex", "text"):
                    if key in entry and isinstance(entry[key], str) and entry[key].strip():
                        latex = entry[key].strip()
                        break
        return latex
    except Exception as e:
        logger.exception("MathPix request failed: %s", e)
        return None


# ---------------------------
# Core endpoints
# ---------------------------
@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    """
    Backwards-compatible endpoint:
    - Uses pdfplumber first and falls back to PyPDF2
    - Runs normalization on extracted text to fix encoding / spacing issues
    """
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
                    # extract_text gives a block; combine with words for more control
                    page_text = p.extract_text() or ""
                    # quick normalization to reduce garble
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
    """
    Advanced extraction: returns structured pages, blocks and attachments.
    Produces flattened `text` with placeholders:
      - [IMG:filename.png]
      - [MATH:latex_key] or [MATHBLOCK:latex_key]
    Attachments include base64 content and optional ocr_text/latex.
    """
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
                        # Try a few attribute names; pdfplumber can vary
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

                                    # Decide if this is a formula and optionally try MathPix
                                    latex = None
                                    block_like = False
                                    if is_likely_formula(ocr_text):
                                        # If the crop height relative to page is large, call it block math
                                        rel_h = (lower - upper) / max(1.0, page_image.height)
                                        block_like = rel_h > 0.08  # heuristic threshold
                                        latex = mathpix_recognize(tmp_path) or None

                                    with open(tmp_path, "rb") as fh:
                                        b64 = base64.b64encode(fh.read()).decode()
                                    attachments.append({
                                        "filename": sanitize_filename(fname)",
                                        "mimetype": "image/png",
                                        "base64": b64,
                                        "ocr_text": ocr_text,
                                        "latex": latex,
                                        "block": bool(block_like),
                                        "temp_path": tmp_path,
                                    })
                                    image_blocks.append({
                                        "type": "image",
                                        "filename": sanitize_filename(fname)",
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
                            latex = mathpix_recognize(tmp_path)
                        with open(tmp_path, "rb") as fh:
                            b64 = base64.b64encode(fh.read()).decode()
                        attachments.append({
                            "filename": sanitize_filename(fname)",
                            "mimetype": "image/png",
                            "base64": b64,
                            "ocr_text": page_ocr,
                            "latex": latex,
                            "block": bool(block_like),
                            "temp_path": tmp_path,
                        })
                        image_blocks.insert(0, {
                            "type": "image",
                            "filename": sanitize_filename(fname)",
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
                    # find corresponding attachment (should exist)
                    att = next((a for a in attachments if a.get("filename") == fname), None)
                    if att and att.get("latex"):
                        # produce math placeholder; choose block vs inline
                        key = f"latex_{math_index}"
                        if att.get("block"):
                            tag = f"[MATHBLOCK:{key}]"
                        else:
                            tag = f"[MATH:{key}]"
                        flattened_segments.append(tag)
                        # annotate attachment with latex_key
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
            "text": cleaned_text,                # backward-compatible text
            "length": len(cleaned_text),
            "pages": pages_out,
            "attachments": attachments,
        }
        return response

    except HTTPException:
        # re-raise HTTP errors
        raise
    except Exception as e:
        logger.exception("extract-advanced error: %s", e)
        # attempt cleanup
        try:
            for p in tmp_files_to_cleanup:
                if os.path.exists(p):
                    os.remove(p)
        except Exception:
            pass
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    # Run for local/dev: uvicorn pdf_service:app --host 0.0.0.0 --port 8000 --reload
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000, reload=True)
