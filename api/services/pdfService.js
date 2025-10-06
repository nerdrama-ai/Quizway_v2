// /api/services/pdfService.js
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8000";

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

    return data.text || "";
  } catch (err) {
    console.error("❌ extractPdfText error:", err.message);
    return "";
  } finally {
    try {
      fs.unlinkSync(filePath); // cleanup
    } catch {}
  }
}
