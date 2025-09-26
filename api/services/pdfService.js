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
    // ✅ Check the file path
    if (!filePath) {
      throw new Error("❌ extractPdfText called with no filePath");
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`❌ File does not exist: ${filePath}`);
    }

    console.log("📂 Reading PDF from:", filePath);

    // ✅ Read the file into a buffer
    const dataBuffer = fs.readFileSync(filePath);
    if (!dataBuffer || dataBuffer.length === 0) {
      throw new Error("❌ Empty buffer, not sending to pdf-parse");
    }

    // ✅ Call pdf-parse safely
    const data = await pdfParse(dataBuffer);
    if (!data || typeof data.text !== "string") {
      throw new Error("❌ pdf-parse did not return text");
    }

    const text = cleanText(data.text);

    // ✅ Always attempt to delete the tmp file
    try {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted temp file:", filePath);
    } catch (e) {
      console.warn("⚠️ Failed to delete temp file:", e.message);
    }

    console.log("✅ Extracted text length:", text.length);
    return text;
  } catch (err) {
    console.error("❌ PDF extraction failed:", err.message || err);
    // Return empty string so caller can handle it
    return "";
  }
}
