// api/services/pdfService.js
import fs from "fs";
import pdfParse from "pdf-parse";

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/Page\s*\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Invalid file path passed to extractPdfText: ${filePath}`);
    }

    console.log("📂 Reading PDF from:", filePath);

    const dataBuffer = fs.readFileSync(filePath);
    if (!dataBuffer || dataBuffer.length === 0) {
      throw new Error("Empty file buffer, cannot parse PDF");
    }

    const data = await pdfParse(dataBuffer);
    const text = cleanText(data.text || "");

    // try to delete tmp file
    try {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted temp file:", filePath);
    } catch (e) {
      console.warn("⚠️ Failed to delete temp file:", e.message);
    }

    console.log("✅ Extracted text length:", text.length);
    return text;
  } catch (err) {
    console.error("❌ PDF extraction failed:", err);
    // Return empty string (caller handles it)
    return "";
  }
}
