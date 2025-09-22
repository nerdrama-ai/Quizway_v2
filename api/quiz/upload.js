import path from "path";
import { fileURLToPath } from "url";
import formidable from "formidable";
import fs from "fs";
import { extractPdfText } from "../services/pdfService.js";
import { generateQuizFromText } from "../services/geminiService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const uploadDir = path.join(__dirname, "../../tmp");
  fs.mkdirSync(uploadDir, { recursive: true });

  const form = formidable({
    multiples: false,
    uploadDir,
    keepExtensions: true,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(400).json({ error: "Failed to parse upload" });
    }

    const file = files.file || Object.values(files)[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const filePath = file.filepath || file.path;
      if (!filePath) {
        console.error("❌ File path missing:", file);
        return res.status(400).json({ error: "Invalid uploaded file path" });
      }

      // Extract text from PDF
      const text = await extractPdfText(filePath);
      console.log("✅ Extracted PDF text length:", text?.length || 0);

      if (!text || text.trim().length < 20) {
        return res.status(400).json({
          error: "PDF too short or unreadable (might be scanned images)",
        });
      }

      // Generate quiz
      const quiz = await generateQuizFromText(text);
      if (!quiz || quiz.length === 0) {
        console.error("❌ Quiz generation returned empty result");
        return res.status(500).json({ error: "Quiz generation failed" });
      }

      console.log("✅ Generated quiz with", quiz.length, "questions");
      return res.status(200).json({ questions: quiz });
    } catch (e) {
      console.error("❌ Upload handler error:", e);
      return res
        .status(500)
        .json({ error: "Unexpected server error while processing PDF" });
    }
  });
}
