// /api/quiz/upload.js
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { extractPdfText } from "../services/pdfService.js";
import { performOCRIfNeeded } from "../services/ocrService.js";
import { generateQuizFromText } from "../services/quizService.js";

export const config = { api: { bodyParser: false } };
const TMP_DIR = "/tmp";

// Ensure tmp dir exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/** Parse multipart form using built-in or formidable */
async function parseNative(req) {
  if (typeof req.formData === "function") {
    const fd = await req.formData();
    const file = fd.get("file");
    const numQuestions = fd.get("numQuestions") || fd.get("count") || 5;
    return { file, numQuestions };
  }
  return null;
}

async function parseFormidable(req) {
  const { default: formidable } = await import("formidable");
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      uploadDir: TMP_DIR,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024,
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      let file = files.file || files.pdf || Object.values(files)[0];
      if (Array.isArray(file)) file = file[0];
      resolve({
        file,
        numQuestions: fields.numQuestions || fields.count || 5,
      });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const requestId = randomUUID();
  console.log(`[${requestId}] 🚀 Upload handler start`);

  try {
    // 1️⃣ Parse incoming file
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

    // 2️⃣ Write file to /tmp
    let tmpPath;
    let originalName =
      parsed.file.name ||
      parsed.file.originalFilename ||
      parsed.file.filename ||
      `upload-${Date.now()}.pdf`;

    if (parsed.file.arrayBuffer) {
      const buf = Buffer.from(await parsed.file.arrayBuffer());
      tmpPath = path.join(TMP_DIR, `${Date.now()}-${originalName}`);
      await fs.promises.writeFile(tmpPath, buf);
    } else {
      tmpPath =
        parsed.file.filepath ||
        parsed.file.path ||
        parsed.file.tempFilePath ||
        null;
      if (!tmpPath) {
        console.error(`[${requestId}] ❌ Missing filepath`);
        return res.status(400).json({ error: "File upload failed" });
      }
    }

    console.log(`[${requestId}] 📁 Saved file to: ${tmpPath}`);

    // 3️⃣ Extract text via Python service
    console.log(`[${requestId}] 🔍 Extracting PDF text...`);
    let text = await extractPdfText(tmpPath);

    // 4️⃣ OCR fallback
    if (!text || text.trim().length < 50) {
      console.log(`[${requestId}] ⚠️ Text too short, falling back to OCR`);
      text = await performOCRIfNeeded(tmpPath, { requestId });
    }
    if (!text || text.trim().length < 30) {
      console.error(`[${requestId}] ❌ Extraction failed`);
      return res
        .status(400)
        .json({ error: "Failed to extract text from PDF" });
    }

    console.log(`[${requestId}] ✅ Text extracted (${text.length} chars)`);

    // 5️⃣ Generate quiz
    const numQuestions = Number(parsed.numQuestions || 5);
    console.log(`[${requestId}] 🧩 Generating ${numQuestions} questions...`);
    const quiz = await generateQuizFromText(text, numQuestions);

    console.log(
      `[${requestId}] ✅ Quiz generated (${quiz?.questions?.length || 0} questions)`
    );

    res.status(200).json({
      ...quiz,
      success: true,
    });
  } catch (err) {
    console.error(`[${requestId}] ❌ Handler error:`, err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  } finally {
    console.log(`[${requestId}] ⛔ Handler complete`);
  }
}
