// api/services/quizService.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateQuizFromText(text, { numQuestions = 5 } = {}) {
  if (!text || text.trim().length === 0) return [];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // fast & reliable, you can use gpt-4.1 for higher quality
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are a quiz generator. Return ONLY valid JSON (no commentary).
Format:
[
  {
    "id": "1",
    "question": "Full question text",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": 2
  }
]`,
        },
        {
          role: "user",
          content: `Generate ${numQuestions} multiple-choice questions based on this text:\n\n${text}`,
        },
      ],
      response_format: { type: "json" }, // ⬅️ ensures valid JSON
    });

    const raw = response.choices[0].message.content;
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.slice(0, numQuestions) : [];
  } catch (err) {
    console.error("❌ OpenAI quiz generation failed:", err);
    return [];
  }
}
