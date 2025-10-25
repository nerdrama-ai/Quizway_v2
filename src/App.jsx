// FILE: src/App.jsx
import React, { useState } from "react"
import { getTopics } from "./data/topics"
import Home from "./pages/Home"
import TopicPage from "./pages/TopicPage"
import Header from "./components/Header"
import Admin from "./pages/Admin"
import { motion, AnimatePresence } from "framer-motion"

export default function App() {
  // ✅ load topics into state so we can update dynamically
  const [topics, setTopics] = useState(getTopics())
  const [route, setRoute] = useState({ name: "home" })

  function openTopic(id) {
    const topic = topics.find((t) => t.id === id)
    setRoute({ name: "topic", topic })
  }

  function goHome() {
    // refresh topics in case Admin made changes
    setTopics(getTopics())
    setRoute({ name: "home" })
  }

  function goAdmin() {
    setRoute({ name: "admin" })
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-white">
      {/* Header */}
      <Header
        title="⚡ The Quizway"
        onHome={goHome}
        onAdmin={goAdmin}
        currentPage={route.name}
      />

      {/* Page transitions */}
      <main className="flex-1">
        <AnimatePresence mode="wait">
          {route.name === "home" && (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.4 }}
            >
              <Home topics={topics} onOpen={openTopic} onAdmin={goAdmin} />
            </motion.div>
          )}

          {route.name === "topic" && (
            <motion.div
              key="topic"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.4 }}
            >
              <TopicPage topic={route.topic} onHome={goHome} />
            </motion.div>
          )}

          {route.name === "admin" && (
            <motion.div
              key="admin"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.4 }}
            >
              <Admin onHome={goHome} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Futuristic Footer */}
      <footer className="text-center p-4 text-xs text-slate-400 bg-white/5 backdrop-blur-md border-t border-white/10">
        <span className="bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent font-semibold">
          Built with ❤️ by Vishnu and Adi
        </span>
      </footer>
    </div>
  )
}
