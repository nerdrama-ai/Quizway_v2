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
      console.error("❌ No file object received:", files);
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const filePath = file.filepath || file.path;
      console.log("📂 File received:", file);
      console.log("📂 Using filePath:", filePath);

      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(400).json({ error: "Uploaded file path invalid" });
      }

      const text = await extractPdfText(filePath);
      console.log("✅ Extracted text length:", text?.length || 0);

      if (!text || text.trim().length < 20) {
        return res.status(400).json({
          error: "PDF too short or unreadable (possibly scanned images)",
        });
      }

      const quiz = await generateQuizFromText(text);
      console.log("✅ Quiz generated:", quiz?.length || 0, "questions");

      if (!quiz || quiz.length === 0) {
        return res.status(500).json({ error: "Quiz generation failed" });
      }

      return res.status(200).json({ questions: quiz });
    } catch (e) {
      console.error("❌ Upload handler error:", e);
      return res
        .status(500)
        .json({ error: e.message || "Unexpected server error" });
    }
  });
}
