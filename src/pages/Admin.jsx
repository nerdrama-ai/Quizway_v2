// FILE: src/pages/Admin.jsx
import React, { useState, useEffect, useMemo } from "react"
import { getTopics, saveTopics } from "../data/topics"
import ProgressBar from "../components/ProgressBar"

export default function Admin({ onHome }) {
  /** ---------- LOGIN STATE ---------- **/
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const ADMIN_USER = "admin"
  const ADMIN_PASS = "pass"

  useEffect(() => {
    if (localStorage.getItem("isAuthenticated") === "true") {
      setIsAuthenticated(true)
    }
  }, [])

  const handleLogin = (e) => {
    e.preventDefault()
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      setIsAuthenticated(true)
      localStorage.setItem("isAuthenticated", "true")
      setError("")
    } else setError("Invalid username or password")
  }

  const handleLogout = () => {
    setIsAuthenticated(false)
    localStorage.removeItem("isAuthenticated")
  }

  /** ---------- TOPIC STATE ---------- **/
  const [topics, setTopics] = useState(() => getTopics() || [])
  const [activeTopicId, setActiveTopicId] = useState(() => getTopics()?.[0]?.id || null)
  const activeTopic = useMemo(() => topics.find((t) => t.id === activeTopicId) || null, [topics, activeTopicId])
  const [search, setSearch] = useState("")
  const [toasts, setToasts] = useState([])
  const [loadingQuiz, setLoadingQuiz] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const addToast = (message, type = "info") => {
    const id = Date.now().toString()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000)
  }

  const saveAndSetTopics = (updated) => {
    setTopics(updated)
    setIsSaving(true)
    saveTopics(updated)
    setTimeout(() => setIsSaving(false), 500)
  }

  const handleAddTopic = () => setShowUpload(true)

  const createEmptyTopic = () => {
    const newTopic = {
      id: Date.now().toString(),
      title: "Untitled Topic",
      description: "",
      timer: 0,
      keywords: [],
      questions: [],
    }
    saveAndSetTopics([...topics, newTopic])
    setActiveTopicId(newTopic.id)
    addToast("Empty topic added", "success")
  }

  const handleDeleteTopic = (id) => {
    if (!window.confirm("Delete this topic?")) return
    const updated = topics.filter((t) => t.id !== id)
    saveAndSetTopics(updated)
    if (activeTopicId === id) setActiveTopicId(updated[0]?.id || null)
    addToast("Topic deleted", "success")
  }

  const handleUpdateTopic = (id, key, value) => {
    const updated = topics.map((t) => (t.id === id ? { ...t, [key]: value } : t))
    saveAndSetTopics(updated)
  }

  const handleAddQuestion = (topicId) => {
    const newQ = {
      id: Date.now().toString(),
      question: "Untitled Question",
      options: ["", "", "", ""],
      correct: 0,
      hint: "",
      explanation: "",
    }
    const updated = topics.map((t) =>
      t.id === topicId ? { ...t, questions: [...t.questions, newQ] } : t
    )
    saveAndSetTopics(updated)
    addToast("Question added", "success")
  }

  const handleUpdateQuestion = (topicId, qid, updater) => {
    const updated = topics.map((t) =>
      t.id !== topicId
        ? t
        : { ...t, questions: t.questions.map((q) => (q.id === qid ? updater(q) : q)) }
    )
    saveAndSetTopics(updated)
  }

  /** ---------- Generate Quiz From PDF ---------- **/
  const handleUploadPdf = async (file) => {
    if (!file) return
    setLoadingQuiz(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch("/api/quiz/upload", { method: "POST", body: formData })
      if (!res.ok) throw new Error("Failed to process PDF")

      const data = await res.json()
      if (!data.questions) throw new Error("No questions returned")

      const newTopic = {
        id: Date.now().toString(),
        title: data.title || "New PDF Topic",
        description: data.description || "",
        timer: 0,
        keywords: [],
        questions: data.questions.map((q, i) => ({
          id: q.id || String(i + 1),
          question: q.question,
          options: q.options,
          correct: q.answer ?? q.correct ?? 0,
          hint: q.hint || "",
          explanation: q.explanation || "",
        })),
      }

      saveAndSetTopics([...topics, newTopic])
      setActiveTopicId(newTopic.id)
      addToast("Topic created from PDF", "success")
      setShowUpload(false)
    } catch (err) {
      console.error(err)
      addToast("Error generating quiz: " + err.message, "warning")
    } finally {
      setLoadingQuiz(false)
    }
  }

  /** ---------- LOGIN SCREEN ---------- **/
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-100 dark:bg-slate-900">
        <form
          onSubmit={handleLogin}
          className="bg-white dark:bg-slate-800 p-6 rounded-xl shadow-md w-80"
        >
          <h2 className="text-xl font-bold mb-4 text-center text-slate-900 dark:text-slate-100">
            Admin Login
          </h2>
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="border p-2 w-full mb-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="border p-2 w-full mb-4 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
          />
          <button className="w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700 transition">
            Login
          </button>
        </form>
      </div>
    )
  }

  /** ---------- ADMIN PANEL ---------- **/
  return (
    <div className="min-h-screen p-6 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      <header className="flex justify-between items-center mb-6 sticky top-0 bg-slate-50 dark:bg-slate-900 z-10 py-2">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          Admin Panel {isSaving && <span className="text-xs text-green-500">✓ Saved</span>}
        </h2>
        <button
          onClick={handleLogout}
          className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white rounded transition"
        >
          Logout
        </button>
      </header>

      <div className="grid grid-cols-3 gap-6">
        {/* Sidebar */}
        <aside className="col-span-1 space-y-3 sticky top-14 self-start">
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search topics..."
              className="flex-1 border p-2 rounded bg-white dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              onClick={handleAddTopic}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 rounded transition"
            >
              +
            </button>
          </div>

          {showUpload && (
            <div className="p-3 border rounded bg-white dark:bg-slate-800">
              <p className="mb-2 font-semibold">Create Topic from PDF</p>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => handleUploadPdf(e.target.files[0])}
                className="mb-2"
              />
              {loadingQuiz && <ProgressBar label="Processing PDF..." />}
              <button
                onClick={createEmptyTopic}
                className="text-sm px-2 py-1 bg-slate-200 dark:bg-slate-700 rounded"
              >
                Or create empty topic
              </button>
            </div>
          )}

          <div className="space-y-2 max-h-[70vh] overflow-y-auto">
            {topics
              .filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
              .map((t) => (
                <div
                  key={t.id}
                  className={`p-2 border rounded cursor-pointer flex justify-between items-center transition ${
                    activeTopicId === t.id
                      ? "bg-indigo-100 dark:bg-indigo-800"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <div
                    className="flex-1 truncate"
                    onClick={() => setActiveTopicId(t.id)}
                  >
                    <div className="font-semibold truncate">{t.title}</div>
                    {t.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {t.description}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDeleteTopic(t.id)}
                    className="ml-2 text-red-600 hover:text-red-800 dark:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
        </aside>

        {/* Editor */}
        <main className="col-span-2 space-y-6">
          {activeTopic ? (
            <>
              {/* Topic Info */}
              <section className="p-4 bg-white dark:bg-slate-800 rounded shadow">
                <h3 className="font-bold mb-3 text-lg">Topic Info</h3>
                <div className="grid grid-cols-1 gap-2">
                  <input
                    className="border p-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                    value={activeTopic.title}
                    onChange={(e) => handleUpdateTopic(activeTopic.id, "title", e.target.value)}
                    placeholder="Title"
                  />
                  <textarea
                    className="border p-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                    rows="2"
                    value={activeTopic.description}
                    onChange={(e) => handleUpdateTopic(activeTopic.id, "description", e.target.value)}
                    placeholder="Description"
                  />
                  <input
                    type="number"
                    className="border p-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                    value={activeTopic.timer}
                    onChange={(e) => handleUpdateTopic(activeTopic.id, "timer", Number(e.target.value))}
                    placeholder="Timer (seconds, 0 = no limit)"
                  />
                  <input
                    className="border p-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                    value={activeTopic.keywords?.join(", ")}
                    onChange={(e) =>
                      handleUpdateTopic(activeTopic.id, "keywords", e.target.value.split(",").map((k) => k.trim()))
                    }
                    placeholder="Keywords (comma separated)"
                  />
                </div>
              </section>

              {/* Questions */}
              <section className="p-4 bg-white dark:bg-slate-800 rounded shadow">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-bold text-lg">Questions ({activeTopic.questions.length})</h3>
                  <button
                    onClick={() => handleAddQuestion(activeTopic.id)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded transition"
                  >
                    + Add Question
                  </button>
                </div>

                {activeTopic.questions.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400 italic">No questions yet</p>
                ) : (
                  activeTopic.questions.map((q, qi) => (
                    <div key={q.id} className="p-3 border rounded mb-3 transition hover:shadow-sm">
                      <p className="font-medium mb-2">Q{qi + 1}</p>
                      <input
                        className="border p-1 w-full mb-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                        value={q.question}
                        onChange={(e) =>
                          handleUpdateQuestion(activeTopic.id, q.id, (oldQ) => ({
                            ...oldQ,
                            question: e.target.value,
                          }))
                        }
                        placeholder="Question text"
                      />
                      {q.options.map((opt, oi) => (
                        <input
                          key={oi}
                          className="border p-1 w-full mb-1 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                          value={opt}
                          onChange={(e) =>
                            handleUpdateQuestion(activeTopic.id, q.id, (oldQ) => ({
                              ...oldQ,
                              options: oldQ.options.map((o, j) => (j === oi ? e.target.value : o)),
                            }))
                          }
                          placeholder={`Option ${oi + 1}`}
                        />
                      ))}
                      <input
                        className="border p-1 w-full mb-1 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                        value={q.hint}
                        onChange={(e) =>
                          handleUpdateQuestion(activeTopic.id, q.id, (oldQ) => ({
                            ...oldQ,
                            hint: e.target.value,
                          }))
                        }
                        placeholder="Hint"
                      />
                      <input
                        className="border p-1 w-full mb-1 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                        value={q.explanation}
                        onChange={(e) =>
                          handleUpdateQuestion(activeTopic.id, q.id, (oldQ) => ({
                            ...oldQ,
                            explanation: e.target.value,
                          }))
                        }
                        placeholder="Explanation"
                      />
                      <label className="text-xs block mt-1">
                        Correct answer #:{" "}
                        <input
                          type="number"
                          min="1"
                          max={q.options.length}
                          value={q.correct + 1}
                          onChange={(e) =>
                            handleUpdateQuestion(activeTopic.id, q.id, (oldQ) => ({
                              ...oldQ,
                              correct: Number(e.target.value) - 1,
                            }))
                          }
                          className="border p-1 w-16 ml-2 rounded bg-white dark:bg-slate-700 dark:text-slate-100"
                        />
                      </label>
                    </div>
                  ))
                )}
              </section>
            </>
          ) : (
            <p className="italic text-slate-500 dark:text-slate-400">Select a topic to edit</p>
          )}
        </main>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3 py-2 rounded text-white ${
              t.type === "success"
                ? "bg-green-500"
                : t.type === "warning"
                ? "bg-yellow-500 text-black"
                : "bg-slate-800"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
