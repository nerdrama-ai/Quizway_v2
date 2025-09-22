
Restructured repo for Vercel deployment.

Key points:
- Frontend (Vite React) is at project root (index.html, src/).
- Serverless API route available at /api/quiz/upload (uses formidable + pdf-parse + Google Generative AI).
- Set GEMINI_API_KEY in Vercel Environment Variables for Gemini to work.
- Run locally: `npm install` then `npm run dev` (Vite). To test serverless locally use Vercel CLI or adapt a small Express wrapper.

Files added:
- api/quiz/upload.js
- api/services/pdfService.js
- api/services/geminiService.js
- package.json (merged)

Notes:
- I converted the Express endpoint to a Vercel serverless handler using formidable.
- Keep an eye on environment variables and API keys.
