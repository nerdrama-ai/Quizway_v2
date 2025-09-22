import fs from "fs";
import pdfParse from "pdf-parse";

export async function extractPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  // Delete uploaded file after reading
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("Failed to delete temp file:", e);
  }
  return data.text;
}
