// /api/services/quizService.js
import OpenAI from "openai";

// --- OpenRouter Configuration ---
const OPENROUTER_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

if (!OPENROUTER_API_KEY) {
  console.error("❌ Missing OpenRouter API key! Please add OPENAI_API_KEY in Vercel.");
}

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
});

console.log("🔗 Using OpenRouter API base:", OPENROUTER_BASE_URL);

// --- Utility helpers ---
function findJsonCodeBlock(s) {
  const m = s.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
  return m && m[1] ? m[1].trim() : null;
}

function findBalanced(s) {
  const start = s.search(/[\\{\\[]/);
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
  const first = s.search(/[\\{\\[]/);
  if (first !== -1) s = s.slice(first);
  const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastClose !== -1) s = s.slice(0, lastClose + 1);
  s = s.replace(/,\\s*([}\\]])/g, "$1");
  s = s.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, "");
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
      typeof q.correct !== "number" ||
      q.correct < 1 ||
      q.correct > 4
    ) {
      return false;
    }
  }
  return true;
}

// --- Local fallback generator ---
function localGenerator(text, numQuestions = 8) {
  const sentences = text
    .replace(/\\s+/g, " ")
    .split(/[.?!]\\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);

  const questions = [];
  for (let i = 0; i < Math.min(numQuestions, sentences.length); i++) {
    const s = sentences[i];
    const words = s.split(/\\s+/).filter((w) => /[A-Za-z]/.test(w));
    const correctWord = words.sort((a, b) => b.length - a.length)[0] || "Answer";
    const correct = correctWord.replace(/[^A-Za-z0-9-]/g, "");
    const questionText = s.replace(correctWord, "_____");
    const opts = new Set([correct]);
    while (opts.size < 4) opts.add(Math.random().toString(36).substring(2, 8));
    const options = Array.from(opts);
    const correctIndex = options.indexOf(correct);
    questions.push({
      id: String(i + 1),
      question: questionText,
      options,
      hint: "Focus on the missing keyword in the sentence.",
      correct: (correctIndex >= 0 ? correctIndex : 0) + 1,
      explanation: `The missing word '${correct}' fits best in the context.`,
    });
  }
  return questions;
}

// --- Phase 1: Identify all topics and subtopics ---
async function identifyTopics(text) {
  const topicPrompt = `
Analyze the following text and identify all its major topics and key subtopics.
Return a JSON array like:
[
  {
    "topic": "Regression Analysis",
    "subtopics": ["Simple Linear Regression", "Multiple Regression", "Assumptions", "Applications"]
  },
  {
    "topic": "Correlation",
    "subtopics": ["Pearson Coefficient", "Causation", "Interpretation"]
  }
]
Focus on conceptual clusters, not paragraphs.
Text:
${text.slice(0, 8000)}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are an educational topic-mapper that outputs JSON only." },
        { role: "user", content: topicPrompt },
      ],
      temperature: 0.5,
      max_tokens: 900,
    });

    const raw = resp.choices?.[0]?.message?.content || "";
    let jsonString = findJsonCodeBlock(raw) || findBalanced(raw) || repairJsonString(raw);
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("⚠️ Topic extraction failed:", err.message);
    return [];
  }
}

// --- Phase 2: Generate conceptual questions per topic ---
export async function generateQuizFromText(text) {
  if (!text || text.trim().length < 100) {
    return { questions: [], reason: "Text too short" };
  }

  try {
    const topics = await identifyTopics(text);
    if (topics.length === 0) {
      console.warn("⚠️ No topics found, using fallback");
      return { questions: localGenerator(text, 8), reason: "No topics detected" };
    }

    console.log(`🧩 Found ${topics.length} topics — generating conceptual questions...`);
    let allQuestions = [];

    for (const topic of topics) {
      const subtopics = topic.subtopics?.join(", ") || "";
      const numQs = Math.floor(Math.random() * 2) + 3; // 3–4 questions per topic

      const topicPrompt = `
From the topic "${topic.topic}" and its subtopics (${subtopics}), generate ${numQs} multiple-choice questions.
Each question must explore a different angle:
- Conceptual understanding (what/why)
- Example or application
- Common misconception or tricky point
- Equation or definition (if relevant)

Each question must include:
- "question": string
- "options": array of 4 strings
- "hint": short string
- "correct": number (1–4)
- "explanation": short explanation of the answer

Return ONLY JSON (no markdown).
`;

      const resp = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a creative quiz generator that produces conceptually rich JSON output only." },
          { role: "user", content: topicPrompt },
        ],
        temperature: 0.9, // higher creativity
        max_tokens: 1200,
      });

      const raw = resp.choices?.[0]?.message?.content || "";
      let jsonString = findJsonCodeBlock(raw) || findBalanced(raw) || repairJsonString(raw);
      let parsed = [];

      try {
        parsed = JSON.parse(jsonString);
      } catch {
        parsed = [];
      }

      if (validateQuestionsArray(parsed)) {
        allQuestions = allQuestions.concat(parsed);
      }
    }

    if (allQuestions.length === 0) {
      console.warn("⚠️ No valid AI quiz output, using fallback");
      return { questions: localGenerator(text, 10), reason: "Invalid AI output" };
    }

    console.log(`✅ Generated ${allQuestions.length} creative questions from ${topics.length} topics.`);
    return { questions: allQuestions, reason: "AI generated by topic clusters" };

  } catch (err) {
    console.error("❌ OpenRouter error:", err.message);
    return { questions: localGenerator(text, 8), reason: "OpenRouter error" };
  }
}
