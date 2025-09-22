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
      console.error("Form parse error:", err);
      return res.status(400).json({ error: "Failed to parse upload" });
    }

    const file = files.file || Object.values(files)[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const filePath = file.filepath || file.path;
      const text = await extractPdfText(filePath);

      if (!text || text.trim().length < 20) {
        return res.status(400).json({ error: "PDF too short or unreadable" });
      }

      const quiz = await generateQuizFromText(text);
      return res.json({ questions: quiz });
    } catch (e) {
      console.error("Upload handler error:", e);
      return res.status(500).json({ error: "Failed to process PDF" });
    }
  });
}
