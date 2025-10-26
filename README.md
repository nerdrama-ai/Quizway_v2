
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



## Deployment & Security Checklist (added by assistant)

1. Environment variables:
   - `OPENAI_API_KEY` (required) — your OpenAI/OpenRouter API key.
   - `S3_*` if using S3 storage (optional).

2. File upload security:
   - Only `application/pdf` MIME type is allowed.
   - Max upload size enforced: 10 MB by default (adjust in `api/quiz/upload.js` and `python-service/pdf_service.py`).

3. Backend hardening:
   - Never return server temp file paths in API responses.
   - Sanitize uploaded filenames.
   - Validate and strictly parse model outputs. Fallback to a local generator if API fails.

4. Production tips:
   - Run Python service with uvicorn behind a reverse proxy.
   - Use HTTPS, set proper CORS (restrict origins).
   - Add rate limiting (e.g. Cloudflare or API gateway) to prevent abuse.
   - Rotate API keys and store them in secret manager (Vercel, AWS Secrets Manager).

