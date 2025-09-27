// /api/services/pdfService.js
import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

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
    console.log("📂 extractPdfText called with:", filePath);

    if (!filePath) throw new Error("❌ No filePath provided");
    if (!fs.existsSync(filePath)) throw new Error(`❌ File not found: ${filePath}`);

    const data = new Uint8Array(fs.readFileSync(filePath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;

    let textContent = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map((item) => item.str);
      textContent += strings.join(" ") + "\n";
    }

    const text = cleanText(textContent);
    console.log("✅ Extracted text length:", text.length);

    // cleanup temp file
    try {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted temp file:", filePath);
    } catch (e) {
      console.warn("⚠️ Failed to delete temp file:", e.message);
    }

    return text;
  } catch (err) {
    console.error("❌ extractPdfText error:", err.message || err);
    return "";
  }
}
