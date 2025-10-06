# pdf_service.py
from fastapi import FastAPI, File, UploadFile
import uvicorn
import PyPDF2
import io
import re

app = FastAPI()

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

@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    """Extracts text from a PDF and cleans it."""
    try:
        file_bytes = await file.read()
        reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))

        text_content = ""
        for page in reader.pages:
            # Extract page text and remove broken Unicode chars
            page_text = page.extract_text() or ""
            text_content += page_text.replace("\x00", "")

        cleaned_text = clean_text(text_content)

        return {"success": True, "text": cleaned_text, "length": len(cleaned_text)}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000, reload=True)
