// /api/services/quizService.js
import OpenAI from "openai";

// --- OpenRouter Configuration ---
const OPENROUTER_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

if (!OPENROUTER_API_KEY) {
  console.error("❌ Missing OpenRouter API key! Please add OPENAI_API_KEY in Vercel.");
}

// Initialize OpenRouter client
const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
});

console.log("🔗 Using OpenRouter API base:", OPENROUTER_BASE_URL);

// --- Utility helpers ---
function findJsonCodeBlock(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return m && m[1] ? m[1].trim() : null;
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
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}

function validateQuestionsArray(arr) {
  if (!Array.isArray(arr)) return false;
  for (const q of arr) {
    if (
      !q ||
      typeof q !== "object" ||
      !q.question ||
      !Array.isArray(q.options) ||
      q.options.length !== 4 ||
      typeof q.hint !== "string" ||
      typeof q.explanation !== "string" ||
      typeof q.answer !== "number" ||
      q.answer < 1 ||
      q.answer > 4
    ) {
      return false;
    }
  }
  return true;
}

// --- Local fallback ---
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
    const answerWord = words.sort((a, b) => b.length - a.length)[0] || "Answer";
    const correct = answerWord.replace(/[^A-Za-z0-9-]/g, "");
    const questionText = s.replace(answerWord, "_____");
    const opts = new Set([correct]);
    while (opts.size < 4) opts.add(Math.random().toString(36).substring(2, 8));
    const options = Array.from(opts);
    const answerIndex = options.indexOf(correct);
    questions.push({
      id: String(i + 1),
      question: questionText,
      options,
      hint: "Focus on the missing keyword in the sentence.",
      answer: (answerIndex >= 0 ? answerIndex : 0) + 1,
      explanation: `The missing word '${correct}' fits best in the context.`,
    });
  }
  return questions;
}

// --- Main Quiz Generator using OpenRouter ---
export async function generateQuizFromText(text, numQuestions = 5) {
  if (!text || text.trim().length < 100) {
    return { questions: [], reason: "Text too short" };
  }

  const prompt = `
Generate exactly ${numQuestions} multiple-choice quiz questions from the following text.
Each question must have:
- "question": the question text
- "options": exactly 4 unique answer choices
- "hint": a short helpful hint
- "answer": the correct option number (1–4)
- "explanation": a brief explanation of why that answer is correct.

Return ONLY valid JSON (no markdown or extra commentary).
Example:
[
  {
    "id": "1",
    "question": "What is linear regression used for?",
    "options": [
      "Predicting continuous outcomes",
      "Predicting categorical outcomes",
      "Data encryption",
      "Sorting data"
    ],
    "hint": "Think about the type of variable predicted.",
    "answer": 1,
    "explanation": "Linear regression predicts continuous outcomes using a linear relationship."
  }
]

Text:
${text.slice(0, 4000)}
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise quiz generator that outputs strict JSON arrays only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 1200,
    });

    const raw = response.choices?.[0]?.message?.content || "";
    let jsonString = findJsonCodeBlock(raw) || findBalanced(raw) || repairJsonString(raw);
    let parsed = [];

    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      console.warn("⚠️ JSON parse failed:", err.message);
      try {
        parsed = JSON.parse(repairJsonString(jsonString));
      } catch {
        parsed = [];
      }
    }

    if (validateQuestionsArray(parsed)) {
      console.log(`✅ Quiz generated with ${parsed.length} questions`);
      return { questions: parsed, reason: "AI generated" };
    } else {
      console.warn("⚠️ Invalid AI JSON, using local fallback");
      return { questions: localGenerator(text, numQuestions), reason: "Invalid AI JSON" };
    }
  } catch (err) {
    console.error("❌ OpenRouter error:", err.message);
    return { questions: localGenerator(text, numQuestions), reason: "OpenRouter error" };
  }
}
