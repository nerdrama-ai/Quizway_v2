import path from "path";
import { fileURLToPath } from "url";
import formidable from "formidable";
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
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const form = formidable({ multiples: false, uploadDir: "/tmp", keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("Form parse error:", err);
      res.status(500).json({ error: "Failed to parse upload" });
      return;
    }

    const file = files.file || files.upload || Object.values(files)[0];
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    try {
      const text = await extractPdfText(file.path);
      if (!text || text.trim().length < 20) {
        return res.status(400).json({ error: "PDF too short or unreadable" });
      }
      const quiz = await generateQuizFromText(text);
      res.json({ questions: quiz });
    } catch (e) {
      console.error("Upload handler error:", e);
      res.status(500).json({ error: "Failed to process PDF" });
    }
  });
}
