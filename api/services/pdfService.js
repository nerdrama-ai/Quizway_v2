// /Quizway_v2-main/api/services/pdfService.js
import fs from "fs";
import pdfParse from "pdf-parse";

export async function extractPdfText(filePath) {
  try {
    console.log("📂 extractPdfText called with:", filePath);

    if (!filePath) {
      throw new Error("❌ extractPdfText called with empty filePath");
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`❌ File does not exist: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    console.log("📂 Buffer length:", buffer?.length);

    if (!buffer || buffer.length === 0) {
      throw new Error("❌ Empty PDF buffer");
    }

    console.log("🔎 Calling pdf-parse...");
    const data = await pdfParse(buffer);

    const text = (data.text || "").trim();
    console.log("✅ pdf-parse returned length:", text.length);
    return text;
  } catch (err) {
    console.error("❌ extractPdfText error:", err.message || err);
    return "";
  }
}
