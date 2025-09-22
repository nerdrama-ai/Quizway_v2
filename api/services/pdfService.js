import fs from "fs";
import pdfParse from "pdf-parse";

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/Page\\s*\\d+/gi, "")
    .replace(/\\s{2,}/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

export async function extractPdfText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`❌ Invalid file path: ${filePath}`);
    }

    console.log("📂 Reading PDF from:", filePath);

    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    // Clean up temp file
    try {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted temp file:", filePath);
    } catch (e) {
      console.warn("⚠️ Failed to delete temp file:", e.message);
    }

    const text = cleanText(data.text);
    console.log("✅ Extracted text length:", text.length);

    return text;
  } catch (err) {
    console.error("❌ PDF extraction failed:", err);
    return "";
  }
}
