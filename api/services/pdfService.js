// /Quizway_v2-main/api/services/pdfService.js
import fs from "fs";
import pdfParse from "pdf-parse";

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/Page\s*\d+(\s*of\s*\d+)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(filePath) {
  try {
    if (!filePath) throw new Error("extractPdfText called with empty filePath");
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    console.log(`📂 pdfService: reading ${filePath}`);
    const buffer = fs.readFileSync(filePath);
    if (!buffer || buffer.length === 0) throw new Error("Empty file buffer");

    // pdf-parse accepts a Buffer
    const result = await pdfParse(buffer);
    const text = cleanText(result?.text || "");
    console.log(`🔎 pdfService: extracted ${text.length} chars`);
    return text;
  } catch (err) {
    console.error("❌ pdfService.extractPdfText error:", err?.message || err);
    return "";
  }
}
