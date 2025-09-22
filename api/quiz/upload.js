import fs from "fs";
import { extractPdfText } from "../services/pdfService.js";
import { generateQuizFromText } from "../services/quizService.js";

export const config = {
  api: {
    bodyParser: false, // Important: disable default parser
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

    // Save file to /tmp (Vercel allows this)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tmpPath = `/tmp/${file.name}`;
    await fs.promises.writeFile(tmpPath, buffer);

    console.log("📂 Uploaded file path:", tmpPath);

    // Extract text from PDF
    const text = await extractPdfText(tmpPath);
    console.log("✅ Extracted text length:", text.length);

    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        error: "PDF too short or unreadable (possibly scanned images)",
      });
    }

    // Number of questions (optional field from form)
    const numQuestions =
      Number(formData.get("numQuestions")) || 5;

    // Generate quiz
    const quiz = await generateQuizFromText(text, { numQuestions });
    console.log("✅ Quiz generated:", quiz.length);

    if (!quiz || quiz.length === 0) {
      return res.status(500).json({ error: "Quiz generation failed" });
    }

    return res.status(200).json({ questions: quiz });
  } catch (err) {
    console.error("❌ Upload handler error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Unexpected server error" });
  }
}
