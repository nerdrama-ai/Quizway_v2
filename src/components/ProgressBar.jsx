import React from "react";

export default function ProgressBar({ label = "Generating quiz..." }) {
  return (
    <div className="w-full max-w-sm">
      <span className="block text-sm text-indigo-600 mb-1">{label}</span>
      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
        <div className="h-2 bg-indigo-500 animate-progress" />
      </div>
    </div>
  );
}
