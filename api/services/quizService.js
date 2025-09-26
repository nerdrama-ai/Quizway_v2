// api/services/quizService.js
import OpenAI from "openai";

/**
 * Robust quiz generator:
 * - Calls OpenAI if OPENAI_API_KEY exists
 * - Attempts to extract JSON from the model response even if it's wrapped in text/code fences
 * - Falls back to a local generator if LLM fails or returns unparsable output
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
  // Keep only from first { or [
  const first = s.search(/[\{\[]/);
  if (first !== -1) s = s.slice(first);
  // Cut after last } or ]
  const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastClose !== -1) s = s.slice(0, lastClose + 1);
  // remove trailing commas
  s = s.replace(/,\s*([}\]])/g, "$1");
  // replace single quotes in simple cases
  s = s.replace(/(['"])?([a-zA-Z0-9_ -]+)\1\s*:\s*'([^']*)'/g, '"$2":"$3"');
  s = s.replace(/'([a-zA-Z0-9_ -]+)'\s*:/g, '"$1":');
  s = s.replace(/:\s*'([^']*)'/g, (m, p1) => `:"${p1.replace(/"/g, '\\"')}"`);
  // drop control chars
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}

function validateQuestionsArray(arr) {
  if (!Array.isArray(arr)) return false;
  for (const q of arr) {
    if (typeof q !== "object") return false;
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
    if (!answerWord) {
      answerWord = words.sort((a, b) => b.length - a.length)[0] || "";
    }
    const correct = answerWord.replace(/[^A-Za-z0-9-]/g, "");
    const questionText = s.replace(answerWord, "_____");
    const scramble = (w) =>
      w
        .split("")
        .sort(() => 0.5 - Math.random())
        .join("")
        .slice(0, Math.max(3, Math.min(8, w.length)));
    const opts = new Set();
    opts.add(correct || "Option");
    while (opts.size < 4) opts.add(scramble(correct + String(Math.random()).slice(2)));
    const options = Array.from(opts).slice(0, 4);
    const answerIndex = options.indexOf(correct);
    questions.push({
      id: String(i + 1),
      question: questionText,
      options,
      answer: answerIndex >= 0 ? answerIndex : 0,
      explanation: "",
    });
  }
  return questions;
}

async function callOpenAI(messages, maxTokens = 900) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  // usage for OpenAI npm package v4-style; this tries to use chat completions endpoint
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    n: 1,
  });

  // be defensive: handle multiple shapes
  const content =
    resp?.choices?.[0]?.message?.content ||
    resp?.choices?.[0]?.text ||
    (typeof resp === "string" ? resp : "");

  return content || "";
}

export async function generateQuizFromText(text, { numQuestions = 5 } = {}) {
  if (!text || text.trim().length === 0) return [];

  // If small text, do local generator
  if (text.trim().length < 200) return localGenerator(text, numQuestions);

  // Prepare prompt
  const systemPrompt = `You are a helpful assistant that creates multiple-choice quizzes from educational text.
Return a JSON object (or JSON array) ONLY. No extra commentary. Schema:

{
  "questions": [
    {
      "id": "1",
      "question": "Full question text",
      "options": ["option A", "option B", "option C", "option D"],
      "answer": 2,
      "explanation": "optional short explanation"
    }
  ]
}

Generate ${numQuestions} clear, distinct multiple-choice questions faithful to the source text.`;

  const userPrompt = `Text to use for quiz generation:\n\n${text}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Try OpenAI if key available
  if (OPENAI_API_KEY) {
    try {
      const aiText = await callOpenAI(messages, 1200);

      // Try to extract JSON
      let jsonText = findJsonCodeBlock(aiText) || findBalanced(aiText) || aiText;
      jsonText = repairJsonString(jsonText);

      try {
        let parsed = JSON.parse(jsonText);
        // If root is object with questions
        if (parsed?.questions && validateQuestionsArray(parsed.questions)) {
          parsed.questions = parsed.questions.slice(0, numQuestions);
          return parsed.questions;
        }
        // If root is array
        if (Array.isArray(parsed) && validateQuestionsArray(parsed)) {
          return parsed.slice(0, numQuestions);
        }
      } catch (e) {
        // If JSON.parse fails try to find balanced again in the original aiText
        const balanced = findBalanced(aiText);
        if (balanced) {
          try {
            const repaired = repairJsonString(balanced);
            const parsed2 = JSON.parse(repaired);
            if (parsed2?.questions && validateQuestionsArray(parsed2.questions)) {
              return parsed2.questions.slice(0, numQuestions);
            }
            if (Array.isArray(parsed2) && validateQuestionsArray(parsed2)) {
              return parsed2.slice(0, numQuestions);
            }
          } catch (e2) {
            // ignore and fallthrough
          }
        }
        console.warn("AI produced unparsable JSON.");
      }
    } catch (err) {
      console.warn("OpenAI call failed:", err?.message || err);
    }
  }

  // final fallback
  return localGenerator(text, numQuestions);
}
