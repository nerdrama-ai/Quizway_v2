// /api/services/pdfService.js
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8000";

function cleanExtractedText(rawText = "") {
  if (!rawText) return "";

  let text = rawText;

  // 🔹 Remove all headers/footers and boilerplate
  text = text.replace(/©\s*KTBS.*?republish.*?\n/gi, " ");
  text = text.replace(/GOVERNMENT OF KARNATAKA/gi, " ");
  text = text.replace(/Karnataka\s+Textbook\s+Society.*?\n/gi, " ");
  text = text.replace(/^\s*\d+\s*$/gm, " "); // remove standalone page numbers
  text = text.replace(/Page\s*\d+/gi, " ");
  text = text.replace(/\b(Not\s+to\s+be\s+republished)\b/gi, " ");

  // 🔹 Remove content table or long index-like lists
  text = text.replace(/CONTENTS[\s\S]*?(LESSON\s*-?\s*\d+)/i, "$1");

  // 🔹 Remove excessive whitespace and line breaks
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/\s{2,}/g, " ");

  // 🔹 Keep only the main lesson body
  const lessons = text.match(/LESSON\s*-\s*\d+[\s\S]*/i);
  if (lessons) text = lessons[0];

  // 🔹 Trim short junk lines
  text = text
    .split("\n")
    .filter(line => line.trim().length > 20)
    .join("\n");

  return text.trim();
}

export async function extractPdfText(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath), "upload.pdf");

    const res = await fetch(`${PYTHON_SERVICE_URL}/extract-text`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error(`Python service error: ${res.status}`);
    const data = await res.json();

    if (!data.success) throw new Error(`Python error: ${data.error}`);

    const cleaned = cleanExtractedText(data.text);
    return cleaned;
  } catch (err) {
    console.error("❌ extractPdfText error:", err.message);
    return "";
  } finally {
    try {
      fs.unlinkSync(filePath); // cleanup
    } catch {}
  }
}
