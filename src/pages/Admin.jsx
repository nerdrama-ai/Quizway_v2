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

  /** ---------- TOPIC STATE ---------- **/
  const [topics, setTopics] = useState(() => getTopics() || [])
  const [activeTopicId, setActiveTopicId] = useState(null)
  const [editingTopic, setEditingTopic] = useState(null)
  const [search, setSearch] = useState("")
  const [toasts, setToasts] = useState([])
  const [loadingQuiz, setLoadingQuiz] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadedFile, setUploadedFile] = useState(null)
  const uploadIntervalRef = useRef(null)

  const activeTopic = useMemo(
    () => topics.find((t) => t.id === activeTopicId) || null,
    [topics, activeTopicId]
  )

  /** ---------- UTILS ---------- **/
  const addToast = (message, type = "info") => {
    const id = Date.now().toString()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000)
  }

  const saveAndSetTopics = (updated) => {
    setTopics(updated)
    saveTopics(updated)
    setIsSaving(true)
    setTimeout(() => setIsSaving(false), 1000)
  }

  /** ---------- FILE UPLOAD ---------- **/
  const fileInputRef = useRef(null)

  const handleFileSelect = (file) => {
    if (!file) return
    setUploadedFile(file)
    setLoadingQuiz(true)
    setUploadProgress(0)

    uploadIntervalRef.current = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) {
          clearInterval(uploadIntervalRef.current)
          setLoadingQuiz(false)
          addToast(`File "${file.name}" uploaded successfully!`, "success")
          return 100
        }
        return prev + 10
      })
    }, 150)
  }

  const handleCancelUpload = () => {
    if (uploadIntervalRef.current) clearInterval(uploadIntervalRef.current)
    setUploadedFile(null)
    setLoadingQuiz(false)
    setUploadProgress(0)
    addToast("Upload cancelled", "error")
  }

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    handleFileSelect(file)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    handleFileSelect(file)
  }

  const handleDragOver = (e) => e.preventDefault()

  /** ---------- PDF GENERATION ---------- **/
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

      if (q.answer) {
        yPos += 2
        doc.setTextColor(0, 102, 204)
        doc.text(`Answer: ${q.answer}`, 20, yPos)
        doc.setTextColor(0, 0, 0)
        yPos += 10
      } else {
        yPos += 6
      }
    })

    doc.save(`${activeTopic.title}_Quiz.pdf`)
    addToast(`Downloaded "${activeTopic.title}" as PDF`, "success")
  }

  /** ---------- EDITING ---------- **/
  const handleEditTopic = (topic) => {
    setEditingTopic({ ...topic })
  }

  const handleSaveEditedTopic = () => {
    const updated = topics.map((t) => (t.id === editingTopic.id ? editingTopic : t))
    saveAndSetTopics(updated)
    setEditingTopic(null)
    addToast("Topic updated successfully!", "success")
  }

  const handleQuestionChange = (index, field, value) => {
    const updatedQuestions = [...editingTopic.questions]
    updatedQuestions[index][field] = value
    setEditingTopic({ ...editingTopic, questions: updatedQuestions })
  }

  const handleAddQuestion = () => {
    const newQuestion = { question: "New question", options: ["", "", "", ""], answer: "" }
    setEditingTopic({
      ...editingTopic,
      questions: [...(editingTopic.questions || []), newQuestion],
    })
  }

  const handleDeleteQuestion = (index) => {
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

  /** ---------- MAIN DASHBOARD ---------- **/
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
          </nav>
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
          <button
            onClick={onHome}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
          >
            Home
          </button>
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
              <button
                onClick={handleAddQuestion}
                className="bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-1 rounded-md mb-4"
              >
                + Add Question
              </button>
            </div>
            {editingTopic.questions?.map((q, i) => (
              <div key={i} className="mb-6 border-b pb-4">
                <input
                  className="w-full border p-2 rounded-md mb-2"
                  value={q.question}
                  onChange={(e) =>
                    handleQuestionChange(i, "question", e.target.value)
                  }
                />
                {q.options?.map((opt, idx) => (
                  <input
                    key={idx}
                    className="w-full border p-2 rounded-md mb-1 text-sm"
                    value={opt}
                    onChange={(e) => {
                      const updatedOptions = [...q.options]
                      updatedOptions[idx] = e.target.value
                      handleQuestionChange(i, "options", updatedOptions)
                    }}
                  />
                ))}
                <input
                  className="w-full border p-2 rounded-md mb-2 text-sm"
                  placeholder="Correct answer"
                  value={q.answer || ""}
                  onChange={(e) =>
                    handleQuestionChange(i, "answer", e.target.value)
                  }
                />
                <button
                  onClick={() => handleDeleteQuestion(i)}
                  className="bg-red-600 hover:bg-red-700 text-white text-xs px-3 py-1 rounded-md"
                >
                  Delete Question
                </button>
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
              <input
                type="text"
                placeholder="Search topics..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-1/2 p-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-400"
              />
              {isSaving && <span className="text-sm text-gray-500">Saving...</span>}
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
              onClick={() => fileInputRef.current.click()}
            >
              {uploadedFile ? (
                <div>
                  <p className="font-medium text-gray-700 mb-3">
                    File selected:{" "}
                    <span className="text-indigo-600">{uploadedFile.name}</span>
                  </p>
                  <div className="flex flex-col items-center justify-center">
                    <div className="w-1/2">
                      <ProgressBar loading={loadingQuiz} />
                    </div>
                    {loadingQuiz ? (
                      <>
                        <p className="text-sm text-gray-500 mt-2">
                          Uploading... {uploadProgress}%
                        </p>
                        <button
                          onClick={handleCancelUpload}
                          className="mt-3 bg-red-600 hover:bg-red-700 text-white text-sm px-3 py-1 rounded-md"
                        >
                          Cancel Upload
                        </button>
                      </>
                    ) : (
                      <p className="text-green-600 font-medium mt-2">
                        Upload complete 🎉
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-gray-600">
                  Drag and drop your quiz file here, or{" "}
                  <span className="text-indigo-600 underline">click to browse</span>
                </p>
              )}
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
              />
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
