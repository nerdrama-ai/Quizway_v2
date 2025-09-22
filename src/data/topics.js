// FILE: src/data/topics.js

// ✅ Default starter data (normalized schema)
const DEFAULT_TOPICS = [
  {
    id: "math",
    title: "Math Basics",
    description: "Arithmetic and logic",
    questions: [
      {
        id: "m1",
        question: "What is 7 + 6?",
        options: ["12", "13", "14", "11"],
        correct: 1,
        hint: "Think about 7 + 3 = 10 then +3",
        explanation: "7 + 6 = 13 because 7 + 3 = 10 then +3 = 13."
      },
      {
        id: "m2",
        question: "Which is a prime?",
        options: ["4", "6", "9", "11"],
        correct: 3,
        hint: "Only divisible by 1 and itself",
        explanation: "11 is prime because it has no divisors other than 1 and 11."
      }
    ]
  },
  {
    id: "science",
    title: "Science",
    description: "Basic science",
    questions: [
      {
        id: "s1",
        question: "Water boils at what °C at sea level?",
        options: ["90", "95", "100", "110"],
        correct: 2,
        hint: "It is a round number",
        explanation: "Water boils at 100°C at standard atmospheric pressure."
      }
    ]
  }
]

// ✅ Get topics (from localStorage if available, otherwise default)
export const getTopics = () => {
  try {
    const saved = localStorage.getItem("topics")
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (err) {
    console.error("Error reading topics from localStorage", err)
  }
  return DEFAULT_TOPICS
}

// ✅ Save topics (persist to localStorage)
export const saveTopics = (topics) => {
  try {
    localStorage.setItem("topics", JSON.stringify(topics))
  } catch (err) {
    console.error("Error saving topics to localStorage", err)
  }
}

// ✅ Export initial topics for non-admin pages (fallback)
export const TOPICS = getTopics()
