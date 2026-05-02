import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export function HUD() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div data-hud className="pointer-events-none absolute inset-0 z-10">
      <Link
        to="/"
        className="pointer-events-auto absolute top-4 left-4 rounded-full bg-black/40 px-4 py-2 text-sm text-white backdrop-blur-md transition hover:bg-black/60"
      >
        ← Back to map
      </Link>
      <div
        className={`pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2 transform rounded-2xl bg-black/40 px-5 py-3 text-center text-sm text-white backdrop-blur-md transition-opacity duration-700 ${
          visible ? "opacity-100" : "opacity-0 hover:opacity-100"
        }`}
      >
        <div className="font-medium">Welcome to the Island</div>
        <div className="mt-1 text-xs opacity-80">
          <kbd className="rounded bg-white/20 px-1.5 py-0.5">W</kbd>
          <kbd className="ml-1 rounded bg-white/20 px-1.5 py-0.5">A</kbd>
          <kbd className="ml-1 rounded bg-white/20 px-1.5 py-0.5">S</kbd>
          <kbd className="ml-1 rounded bg-white/20 px-1.5 py-0.5">D</kbd>{" "}
          to move ·{" "}
          <kbd className="rounded bg-white/20 px-1.5 py-0.5">Shift</kbd> to run
          · drag to look
        </div>
      </div>
    </div>
  );
}
