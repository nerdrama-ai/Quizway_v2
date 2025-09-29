// /api/quiz/upload.js
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { extractPdfText } from "../services/pdfService.js"; // ✅ Python service
import { performOCRIfNeeded } from "../services/ocrService.js";
import { generateQuizFromText } from "../services/quizService.js";
import { uploadToS3IfConfigured } from "../services/storageService.js";

export const config = { api: { bodyParser: false } };
const TMP_DIR = "/tmp";

// ✅ Ensure tmp dir exists at startup
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/** Try native Node 18+ formData parser */
async function parseNative(req) {
  if (typeof req.formData === "function") {
    const fd = await req.formData();
    const file = fd.get("file");
    const numQuestions = fd.get("numQuestions") || fd.get("count") || 5;
    return { file, numQuestions };
  }
  return null;
}

/** Fallback: formidable parser */
async function parseFormidable(req) {
  const { default: formidable } = await import("formidable");

  // ✅ Ensure /tmp exists before parsing
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      uploadDir: TMP_DIR,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024, // 50MB
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      const file = files.file || files.pdf || Object.values(files)[0];
      resolve({ file, numQuestions: fields.numQuestions || fields.count || 5 });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const requestId = randomUUID();
  console.log(`[${requestId}] 👉 Upload handler start`);

  try {
    // 1) Parse request
    let parsed = null;
    try {
      parsed = await parseNative(req);
    } catch (e) {
      console.warn(`[${requestId}] ⚠️ Native parser failed: ${e.message}`);
    }
    if (!parsed) parsed = await parseFormidable(req);

    if (!parsed?.file) {
      console.error(`[${requestId}] ❌ No file found`);
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 2) Save file to /tmp
    let tmpPath;
    let originalName =
      parsed.file.name ||
      parsed.file.originalFilename ||
      parsed.file.filename ||
      `upload-${Date.now()}.pdf`;

    if (parsed.file.arrayBuffer) {
      // Native formData branch
      const buf = Buffer.from(await parsed.file.arrayBuffer());
      tmpPath = path.join(TMP_DIR, `${Date.now()}-${originalName}`);
      await fs.promises.writeFile(tmpPath, buf);
    } else {
      // Formidable branch
      tmpPath =
        parsed.file.filepath ||
        parsed.file.path ||
        parsed.file.tempFilePath ||
        null;
      if (!tmpPath) {
        console.error(`[${requestId}] ❌ Formidable file missing filepath`);
        return res.status(400).json({ error: "File upload failed" });
      }
      originalName =
        parsed.file.originalFilename || parsed.file.name || originalName;
    }

    console.log(`[${requestId}] 📂 File saved to ${tmpPath} (orig=${originalName})`);

    // 3) Upload original to S3 (optional)
    let s3Url = null;
    try {
      s3Url = await uploadToS3IfConfigured(tmpPath, originalName, requestId);
    } catch (e) {
      console.warn(`[${requestId}] ⚠️ S3 upload failed: ${e.message}`);
    }

    // 4) Extract text via Python service
    console.log(`[${requestId}] 🔎 Calling extractPdfText with: ${tmpPath}`);
    let text = await extractPdfText(tmpPath);

    // 5) OCR fallback if text too short
    if (!text || text.trim().length < 50) {
      console.log(`[${requestId}] ⚠️ Text too short, trying OCR`);
      text = await performOCRIfNeeded(tmpPath, { requestId });
    }
    if (!text || text.trim().length < 30) {
      console.error(`[${requestId}] ❌ Extraction failed`);
      return res
        .status(400)
        .json({ error: "Failed to extract text from PDF" });
    }

    console.log(`[${requestId}] ✅ Extracted text length: ${text.length}`);

    // 6) Generate quiz
    const numQuestions = Number(parsed.numQuestions || 5);
    const quiz = await generateQuizFromText(text, numQuestions);

    console.log(`[${requestId}] ✅ Quiz generated with ${quiz?.questions?.length || 0} questions`);

    res.json({ quiz, s3Url });
  } catch (err) {
    console.error(`[${requestId}] ❌ Handler error:`, err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  } finally {
    console.log(`[${requestId}] ⛔ Handler complete`);
  }
}
