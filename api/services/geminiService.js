import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function generateQuizFromText(text) {
  const prompt = `
You are a quiz generator.
Given the following text, create 5 multiple-choice questions.
Return only valid JSON in the following format:

"id": "1",
"question": "Question text",
"options": ["A","B","C","D"],
"answer": 0

Text:
${text}
`;

  // NOTE: this uses the Google Generative AI client. If you do not have GEMINI_API_KEY
  // set in Vercel env vars, this will fail. This function calls the API and expects
  // a plain JSON array in response. For offline testing or without key, it will throw.
  const res = await genAI.generateText({ prompt });

  // The client may return a structured object; try to parse
  try {
    const json = JSON.parse(res.text || res);
    return json;
  } catch (e) {
    // If parsing fails, return a fallback empty array
    console.warn("Failed to parse Gemini response:", e);
    return [];
  }
}
