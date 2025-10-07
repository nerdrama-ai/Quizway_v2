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
  const [activeTopicId, setActiveTopicId] = useState(() => getTopics()?.[0]?.id || null)
  const activeTopic = useMemo(
    () => topics.find((t) => t.id === activeTopicId) || null,
    [topics, activeTopicId]
  )
  const [search, setSearch] = useState("")
  const [toasts, setToasts] = useState([])
  const [loadingQuiz, setLoadingQuiz] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadedFile, setUploadedFile] = useState(null)

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
    setTimeout(() => setIsSaving(false), 1000)
  }

  /** ---------- FILE UPLOAD ---------- **/
  const fileInputRef = useRef(null)

  const handleFileSelect = (file) => {
    if (!file) return
    setUploadedFile(file)
    setLoadingQuiz(true)
    setUploadProgress(0)

    const simulateUpload = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) {
          clearInterval(simulateUpload)
          setLoadingQuiz(false)
          addToast(`File "${file.name}" uploaded successfully!`, "success")
          return 100
        }
        return prev + 10
      })
    }, 150)
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

  /** ---------- UI SECTIONS ---------- **/
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
        <div className="bg-gray-800 p-8 rounded-2xl shadow-xl w-96">
          <h2 className="text-2xl font-bold mb-6 text-center">Admin Login</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              className="w-full p-2 rounded-lg bg-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              className="w-full p-2 rounded-lg bg-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 rounded-lg"
            >
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
      <aside className="w-64 bg-gray-900 text-gray-100 flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-indigo-400">Quizway Admin</h2>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <button
            onClick={() => setShowUpload(false)}
            className={`block w-full text-left px-3 py-2 rounded-lg ${
              !showUpload ? "bg-indigo-600 text-white" : "hover:bg-gray-800"
            }`}
          >
            Topics
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className={`block w-full text-left px-3 py-2 rounded-lg ${
              showUpload ? "bg-indigo-600 text-white" : "hover:bg-gray-800"
            }`}
          >
            Upload Quiz
          </button>
          <button
            onClick={handleLogout}
            className="block w-full text-left px-3 py-2 mt-4 bg-red-600 hover:bg-red-700 rounded-lg"
          >
            Logout
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">
            {showUpload ? "Upload Quiz Data" : "Manage Topics"}
          </h1>
          <button
            onClick={onHome}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
          >
            Home
          </button>
        </div>

        {/* Conditional Views */}
        {!showUpload ? (
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
                .filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
                .map((topic) => (
                  <div
                    key={topic.id}
                    onClick={() => setActiveTopicId(topic.id)}
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
                    {topic.id === activeTopicId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDownloadPDF()
                        }}
                        className="mt-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-3 py-1 rounded-md"
                      >
                        Download PDF
                      </button>
                    )}
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
                  <p className="font-medium text-gray-700">
                    File selected: <span className="text-indigo-600">{uploadedFile.name}</span>
                  </p>
                  <ProgressBar loading={loadingQuiz} />
                  {loadingQuiz ? (
                    <p className="text-sm text-gray-500 mt-2">
                      Uploading... {uploadProgress}%
                    </p>
                  ) : (
                    <p className="text-green-600 font-medium mt-2">
                      Upload complete 🎉
                    </p>
                  )}
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

