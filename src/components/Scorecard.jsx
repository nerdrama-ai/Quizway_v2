// FILE: src/components/Scorecard.jsx
import React from "react";

export default function Scorecard({ title, progress, total, onContinue }) {
  const pct = total ? Math.round((progress / total) * 100) : 0;

  // Dynamic feedback
  const feedback =
    pct === 100
      ? "🚀 Mastered!"
      : pct >= 75
      ? "🔥 Almost there!"
      : pct >= 40
      ? "⚡ Keep going!"
      : "🌱 Just getting started";

  return (
    <div className="bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl shadow-xl p-6 w-full max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
            {title}
          </h2>
          <p className="text-sm text-slate-300">
            Progress: {progress} / {total}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xl font-extrabold text-cyan-300 drop-shadow-md">
            {pct}%
          </div>
          <div className="text-xs text-slate-400">{feedback}</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-4 bg-slate-800/40 rounded-full overflow-hidden shadow-inner">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-400 transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Continue button (optional) */}
      {onContinue && (
        <div className="mt-5 text-center">
          <button
            onClick={onContinue}
            className="px-6 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 text-white font-semibold shadow-lg hover:shadow-cyan-400/50 hover:scale-105 transition"
          >
            Continue →
          </button>
        </div>
      )}
    </div>
  );
}
