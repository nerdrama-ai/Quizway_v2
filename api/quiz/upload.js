// api/quiz/upload.js
import fs from "fs";
import path from "path";
import { extractPdfText } from "../services/pdfService.js";
import { generateQuizFromText } from "../services/quizService.js";

export const config = {
  api: {
    bodyParser: false, // Important: disable Next's body parser
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Parse incoming multipart form data
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Write the uploaded file to /tmp (works on Vercel)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // sanitize filename a bit
    const safeName = path.basename(file.name || `upload-${Date.now()}.pdf`);
    const tmpPath = path.join("/tmp", `${Date.now()}-${safeName}`);

    await fs.promises.writeFile(tmpPath, buffer);
    console.log("📂 Uploaded file path:", tmpPath);

    // Extract text
    const text = await extractPdfText(tmpPath);
    console.log("🔎 Extracted text length:", text?.length || 0);

    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        error:
          "PDF too short or unreadable (possible scanned PDF). Try a text-based PDF or enable OCR.",
      });
    }

    const numQuestions = Number(formData.get("numQuestions")) || 5;
    const quiz = await generateQuizFromText(text, { numQuestions });

    console.log("✅ Quiz generated:", (quiz && quiz.length) || 0);

    if (!quiz || quiz.length === 0) {
      return res.status(500).json({ error: "Quiz generation failed" });
    }

    return res.status(200).json({ questions: quiz });
  } catch (err) {
    console.error("❌ Upload handler error:", err);
    return res.status(500).json({ error: err.message || "Unexpected server error" });
  }
}
