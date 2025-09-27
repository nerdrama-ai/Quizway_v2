# pdf_service.py
from fastapi import FastAPI, File, UploadFile
import uvicorn
import PyPDF2
import io

app = FastAPI()

def clean_text(text: str) -> str:
    if not text:
        return ""
    return text.replace("\n", " ").replace("  ", " ").strip()

@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))

        text_content = ""
        for page in reader.pages:
            text_content += page.extract_text() or ""

        text = clean_text(text_content)
        return {"success": True, "text": text, "length": len(text)}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    uvicorn.run("pdf_service:app", host="0.0.0.0", port=8000, reload=True)
