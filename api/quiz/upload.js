// api/quiz/upload.js
// Vercel / serverless route handler to accept a PDF file, parse it with the improved pdfService,
// optionally upload images to storage, and call quizService to generate quizzes per section.

import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import formidable from 'formidable';
import { parsePdfBufferToSections } from './services/pdfService.js'; // new parser

let storageService = null;
try {
  storageService = await import('./services/storageService.js');
} catch (e) {
  /* optional */
}
let quizService = null;
try {
  quizService = await import('./services/quizService.js');
} catch (e) {
  /* optional */
}

const readFile = util.promisify(fs.readFile);
const unlink = util.promisify(fs.unlink);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 30 * 1024 * 1024); // 30MB default
const ALLOWED_MIMES = ['application/pdf'];

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const form = formidable({ multiples: false, maxFileSize: MAX_UPLOAD_BYTES });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('form.parse error', err);
      res.status(400).json({ error: 'Invalid form upload.' });
      return;
    }

    const fileKey = Object.keys(files)[0];
    if (!fileKey) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }

    const file = files[fileKey];
    if (!file || !file.filepath) {
      res.status(400).json({ error: 'Invalid uploaded file.' });
      return;
    }

    // Basic validation
    const mime = file.mimetype || file.type || '';
    if (!ALLOWED_MIMES.includes(mime)) {
      // allow by extension fallback
      if (path.extname(file.originalFilename || file.filepath).toLowerCase() !== '.pdf') {
        await safeUnlink(file.filepath);
        res.status(400).json({ error: 'Only PDF uploads are allowed.' });
        return;
      }
    }

    try {
      // Read file into buffer
      const buffer = await readFile(file.filepath);

      // Call parser - pass options from fields or env
      const runMathOcr =
        fields.runMathOcr === 'true' ||
        process.env.RUN_MATH_OCR === 'true' ||
        false;
      const maxMathOcrImages = Number(
        fields.maxMathOcrImages ||
          process.env.MAX_MATH_OCR_IMAGES ||
          5
      );

      const parseOptions = {
        minSectionChars: fields.minSectionChars
          ? Number(fields.minSectionChars)
          : undefined,
        runMathOcr,
        maxMathOcrImages,
      };

      const parseResult = await parsePdfBufferToSections(buffer, parseOptions);

      // parseResult: { fullText, sections: [{title, level, content, startPage, endPage, formulas[], images[] }], images[], metadata }
      // If storageService is available, upload images and replace base64 with URLs for LLM usage (optional).
      const uploadedImagesMap = {}; // filename -> url

      if (
        storageService &&
        storageService.uploadBuffer &&
        Array.isArray(parseResult.images) &&
        parseResult.images.length > 0
      ) {
        // Upload images in parallel but limit concurrency (simple sequential for safety)
        for (const img of parseResult.images) {
          try {
            // img.data is expected to be a data URI like 'data:image/png;base64,...'
            const dataUri = img.data;
            // convert to buffer
            const base64Part = dataUri.split(',')[1];
            const buf = Buffer.from(base64Part, 'base64');
            const filename = `extracted/page-${img.page}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}.${(img.filename && img.filename.split('.').pop()) || 'png'}`;
            // storageService.uploadBuffer should return a public URL or signed URL.
            const uploadRes = await storageService.uploadBuffer(
              buf,
              {
                filename,
                contentType: img.mime || 'image/png',
              }
            );
            uploadedImagesMap[img.filename] = uploadRes.url || uploadRes;
            // attach the URL to the img object as url
            img.url = uploadRes.url || uploadRes;
          } catch (ue) {
            console.warn('Image upload failed for', img.filename, ue.message || ue);
          }
        }
      }

      // Map sections to prompts / call quizService.
      // We'll attempt to call quizService.generateQuizFromSection(section, options)
      // If not present, we'll fallback to returning parseResult only.
      const quizResults = [];
      if (
        quizService &&
        quizService.generateQuizFromSection &&
        typeof quizService.generateQuizFromSection === 'function'
      ) {
        for (const section of parseResult.sections) {
          // Prepare section payload for LLM
          const sectionPayload = {
            title: section.title,
            level: section.level,
            content: section.content,
            startPage: section.startPage,
            endPage: section.endPage,
            formulas: section.formulas || [],
            images: (section.images || []).map((img) => ({
              filename: img.filename,
              page: img.page,
              mime: img.mime,
              url:
                img.url || uploadedImagesMap[img.filename] || null,
              ocrText: img.ocrText || null,
            })),
            // any extra fields you want forwarded
          };

          try {
            const quiz = await quizService.generateQuizFromSection(
              sectionPayload,
              {
                questionsPerSection: fields.questionsPerSection
                  ? Number(fields.questionsPerSection)
                  : 6,
                // forward other options if needed
              }
            );
            quizResults.push({
              section: section.title,
              startPage: section.startPage,
              quiz,
            });
          } catch (qerr) {
            console.warn(
              'quizService.generateQuizFromSection failed for',
              section.title,
              qerr
            );
            // still push a placeholder so caller knows generation failed for this section
            quizResults.push({
              section: section.title,
              startPage: section.startPage,
              error: String(qerr),
            });
          }
        }
      }

      // Final response: parsed metadata + per-section quizResult if available
      const out = {
        success: true,
        parsed: {
          metadata: parseResult.metadata,
          sectionCount: parseResult.sections.length,
          sections: parseResult.sections.map((s) => ({
            title: s.title,
            level: s.level,
            startPage: s.startPage,
            endPage: s.endPage,
            formulaCount: (s.formulas || []).length,
            imageCount: (s.images || []).length,
          })),
        },
        quizzes: quizResults,
      };

      res.status(200).json(out);
    } catch (e) {
      console.error('Upload handler error:', e);
      res.status(500).json({
        error: 'Failed to process PDF',
        details: String(e && e.message ? e.message : e),
      });
    } finally {
      // cleanup temp file
      await safeUnlink(file.filepath);
    }
  });
}

async function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) await unlink(p);
  } catch (err) {
    // ignore
  }
}
