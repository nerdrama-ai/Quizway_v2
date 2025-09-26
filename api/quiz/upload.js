// /Quizway_v2-main/api/quiz/upload.js
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { extractPdfText } from "../services/pdfService.js";
import { performOCRIfNeeded } from "../services/ocrService.js";
import { generateQuizFromText } from "../services/quizService.js";
import { uploadToS3IfConfigured } from "../services/storageService.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const TMP_DIR = "/tmp";

async function parseMultipartNative(req) {
  // Next.js / Vercel / Node 18+ often supports req.formData()
  if (typeof req.formData === "function") {
    const fd = await req.formData();
    const file = fd.get("file");
    const numQuestions = fd.get("numQuestions") || fd.get("count") || 5;
    return { file, numQuestions };
  }
  return null;
}

async function parseMultipartFormidable(req) {
  // dynamic import so projects that don't include formidable won't fail at import time
  try {
    const { default: formidable } = await import("formidable");
    return new Promise((resolve, reject) => {
      const form = formidable({
        multiples: false,
        uploadDir: TMP_DIR,
        keepExtensions: true,
        maxFileSize: 50 * 1024 * 1024, // 50MB limit
      });
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        // files.* shape: { filepath, originalFilename, mimetype, size }
        const file = files.file || files.pdf || Object.values(files)[0];
        resolve({ file, numQuestions: fields.numQuestions || fields.count || 5 });
      });
    });
  } catch (e) {
    // formidable not installed
    throw new Error("No multipart parser available (install formidable or use Node 18+ req.formData()).");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const requestId = randomUUID();
  console.log(`[${requestId}] 👉 Upload handler start`);

  try {
    // 1) Parse multipart — prefer native
    let parsed = null;
    try {
      parsed = await parseMultipartNative(req);
    } catch (e) {
      console.log(`[${requestId}] native parse failed: ${e?.message}`);
    }
    if (!parsed) parsed = await parseMultipartFormidable(req);

    if (!parsed || !parsed.file) {
      console.error(`[${requestId}] No file found in request`);
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 2) normalize file info and write to /tmp
    let tmpPath;
    let originalName = parsed.file.name || parsed.file.originalFilename || parsed.file.filename || `upload-${Date.now()}.pdf`;
    if (parsed.file.arrayBuffer) {
      // file from req.formData() (web File)
      const buf = Buffer.from(await parsed.file.arrayBuffer());
      tmpPath = path.join(TMP_DIR, `${Date.now()}-${originalName}`);
      await fs.promises.writeFile(tmpPath, buf);
    } else {
      // from formidable: parsed.file.filepath
      tmpPath = parsed.file.filepath || parsed.file.path || parsed.file.tempFilePath;
      originalName = parsed.file.originalFilename || parsed.file.name || originalName;
    }

    console.log(`[${requestId}] Uploaded file saved to ${tmpPath} (origName=${originalName})`);

    // Optional: upload original to S3 for auditing / tracking (non-blocking)
    let s3Url = null;
    try {
      s3Url = await uploadToS3IfConfigured(tmpPath, originalName, requestId);
      if (s3Url) console.log(`[${requestId}] Original file uploaded to S3 ${s3Url}`);
    } catch (e) {
      console.warn(`[${requestId}] S3 upload failed (non-fatal): ${e.message}`);
    }

    // 3) Extract text using pdf-parse (fast path)
    let text = await extractPdfText(tmpPath);

    // 4) If not enough text -> OCR fallback (tries providers configured)
    if (!text || text.trim().length < 50) {
      console.log(`[${requestId}] PDF text short (${text?.length || 0}), trying OCR fallback`);
      text = await performOCRIfNeeded(tmpPath, { requestId });
      if (!text || text.trim().length < 30) {
        console.error(`[${requestId}] OCR returned insufficient text (${text?.length || 0})`);
        return res.status(400).json({ error: "Failed to extract text from PDF (try a text-based PDF or enable OCR configuration)." });
      }
    }

    console.log(`[${requestId}] Total extracted text length: ${text.length}`);

    // 5) Generate quiz via OpenAI (robust handler)
    const numQuestions = Number(parsed.numQuestions || 5) || 5;
    const quiz = await generateQuizFromText(text, { numQuestions, requestId });

    if (!quiz || !Array.isArray(quiz) || quiz.length === 0) {
      console.error(`[${requestId}] Quiz generation returned empty`);
      return res.status(500).json({ error: "Failed to generate quiz" });
    }

    // 6) Optionally store generated quiz artifact to S3 for future retrieval
    try {
      const artifactName = `quiz-${requestId}.json`;
      await uploadToS3IfConfigured(Buffer.from(JSON.stringify({ questions: quiz }, null, 2)), artifactName, requestId, { isBuffer: true });
    } catch (e) {
      console.warn(`[${requestId}] Failed to save quiz artifact (non-fatal): ${e.message}`);
    }

    console.log(`[${requestId}] ✅ Quiz generated with ${quiz.length} questions`);
    return res.status(200).json({ questions: quiz, requestId, originalFile: s3Url || null });
  } catch (err) {
    console.error(`[${requestId}] ❌ Upload handler error:`, err?.message || err);
    return res.status(500).json({ error: (err && err.message) || "Unexpected server error" });
  } finally {
    console.log(`[${requestId}] ⛔ Upload handler complete`);
  }
}
