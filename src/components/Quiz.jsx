// FILE: src/components/Quiz.jsx
import React, { useState, useEffect } from "react";

export default function Quiz({ topic, onBack, onComplete }) {
  const total = topic.questions.length;
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [locked, setLocked] = useState(false);
  const [finished, setFinished] = useState(false);
  const [score, setScore] = useState(0);
  const [showHint, setShowHint] = useState(false);

  // === TIMER STATE ===
  const [timeLeft, setTimeLeft] = useState(topic.timer || null); // seconds

  useEffect(() => {
    setIdx(0);
    setSelected(null);
    setLocked(false);
    setFinished(false);
    setScore(0);
    setShowHint(false);
    setTimeLeft(topic.timer || null);
  }, [topic.id]);

  // Countdown effect
  useEffect(() => {
    if (!timeLeft || finished) return;
    if (timeLeft <= 0) {
      setFinished(true);
      if (onComplete) onComplete(score);
      return;
    }
    const t = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    return () => clearTimeout(t);
  }, [timeLeft, finished, score, onComplete]);

  function handleSelect(i) {
    if (locked) return;
    setSelected(i);
    setLocked(true);
    if (i === topic.questions[idx].correct) {
      setScore((s) => s + 1);
    }
  }

  function handleNext() {
    setSelected(null);
    setLocked(false);
    setShowHint(false);
    if (idx + 1 < total) {
      setIdx(idx + 1);
    } else {
      setFinished(true);
      if (onComplete) onComplete(score);
    }
  }

  // === COMPLETED SCREEN ===
  if (finished) {
    return (
      <div className="p-10 text-center bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl max-w-2xl mx-auto">
        <h2 className="text-4xl font-extrabold mb-6 bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
          {topic.title} ✅ Completed!
        </h2>
        <p className="mb-8 text-2xl text-slate-200">
          Your Score:{" "}
          <span className="text-emerald-400 font-bold">{score}</span> / {total}
        </p>
        <button
          className="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 text-white font-semibold shadow-lg hover:shadow-cyan-400/50 hover:scale-105 transition"
          onClick={onBack}
        >
          ← Back to Topics
        </button>
      </div>
    );
  }

  // === MAIN QUIZ SCREEN ===
  const curQ = topic.questions[idx];

  // Format timer (mm:ss)
  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec < 10 ? "0" : ""}${sec}`;
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <button
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-slate-700 to-slate-600 text-white hover:opacity-80 shadow"
          onClick={onBack}
        >
          ← Topics
        </button>
        <h2 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
          {topic.title}
        </h2>
        <div className="flex gap-4 items-center">
          {timeLeft !== null && (
            <div className="px-4 py-2 rounded-lg bg-red-500/30 text-sm text-red-200 shadow">
              ⏳ {formatTime(timeLeft)}
            </div>
          )}
          <div className="px-4 py-2 rounded-lg bg-white/10 text-sm text-slate-200 shadow">
            Score:{" "}
            <span className="text-emerald-400 font-bold">{score}</span> / {total}
          </div>
        </div>
      </div>

      {/* Question Card */}
      <div className="bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl shadow-xl p-8 max-w-3xl mx-auto">
        <div className="mb-3 text-sm text-slate-400">
          Question {idx + 1} of {total}
        </div>
        <div className="text-2xl font-semibold mb-8 text-slate-100">
          {curQ.question}
        </div>

        {/* Options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {curQ.options.map((opt, i) => {
            let base =
              "px-5 py-4 rounded-xl border text-left font-medium cursor-pointer select-none transition transform hover:scale-[1.02] ";
            let classes = base;
            if (locked) {
              if (i === curQ.correct) {
                classes +=
                  "border-emerald-400 bg-emerald-500/20 text-emerald-200 shadow-lg shadow-emerald-500/20";
              } else if (selected === i) {
                classes +=
                  "border-red-400 bg-red-500/20 text-red-200 shadow-lg shadow-red-500/20";
              } else {
                classes += "border-slate-500/40 text-slate-400";
              }
            } else {
              classes +=
                "border-slate-500/40 text-slate-200 hover:border-cyan-400 hover:bg-white/10";
            }
            return (
              <button
                key={i}
                className={classes}
                onClick={() => handleSelect(i)}
                disabled={locked}
              >
                {opt}
              </button>
            );
          })}
        </div>

        {/* Hint Section */}
        {!locked && curQ.hint && (
          <div className="mt-6 text-center">
            {!showHint ? (
              <button
                className="px-5 py-2 rounded-lg bg-indigo-600/70 text-white text-sm hover:bg-indigo-500 transition"
                onClick={() => setShowHint(true)}
              >
                💡 Show Hint
              </button>
            ) : (
              <div className="p-4 rounded-lg bg-indigo-900/50 border border-indigo-400 text-indigo-200 shadow-md">
                {curQ.hint}
              </div>
            )}
          </div>
        )}

        {/* Explanation Section */}
        {locked && curQ.explanation && (
          <div className="mt-6 p-4 rounded-lg bg-emerald-900/40 border border-emerald-400 text-emerald-200 shadow-md">
            ✅ Explanation: {curQ.explanation}
          </div>
        )}
      </div>

      {/* Next Button */}
      {locked && (
        <div className="text-center mt-8">
          <button
            className="px-8 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 text-white font-semibold shadow-lg hover:shadow-indigo-400/50 hover:scale-105 transition"
            onClick={handleNext}
          >
            {idx + 1 < total ? "Next Question →" : "Finish Quiz ✅"}
          </button>
        </div>
      )}
    </div>
  );
}
