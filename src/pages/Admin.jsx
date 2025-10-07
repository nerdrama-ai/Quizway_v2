// FILE: src/pages/Admin.jsx
import React, { useState, useEffect, useMemo, useRef } from "react"
import { getTopics, saveTopics } from "../data/topics"
import ProgressBar from "../components/ProgressBar"
import jsPDF from "jspdf"
import "jspdf-autotable"

export default function Admin({ onHome }) {
  /** ---------- AUTH STATE ---------- **/
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
    } else {
      setError("Invalid username or password")
    }
  }

  const handleLogout = () => {
    setIsAuthenticated(false)
    localStorage.removeItem("isAuthenticated")
  }

  /** ---------- TOPIC STATE (from code1) ---------- **/
  const [topics, setTopics] = useState(() => getTopics() || [])
  const [activeTopicId, setActiveTopicId] = useState(() => getTopics()?.[0]?.id || null)
  const activeTopic = useMemo(() => topics.find((t) => t.id === activeTopicId) || null, [topics, activeTopicId])
  const [search, setSearch] = useState("")
  const [toasts, setToasts] = useState([])
  const [loadingQuiz, setLoadingQuiz] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadedFile, setUploadedFile] = useState(null)

  /** (optional) local editing topic state (keeps UI from code2) **/
  const [editingTopic, setEditingTopic] = useState(null)
  const fileInputRef = useRef(null)

  /** ---------- UTILS ---------- **/
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

  /** ---------- Topic CRUD (from code1) ---------- **/
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
    setShowUpload(false)
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
      t.id === topicId ? { ...t, questions: [...(t.questions || []), newQ] } : t
    )
    saveAndSetTopics(updated)
    addToast("Question added", "success")
  }

  const handleUpdateQuestion = (topicId, qid, updater) => {
    const updated = topics.map((t) =>
      t.id !== topicId
        ? t
        : { ...t, questions: (t.questions || []).map((q) => (q.id === qid ? updater(q) : q)) }
    )
    saveAndSetTopics(updated)
  }

  /** ---------- Generate Quiz From PDF (from code1, real API) ---------- **/
  const handleUploadPdf = async (file) => {
    if (!file) return
    setUploadedFile(file)
    setLoadingQuiz(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch("/api/quiz/upload", { method: "POST", body: formData })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(text || "Failed to process PDF")
      }

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
          // Accept both 'options' or fallback to array if missing
          options: q.options || q.opts || ["", "", "", ""],
          // keep original code1 shape: use 'correct' index if provided, else attempt to map other fields
          correct: typeof q.answer === "number" ? q.answer : q.correct ?? 0,
          hint: q.hint || "",
          explanation: q.explanation || "",
          // also preserve 'answer' field if API supplies string answer
          answer: q.answer && typeof q.answer !== "number" ? q.answer : undefined,
        })),
      }

      saveAndSetTopics([...topics, newTopic])
      setActiveTopicId(newTopic.id)
      addToast("Topic created from PDF", "success")
      setShowUpload(false)
    } catch (err) {
      console.error(err)
      addToast("Error generating quiz: " + (err.message || err), "warning")
    } finally {
      setLoadingQuiz(false)
    }
  }

  /** ---------- File input / drag-drop handlers (UI from code2 but calling real upload) ---------- **/
  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (file) handleUploadPdf(file)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleUploadPdf(file)
  }

  const handleDragOver = (e) => e.preventDefault()

  /** ---------- PDF GENERATION (from code2) ---------- **/
  const handleDownloadPDF = () => {
    if (!activeTopic) {
      addToast("Please select a topic first!", "error")
      return
    }

    const doc = new jsPDF()
    doc.setFont("helvetica", "bold")
    doc.setFontSize(18)
    doc.text(`Quizway - ${activeTopic.title} Quiz`, 14, 20)

    doc.setFont("helvetica", "normal")
    doc.setFontSize(12)
    doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 30)
    doc.text(`Total Questions: ${activeTopic.questions?.length || 0}`, 14, 38)

    let yPos = 50

    activeTopic.questions?.forEach((q, index) => {
      if (yPos > 270) {
        doc.addPage()
        yPos = 20
      }
      doc.setFont("helvetica", "bold")
      doc.text(`${index + 1}. ${q.question}`, 14, yPos)
      yPos += 8

      if (q.options) {
        doc.setFont("helvetica", "normal")
        q.options.forEach((opt, i) => {
          doc.text(`(${String.fromCharCode(65 + i)}) ${opt}`, 20, yPos)
          yPos += 6
        })
      }

      // Print answer intelligently: prefer q.correct index (code1), otherwise q.answer (string)
      const answerText =
        typeof q.correct === "number" && q.options && q.options[q.correct] !== undefined
          ? q.options[q.correct]
          : q.answer || q.correct || ""

      if (answerText) {
        yPos += 2
        doc.setTextColor(0, 102, 204)
        doc.text(`Answer: ${answerText}`, 20, yPos)
        doc.setTextColor(0, 0, 0)
        yPos += 10
      } else {
        yPos += 6
      }
    })

    doc.save(`${activeTopic.title}_Quiz.pdf`)
    addToast(`Downloaded "${activeTopic.title}" as PDF`, "success")
  }

  /** ---------- Editing helpers (blend of both) ---------- **/
  const handleEditTopic = (topic) => {
    // create a deep-ish copy for safe editing in the UI
    setEditingTopic(JSON.parse(JSON.stringify(topic)))
  }

  const handleSaveEditedTopic = () => {
    if (!editingTopic) return
    const updated = topics.map((t) => (t.id === editingTopic.id ? editingTopic : t))
    saveAndSetTopics(updated)
    setEditingTopic(null)
    addToast("Topic updated successfully!", "success")
  }

  const handleQuestionChange = (index, field, value) => {
    if (!editingTopic) return
    const updatedQuestions = [...(editingTopic.questions || [])]
    updatedQuestions[index] = { ...(updatedQuestions[index] || {}), [field]: value }
    setEditingTopic({ ...editingTopic, questions: updatedQuestions })
  }

  const handleAddQuestionEditing = () => {
    if (!editingTopic) return
    const newQuestion = { id: Date.now().toString(), question: "New question", options: ["", "", "", ""], correct: 0 }
    setEditingTopic({
      ...editingTopic,
      questions: [...(editingTopic.questions || []), newQuestion],
    })
  }

  const handleDeleteQuestionEditing = (index) => {
    if (!editingTopic) return
    const updatedQuestions = editingTopic.questions.filter((_, i) => i !== index)
    setEditingTopic({ ...editingTopic, questions: updatedQuestions })
  }

  /** ---------- UI ---------- **/
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
        <div className="bg-gray-800 p-8 rounded-2xl shadow-xl w-96">
          <h2 className="text-2xl font-bold mb-6 text-center">Admin Login</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              className="w-full p-2 rounded-lg bg-gray-700 text-white"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              className="w-full p-2 rounded-lg bg-gray-700 text-white"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded-lg">
              Log In
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gray-100 text-gray-900">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-gray-100 flex flex-col justify-between">
        <div>
          <div className="p-4 border-b border-gray-700">
            <h2 className="text-xl font-semibold text-indigo-400">Quizway Admin</h2>
          </div>
          <nav className="p-4 space-y-2">
            <button
              onClick={() => {
                setShowUpload(false)
                setEditingTopic(null)
              }}
              className={`block w-full text-left px-3 py-2 rounded-lg ${
                !showUpload ? "bg-indigo-600 text-white" : "hover:bg-gray-800"
              }`}
            >
              Topics
            </button>
            <button
              onClick={() => {
                setShowUpload(true)
                setEditingTopic(null)
              }}
              className={`block w-full text-left px-3 py-2 rounded-lg ${
                showUpload ? "bg-indigo-600 text-white" : "hover:bg-gray-800"
              }`}
            >
              Upload Quiz
            </button>
            <button
              onClick={() => {
                // quickly create an empty topic from the sidebar
                createEmptyTopic()
              }}
              className="block w-full text-left px-3 py-2 rounded-lg hover:bg-gray-800 mt-2"
            >
              + New Topic
            </button>
          </nav>

          {/* Topics list (compact) */}
          <div className="p-4 overflow-y-auto h-[calc(100vh-300px)]">
            <input
              type="text"
              placeholder="Search topics..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full p-2 rounded-lg border border-gray-700 bg-gray-800 text-white mb-3"
            />
            <div className="space-y-2">
              {topics
                .filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
                .map((t) => (
                  <div
                    key={t.id}
                    className={`p-2 rounded-md flex items-start justify-between cursor-pointer ${
                      t.id === activeTopicId ? "bg-indigo-800 text-white" : "hover:bg-gray-800"
                    }`}
                  >
                    <div className="flex-1" onClick={() => { setActiveTopicId(t.id); setEditingTopic(null) }}>
                      <div className="font-semibold truncate">{t.title}</div>
                      {t.description && <div className="text-xs text-gray-400 truncate">{t.description}</div>}
                    </div>
                    <div className="flex flex-col items-end ml-2">
                      <button
                        onClick={() => { handleDeleteTopic(t.id) }}
                        className="text-sm text-red-400 hover:text-red-600"
                        title="Delete topic"
                      >
                        ✕
                      </button>
                      <button
                        onClick={() => handleEditTopic(t)}
                        className="text-xs mt-2 bg-indigo-600 px-2 rounded text-white"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="w-full bg-red-600 hover:bg-red-700 px-3 py-2 rounded-lg text-left"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">
            {editingTopic
              ? `Editing: ${editingTopic.title}`
              : showUpload
              ? "Upload Quiz Data"
              : "Manage Topics"}
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={onHome}
              className="bg-gray-800 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
            >
              Home
            </button>
            {!showUpload && !editingTopic && (
              <button
                onClick={() => {
                  if (!activeTopic) {
                    addToast("Select a topic to download PDF", "error")
                    return
                  }
                  handleDownloadPDF()
                }}
                className="bg-gray-700 hover:bg-gray-800 text-white px-3 py-2 rounded-lg"
              >
                Download PDF
              </button>
            )}
          </div>
        </div>

        {/* Conditional Views */}
        {editingTopic ? (
          <div className="bg-white p-6 rounded-xl shadow-md">
            <div className="mb-4">
              <input
                className="w-full border p-2 rounded-md mb-4"
                value={editingTopic.title}
                onChange={(e) =>
                  setEditingTopic({ ...editingTopic, title: e.target.value })
                }
              />
              <div className="mb-4">
                <textarea
                  className="w-full border p-2 rounded-md"
                  value={editingTopic.description || ""}
                  onChange={(e) => setEditingTopic({ ...editingTopic, description: e.target.value })}
                  placeholder="Description"
                />
              </div>
              <button
                onClick={handleAddQuestionEditing}
                className="bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-1 rounded-md mb-4"
              >
                + Add Question
              </button>
            </div>
            {editingTopic.questions?.map((q, i) => (
              <div key={q.id || i} className="mb-6 border-b pb-4">
                <input
                  className="w-full border p-2 rounded-md mb-2"
                  value={q.question}
                  onChange={(e) =>
                    handleQuestionChange(i, "question", e.target.value)
                  }
                />
                {(q.options || []).map((opt, idx) => (
                  <input
                    key={idx}
                    className="w-full border p-2 rounded-md mb-1 text-sm"
                    value={opt}
                    onChange={(e) => {
                      const updatedOptions = [...(q.options || [])]
                      updatedOptions[idx] = e.target.value
                      handleQuestionChange(i, "options", updatedOptions)
                    }}
                  />
                ))}
                <input
                  className="w-full border p-2 rounded-md mb-2 text-sm"
                  placeholder="Correct answer index (0-based) or text"
                  value={q.correct ?? q.answer ?? ""}
                  onChange={(e) =>
                    // try to keep both shapes: if numeric, set correct; else set answer
                    handleQuestionChange(i, isNaN(e.target.value) ? "answer" : "correct", isNaN(e.target.value) ? e.target.value : Number(e.target.value))
                  }
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => handleDeleteQuestionEditing(i)}
                    className="bg-red-600 hover:bg-red-700 text-white text-xs px-3 py-1 rounded-md"
                  >
                    Delete Question
                  </button>
                </div>
              </div>
            ))}
            <div className="flex justify-between mt-4">
              <button
                onClick={() => setEditingTopic(null)}
                className="bg-gray-400 hover:bg-gray-500 text-white px-4 py-2 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditedTopic}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md"
              >
                Save Changes
              </button>
            </div>
          </div>
        ) : !showUpload ? (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Search topics..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-96 p-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-400"
                />
                {isSaving && <span className="text-sm text-gray-500">Saving...</span>}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {topics
                .filter((t) =>
                  t.title.toLowerCase().includes(search.toLowerCase())
                )
                .map((topic) => (
                  <div
                    key={topic.id}
                    className={`cursor-pointer p-4 rounded-xl shadow-md ${
                      topic.id === activeTopicId
                        ? "bg-indigo-100 border border-indigo-400"
                        : "bg-white hover:shadow-lg"
                    }`}
                  >
                    <h3 className="font-semibold text-lg">{topic.title}</h3>
                    <p className="text-sm text-gray-600 mt-1">
                      {topic.questions?.length || 0} questions
                    </p>
                    <p className="text-xs text-gray-500 mt-1 truncate">{topic.description}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => handleEditTopic(topic)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-3 py-1 rounded-md"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setActiveTopicId(topic.id)
                          handleDownloadPDF()
                        }}
                        className="bg-gray-700 hover:bg-gray-800 text-white text-sm px-3 py-1 rounded-md"
                      >
                        PDF
                      </button>
                      <button
                        onClick={() => { setActiveTopicId(topic.id) }}
                        className="bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm px-3 py-1 rounded-md"
                      >
                        Select
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className="p-6 bg-white rounded-xl shadow-md">
            <h2 className="text-lg font-semibold mb-4">Upload Quiz File</h2>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="border-2 border-dashed border-gray-400 rounded-xl p-10 text-center cursor-pointer hover:border-indigo-400 transition"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              {uploadedFile ? (
                <div>
                  <p className="font-medium text-gray-700 mb-3">
                    File selected: <span className="text-indigo-600">{uploadedFile.name}</span>
                  </p>
                  <div className="flex flex-col items-center justify-center">
                    {loadingQuiz ? (
                      <>
                        <div className="w-1/2">
                          <ProgressBar label="Processing PDF..." />
                        </div>
                        <p className="text-sm text-gray-500 mt-2">Processing...</p>
                      </>
                    ) : (
                      <p className="text-green-600 font-medium mt-2">Ready to upload — click here to reselect or drop a new file</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-gray-600">
                  Drag and drop your quiz PDF here, or{" "}
                  <span className="text-indigo-600 underline">click to browse</span>
                </p>
              )}
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="application/pdf"
                className="hidden"
              />
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  // if a file is selected but not processed, call upload
                  if (uploadedFile && !loadingQuiz) {
                    handleUploadPdf(uploadedFile)
                  } else if (!uploadedFile) {
                    fileInputRef.current && fileInputRef.current.click()
                  }
                }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-md"
              >
                Upload & Generate Quiz
              </button>

              <button
                onClick={createEmptyTopic}
                className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-2 rounded-md"
              >
                Or create empty topic
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-lg shadow-lg text-white ${
              t.type === "error"
                ? "bg-red-600"
                : t.type === "success"
                ? "bg-green-600"
                : "bg-gray-800"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
