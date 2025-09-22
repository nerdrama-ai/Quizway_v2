import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY || "";

/**
 * Generate quiz questions from text.
 * Uses Gemini if API key available, otherwise falls back to a simple local generator.
 */
export async function generateQuizFromText(text) {
  if (!text || text.trim().length === 0) return [];

  if (apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });

      const prompt = `
      You are a quiz generator.
      Given the following text, create 5 multiple-choice questions.
      Return only a JSON array, where each object has:
      - id (string)
      - question (string)
      - options (array of 4 strings)
      - answer (index of correct option, 0-3)

      Text:
      ${text}
      `;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const parsed = JSON.parse(responseText);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn("Gemini failed, using fallback:", err);
    }
  }

  // === Fallback generator (ensures app still works) ===
  const sentences = text.split(/[.?!]\s+/).filter((s) => s.length > 20);
  const questions = sentences.slice(0, 5).map((s, i) => ({
    id: String(i + 1),
    question: s.replace(/(\w{6,})/, "_____"),
    options: ["Option A", "Option B", "Option C", "Option D"],
    answer: 0,
  }));
  return questions;
}
