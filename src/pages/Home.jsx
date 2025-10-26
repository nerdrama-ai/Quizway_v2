// FILE: src/pages/Home.jsx
import React, { useState } from "react"
import { motion } from "framer-motion"

export default function Home({ topics, onOpen }) {
  const [query, setQuery] = useState("")

  // Normalize search query
  const q = query.toLowerCase().trim()

  // Filter topics based on search query (title, description, or keywords)
  const filteredTopics = topics.filter((t) => {
    const inTitle = t.title.toLowerCase().includes(q)
    const inDesc = t.description.toLowerCase().includes(q)
    const inKeywords = (t.keywords || []).some((kw) =>
      kw.toLowerCase().includes(q)
    )
    return inTitle || inDesc || inKeywords
  })

  return (
    <main className="p-8 min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-slate-800 text-white">
      {/* Logo Header */}
      <div className="flex flex-col items-center mb-8">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
          The Quizway
        </h1>
        <p className="text-slate-300 mt-2 text-sm md:text-base">
          Sharpen your mind, one quiz at a time
        </p>
      </div>

      {/* Search Bar */}
      <div className="flex justify-center mb-10">
        <input
          type="text"
          placeholder="🔍 Search topics by title, description, or keyword..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full md:w-2/3 xl:w-1/2 px-4 py-2 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      {/* Topics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredTopics.map((t, idx) => (
          <motion.article
            key={t.id}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.1 }}
            className="p-6 rounded-2xl bg-white/10 backdrop-blur-md shadow-lg hover:shadow-xl hover:scale-[1.02] transition cursor-pointer border border-white/20"
          >
            <h3 className="font-bold text-xl mb-2">{t.title}</h3>
            <p className="text-sm text-slate-300">{t.description}</p>

            {/* Keywords */}
            {t.keywords && t.keywords.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {t.keywords.map((kw, i) => (
                  <span
                    key={i}
                    className="px-2 py-1 text-xs rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  >
                    #{kw}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-4">
              <button
                onClick={() => onOpen(t.id)}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-semibold hover:opacity-90 transition"
              >
                Start Quiz →
              </button>
            </div>
          </motion.article>
        ))}
      </div>
    </main>
  )
}
