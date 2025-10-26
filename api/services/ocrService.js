// /Quizway_v2-main/api/services/ocrService.js
import fs from "fs";
import fetch from "node-fetch"; // include node-fetch in package.json if Node < 18; Vercel has fetch in runtime often.

const OCR_SPACE_KEY = process.env.OCR_SPACE_API_KEY || null;
const GOOGLE_VISION_KEY = process.env.GOOGLE_VISION_KEY || null; // optional base64 JSON or API key for Google Cloud Vision

export async function performOCRIfNeeded(filePath, { requestId } = {}) {
  // try providers in order: Google Vision (if configured) -> OCR.Space -> (optional) local tesseract
  if (GOOGLE_VISION_KEY) {
    try {
      console.log(`[${requestId}] ocrService: trying Google Vision`);
      const text = await googleVisionOCR(filePath);
      if (text && text.trim().length > 20) return text;
    } catch (e) {
      console.warn(`[${requestId}] Google Vision OCR failed: ${e.message}`);
    }
  }

  if (OCR_SPACE_KEY) {
    try {
      console.log(`[${requestId}] ocrService: trying OCR.Space`);
      const text = await ocrSpaceOCR(filePath);
      if (text && text.trim().length > 20) return text;
    } catch (e) {
      console.warn(`[${requestId}] OCR.Space OCR failed: ${e.message}`);
    }
  }

  // Local tesseract.js fallback - heavy and slow; include only if you want to support it
  if (process.env.ENABLE_TESSERACT === "true") {
    try {
      console.log(`[${requestId}] ocrService: trying local Tesseract (may be slow)`);
      const txt = await tesseractOCR(filePath);
      if (txt && txt.trim().length > 20) return txt;
    } catch (e) {
      console.warn(`[${requestId}] Tesseract OCR failed: ${e.message}`);
    }
  }

  return "";
}

async function ocrSpaceOCR(filePath) {
  // OCR.Space accept file POST
  const form = new FormData();
  const b = fs.readFileSync(filePath);
  form.append("file", new Blob([b]), "file.pdf");
  form.append("isOverlayRequired", "false");
  form.append("language", "eng");
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: OCR_SPACE_KEY },
    body: form,
  });
  const j = await res.json();
  if (!j || !j.ParsedResults || j.ParsedResults.length === 0) throw new Error("OCR.Space parse failed");
  const text = j.ParsedResults.map((p) => p.ParsedText || "").join("\n\n");
  return text;
}

async function googleVisionOCR(filePath) {
  // This uses the Cloud Vision REST API with API key.
  // GOOGLE_VISION_KEY should be an API key with Vision API enabled.
  const key = GOOGLE_VISION_KEY;
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");
  const body = {
    requests: [
      {
        inputConfig: { content: base64, mimeType: "application/pdf" },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      },
    ],
  };
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j || !j.responses) throw new Error("Google Vision failed");
  // For PDF documents, Vision API returns fullTextAnnotation in responses[0].fullTextAnnotation
  const chunks = [];
  for (const r of j.responses) {
    const t = (r.fullTextAnnotation && r.fullTextAnnotation.text) || "";
    if (t) chunks.push(t);
  }
  return chunks.join("\n\n");
}

async function tesseractOCR(filePath) {
  // Optional: use tesseract.js (heavy)
  const { createWorker } = await import("tesseract.js");
  const worker = createWorker();
  await worker.load();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  const { data } = await worker.recognize(filePath);
  await worker.terminate();
  return data?.text || "";
}
