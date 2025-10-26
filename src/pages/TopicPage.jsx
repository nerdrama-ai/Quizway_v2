// FILE: src/pages/TopicPage.jsx
import React, { useState, useEffect } from "react"
import { motion } from "framer-motion"
import Scorecard from "../components/Scorecard"
import Quiz from "../components/Quiz"

export default function TopicPage({ topic, onHome }) {
  const total = topic.questions.length
  const [progress, setProgress] = useState(0)
  const [started, setStarted] = useState(false)
  const [showBox, setShowBox] = useState(false)
  const [completed, setCompleted] = useState(false)

  useEffect(() => {
    if (completed) setShowBox(false)
  }, [completed])

  function handleStart() {
    setStarted(true)
    setShowBox(true)
  }

  function handleComplete() {
    setCompleted(true)
    setProgress(total)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-8">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <Scorecard title={topic.title} progress={progress} total={total} />
        <div>
          <button
            onClick={onHome}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-slate-700 to-slate-600 text-white hover:opacity-80 shadow"
          >
            ← Back
          </button>
        </div>
      </div>

      {/* Topic intro */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-3xl mx-auto text-center mt-10"
      >
        <h1 className="text-3xl font-extrabold mb-4 bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
          {topic.title}
        </h1>
        <p className="text-slate-300 mb-6">{topic.description}</p>

        {!started && (
          <button
            onClick={handleStart}
            className="px-8 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold shadow-md hover:scale-105 transition"
          >
            Start Quiz 🚀
          </button>
        )}

        {completed && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="mt-8 text-emerald-400 font-bold text-xl"
          >
            🎉 Quiz complete! Well done.
          </motion.div>
        )}
      </motion.div>

      {/* Quiz container */}
      {showBox && !completed && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-10"
        >
          <Quiz
            topic={topic} 
            onBack={onHome}
            onComplete={handleComplete}
            onProgressUpdate={(qIdx) => setProgress(qIdx)}
          />
        </motion.div>
      )}
    </div>
  )
}
