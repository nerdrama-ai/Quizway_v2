// /api/services/pdfService.js
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8000";
const ADVANCED_PDF_PARSER = process.env.ADVANCED_PDF_PARSER === "true";

/**
 * Utility: sanitize and normalize text extracted from PDF.
 */
function cleanExtractedText(rawText = "") {
  if (!rawText) return "";

  let text = rawText;
  text = text.replace(/©\s*KTBS.*?republish.*?\n/gi, " ");
  text = text.replace(/GOVERNMENT OF KARNATAKA/gi, " ");
  text = text.replace(/Karnataka\s+Textbook\s+Society.*?\n/gi, " ");
  text = text.replace(/^\s*\d+\s*$/gm, " ");
  text = text.replace(/Page\s*\d+/gi, " ");
  text = text.replace(/\b(Not\s+to\s+be\s+republished)\b/gi, " ");
  text = text.replace(/CONTENTS[\s\S]*?(LESSON\s*-?\s*\d+)/i, "$1");
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/\s{2,}/g, " ");
  const lessons = text.match(/LESSON\s*-\s*\d+[\s\S]*/i);
  if (lessons) text = lessons[0];
  text = text
    .split("\n")
    .filter((line) => line.trim().length > 20)
    .join("\n");

  return text.trim();
}

/**
 * Helper: replaces placeholders with inline content
 */
function injectInlineMedia(text, attachments = []) {
  if (!attachments?.length) return text;
  let output = text;

  for (const att of attachments) {
    if (att.filename && att.base64) {
      const dataUrl = `data:${att.mimetype || "image/png"};base64,${att.base64}`;
      const regex = new RegExp(`\\[IMG:?${att.filename.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]`, "g");
      output = output.replace(regex, `![](${dataUrl})`);
    }
    if (att.latex_key && att.latex) {
      const regex = new RegExp(`\\[MATH:?${att.latex_key}\\]`, "g");
      output = output.replace(regex, `\\(${att.latex}\\)`);
    }
  }

  return output;
}

/**
 * Extract text (and optionally attachments) from a PDF via Python microservice.
 */
export async function extractPdfText(filePath) {
  let textResult = "";
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath), "upload.pdf");

    const endpoint = ADVANCED_PDF_PARSER
      ? `${PYTHON_SERVICE_URL}/extract-advanced`
      : `${PYTHON_SERVICE_URL}/extract-text`;

    console.log(`🧠 [pdfService] Using endpoint: ${endpoint}`);

    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error(`Python service error: ${res.status}`);
    const data = await res.json();

    if (!data.success) throw new Error(`Python error: ${data.error}`);

    // 🔹 Advanced mode: handle attachments + placeholders
    if (ADVANCED_PDF_PARSER && data.attachments) {
      let textWithInline = injectInlineMedia(data.text || "", data.attachments);
      textResult = cleanExtractedText(textWithInline);
      console.log(
        `✅ [pdfService] Advanced parse: ${data.attachments.length} attachments embedded`
      );
    } else {
      // 🔹 Legacy mode (fallback)
      textResult = cleanExtractedText(data.text || "");
      console.log(`✅ [pdfService] Basic parse complete`);
    }

    return textResult;
  } catch (err) {
    console.error("❌ [pdfService] extractPdfText error:", err.message);
    return "";
  } finally {
    try {
      fs.unlinkSync(filePath); // Cleanup temp file
    } catch {
      /* ignore */
    }
  }
}
