// /api/services/quizService.js
import OpenAI from "openai";

// --- OpenRouter Configuration ---
const OPENROUTER_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
      typeof q.correct !== "number" ||
      q.correct < 1 ||
      q.correct > 4
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

// --- Helpers for topic/subtopic segmentation ---
function splitIntoTopics(text) {
  const lessons = text.split(/(?=LESSON\s*[-–]?\s*\d+)/gi).map(t => t.trim()).filter(Boolean);

  if (lessons.length <= 1) {
    const chunks = [];
    for (let i = 0; i < text.length; i += 2500) {
      chunks.push(text.slice(i, i + 2500));
    }
    return chunks;
  }
  return lessons;
}

function splitIntoSubtopics(topicText) {
  const parts = topicText.split(
    /(?=Activity|Know\s*this|Do\s*it\s*yourself|Sing\s*and\s*Enjoy|Play\s*the\s*game|Discuss\s*with|Observe)/gi
  ).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [topicText];
}

function estimateNumQuestions(blockText) {
  const words = blockText.split(/\s+/).length;
  return Math.max(3, Math.min(10, Math.round(words / 150)));
}

// --- Main Quiz Generator ---
export async function generateQuizFromText(text, numQuestions = 5) {
  if (!text || text.trim().length < 100) {
    return { questions: [], reason: "Text too short" };
  }

  const topics = splitIntoTopics(text);
  console.log(`🧩 Found ${topics.length} major topics`);

  const allQuestions = [];

  for (let t = 0; t < topics.length; t++) {
    const topic = topics[t];
    const topicTitle = topic.match(/LESSON\s*[-–]?\s*\d+[^\\n]*/i)?.[0] || `Topic ${t + 1}`;
    const subTopics = splitIntoSubtopics(topic);
    console.log(`📘 ${topicTitle} → ${subTopics.length} subtopics`);

    for (let s = 0; s < subTopics.length; s++) {
      const subText = subTopics[s];
      const subTitleMatch = subText.match(/^(Activity|Know\s*this|Do\s*it\s*yourself|Sing\s*and\s*Enjoy|Play\s*the\s*game|Observe)/i);
      const subTitle = subTitleMatch ? subTitleMatch[0] : `Section ${s + 1}`;
      const dynamicCount = estimateNumQuestions(subText);

      const prompt = `
Generate around ${dynamicCount} multiple-choice questions that cover all key ideas in the section below.
Each question must have:
- "question": the question text
- "options": exactly 4 unique answer choices
- "hint": a short helpful hint
- "correct": the correct option number (1–4)
- "explanation": a brief explanation of why that option is correct

Return ONLY valid JSON (no markdown, no commentary).

Section (${topicTitle} → ${subTitle}):
${subText.slice(0, 5000)}
`;

      try {
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: "You are a precise quiz generator that outputs strict JSON arrays only." },
            { role: "user", content: prompt },
          ],
          temperature: 0.6,
          max_tokens: 1500,
        });

        const raw = response.choices?.[0]?.message?.content || "";
        let jsonString = findJsonCodeBlock(raw) || findBalanced(raw) || repairJsonString(raw);
        let parsed = [];

        try {
          parsed = JSON.parse(jsonString);
        } catch (err) {
          console.warn(`⚠️ JSON parse failed for ${topicTitle} → ${subTitle}:`, err.message);
          try {
            parsed = JSON.parse(repairJsonString(jsonString));
          } catch {
            parsed = [];
          }
        }

        if (validateQuestionsArray(parsed)) {
          parsed.forEach((q, idx) => {
            q.id = `${t + 1}-${s + 1}-${idx + 1}`;
            q.topic = topicTitle;
            q.subTopic = subTitle;
          });
          allQuestions.push(...parsed);
          console.log(`✅ ${parsed.length} questions generated for ${topicTitle} → ${subTitle}`);
        } else {
          console.warn(`⚠️ Invalid AI quiz JSON, using local fallback for ${topicTitle} → ${subTitle}`);
          const fallbackQs = localGenerator(subText, dynamicCount);
          fallbackQs.forEach((q, idx) => {
            q.id = `${t + 1}-${s + 1}-L${idx + 1}`;
            q.topic = topicTitle;
            q.subTopic = subTitle;
          });
          allQuestions.push(...fallbackQs);
        }
      } catch (err) {
        console.error(`❌ OpenRouter error for ${topicTitle} → ${subTitle}:`, err.message);
        const fallbackQs = localGenerator(subText, dynamicCount);
        fallbackQs.forEach((q, idx) => {
          q.id = `${t + 1}-${s + 1}-E${idx + 1}`;
          q.topic = topicTitle;
          q.subTopic = subTitle;
        });
        allQuestions.push(...fallbackQs);
      }
    }
  }

  console.log(`✅ Total quiz questions generated: ${allQuestions.length}`);
  return { questions: allQuestions, reason: "Topic & Subtopic coverage" };
}
