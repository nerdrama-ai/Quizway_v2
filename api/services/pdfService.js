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
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);

  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("Failed to delete temp file:", e.message);
  }

  return cleanText(data.text);
}
