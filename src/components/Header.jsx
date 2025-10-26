// FILE: src/components/Header.jsx
import React from "react"

export default function Header({ title, onHome, onAdmin, currentPage }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 bg-white/5 backdrop-blur-md border-b border-white/10">
      {/* App Title / Logo */}
      <h1
        onClick={onHome}
        className="text-xl font-bold bg-gradient-to-r from-indigo-400 via-cyan-300 to-purple-400 bg-clip-text text-transparent tracking-wide drop-shadow-md cursor-pointer hover:opacity-80 transition"
      >
        {title}
      </h1>

      {/* Nav Buttons */}
      <div className="flex gap-3">
        {currentPage !== "home" && (
          <button
            onClick={onHome}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium shadow-md transition 
                       hover:bg-indigo-700 hover:shadow-lg 
                       focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:focus:ring-indigo-600"
          >
            Home
          </button>
        )}
        {currentPage !== "admin" && (
          <button
            onClick={onAdmin}
            className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-sm font-medium shadow-md transition 
                       hover:bg-cyan-700 hover:shadow-lg 
                       focus:outline-none focus:ring-2 focus:ring-cyan-400 dark:focus:ring-cyan-600"
          >
            Admin
          </button>
        )}
      </div>
    </header>
  )
}
