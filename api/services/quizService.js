// /Quizway_v2-main/api/services/quizService.js
import OpenAI from "openai";

/* Robust quiz generation:
 - Uses OPENAI_API_KEY if available
 - Sends a system + user prompt asking for EXACT JSON
 - Performs defensive extraction: code fence detection, balanced-brace extraction, repairs
 - Falls back to a local generator if model fails
*/

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function findJsonCodeBlock(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function findBalanced(s) {
  const start = s.search(/[\{\[]/);
  if (start === -1) return null;
  const openChar = s[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === openChar) depth++;
    else if (s[i] === closeChar) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function repairJsonString(str) {
  if (!str || typeof str !== "string") return str;
  let s = str.trim();
  const first = s.search(/[\{\[]/);
  if (first !== -1) s = s.slice(first);
  const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastClose !== -1) s = s.slice(0, lastClose + 1);
  s = s.replace(/,\s*([}\]])/g, "$1");
  s = s.replace(/(['"])?([a-zA-Z0-9_ -]+)\1\s*:\s*'([^']*)'/g, '"$2":"$3"');
  s = s.replace(/'([a-zA-Z0-9_ -]+)'\s*:/g, '"$1":');
  s = s.replace(/:\s*'([^']*)'/g, (m, p1) => `:"${p1.replace(/"/g, '\\"')}"`);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}

function validateQuestionsArray(arr) {
  if (!Array.isArray(arr)) return false;
  for (const q of arr) {
    if (!q || typeof q !== "object") return false;
    if (!q.question || !Array.isArray(q.options) || q.options.length < 2) return false;
    if (!("answer" in q)) return false;
  }
  return true;
}

function localGenerator(text, numQuestions = 5) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/[.?!]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

  const questions = [];
  for (let i = 0; i < Math.min(numQuestions, sentences.length); i++) {
    const s = sentences[i];
    const words = s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    let answerWord = words.find((w, idx) => /^[A-Z][a-z]/.test(w) && idx > 0);
    if (!answerWord) answerWord = words.sort((a, b) => b.length - a.length)[0] || "";
    const correct = answerWord.replace(/[^A-Za-z0-9-]/g, "");
    const questionText = s.replace(answerWord, "_____");
    const scramble = (w) => w.split("").sort(() => 0.5 - Math.random()).join("").slice(0, Math.max(3, Math.min(8, w.length)));
    const opts = new Set([correct || "Option"]);
    while (opts.size < 4) opts.add(scramble(correct + String(Math.random()).slice(2)));
    const options = Array.from(opts).slice(0, 4);
    const answerIndex = options.indexOf(correct);
    questions.push({ id: String(i + 1), question: questionText, options, answer: answerIndex >= 0 ? answerIndex : 0, explanation: "" });
  }
  return questions;
}

async function callOpenAI(messages, maxTokens = 900) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    n: 1,
  });
  const content = resp?.choices?.[0]?.message?.content || resp?.choices?.[0]?.text || "";
  return content;
}

export async function generateQuizFromText(text, { numQuestions = 5, requestId } = {}) {
  if (!text || !text.trim()) return [];

  // If short text, use local generator
  if (text.trim().length < 200) return localGenerator(text, numQuestions);

  if (!OPENAI_API_KEY) {
    console.warn(`[${requestId}] OPENAI_API_KEY not set; using local generator`);
    return localGenerator(text, numQuestions);
  }

  const systemPrompt = `You are a helpful assistant that creates multiple-choice quizzes from educational text.
Return EXACT valid JSON (no commentary). Schema:

{
  "questions": [
    {
      "id": "1",
      "question": "Full question text",
      "options": ["A","B","C","D"],
      "answer": 2,
      "explanation": "optional"
    }
  ]
}

Generate ${numQuestions} questions faithful to the text.`;

  const userPrompt = `Text to use:\n\n${text.slice(0, 30000)}`; // trim to safe prompt size

  try {
    const aiText = await callOpenAI([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], 1200);
    // try to extract JSON
    let jsonText = findJsonCodeBlock(aiText) || findBalanced(aiText) || aiText;
    jsonText = repairJsonString(jsonText);
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed?.questions && validateQuestionsArray(parsed.questions)) {
        return parsed.questions.slice(0, numQuestions);
      }
      if (Array.isArray(parsed) && validateQuestionsArray(parsed)) {
        return parsed.slice(0, numQuestions);
      }
    } catch (e) {
      // attempt balanced extraction from aiText again
      const balanced = findBalanced(aiText);
      if (balanced) {
        try {
          const repaired = repairJsonString(balanced);
          const parsed2 = JSON.parse(repaired);
          if (parsed2?.questions && validateQuestionsArray(parsed2.questions)) return parsed2.questions.slice(0, numQuestions);
          if (Array.isArray(parsed2) && validateQuestionsArray(parsed2)) return parsed2.slice(0, numQuestions);
        } catch (e2) {
          console.warn(`[${requestId}] JSON parse fallback failed`);
        }
      }
      console.warn(`[${requestId}] OpenAI returned unparsable JSON. Falling back to local generator`);
    }
  } catch (err) {
    console.warn(`[${requestId}] OpenAI call failed: ${err.message || err}`);
  }

  // final fallback
  return localGenerator(text, numQuestions);
}
