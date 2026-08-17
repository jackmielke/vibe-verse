/**
 * Vibey reads the paper.
 *
 * The strip on the front door has said "brought to you by Vibey" for months
 * and Vibey never said a word. This is the button that makes it true.
 *
 * Two ways to hear it, in order of preference:
 *
 *   1. The recording. `vibe-times-read` synthesises each edition once and
 *      stores the mp3, so the first listener of the day waits a couple of
 *      seconds and everyone after them gets a cached file.
 *   2. The browser's own voice. If there is no recording — no API key, a
 *      bad day at ElevenLabs, an edition nobody has played yet and the
 *      function is down — `speechSynthesis` reads the same bulletin in
 *      whatever voice the device has. It is worse, and it is free, and it
 *      means the button is never a dead button.
 */
import { useEffect, useRef, useState } from "react";
import type { Issue } from "@/lib/vibeTimes";

const READ_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-times-read`;

/**
 * The same bulletin the function builds, for the browser to read when there
 * is no recording. Deliberately a little shorter: a synthetic voice reading
 * six paragraphs is a test of patience.
 */
function localScript(issue: Issue): string {
  const plain = (s?: string) =>
    (s ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const [lead, ...rest] = issue.headlines ?? [];
  const wire = (issue.dispatches ?? [])[0];
  return [
    `The Vibe Times. ${plain(issue.motto)}.`,
    lead && `${plain(lead.headline)}. ${plain(lead.body)}`,
    rest[0] && `${plain(rest[0].headline)}. ${plain(rest[0].body)}`,
    wire && `From outside the sky. ${plain(wire.headline)}. ${plain(wire.body)}`,
    plain(issue.vibey_says),
  ]
    .filter(Boolean)
    .join("\n\n");
}

type State = "idle" | "loading" | "playing";

export function ReadAloud({ issue }: { issue: Issue }) {
  const [state, setState] = useState<State>("idle");
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Leaving the page mid-bulletin should stop the bulletin. Both engines
  // keep playing otherwise — the browser's speech queue in particular
  // survives navigation and will read yesterday's lead over a game.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      window.speechSynthesis?.cancel();
    };
  }, []);

  // A new edition mid-listen would leave the old audio playing under a
  // different front page.
  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    window.speechSynthesis?.cancel();
    setState("idle");
  }, [issue.issue]);

  function stop() {
    audioRef.current?.pause();
    audioRef.current = null;
    window.speechSynthesis?.cancel();
    setState("idle");
  }

  function speakLocally() {
    const synth = window.speechSynthesis;
    // Both halves, checked separately. They arrive together in every real
    // browser and apart in enough other places — jsdom, locked-down
    // webviews — that assuming one from the other threw an unhandled
    // rejection out of a click handler, which is precisely the dead button
    // this fallback exists to prevent.
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") {
      setNote("this browser has no voice");
      setState("idle");
      return;
    }
    try {
      synth.cancel();
      const utterance = new Utterance(localScript(issue));
      utterance.rate = 1.02;
      utterance.pitch = 1.05;
      utterance.onend = () => setState("idle");
      utterance.onerror = () => setState("idle");
      setState("playing");
      synth.speak(utterance);
    } catch {
      setNote("this browser has no voice");
      setState("idle");
    }
  }

  async function play() {
    if (state !== "idle") {
      stop();
      return;
    }
    setState("loading");
    setNote(null);
    try {
      const res = await fetch(READ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue: issue.issue }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !data.url) throw new Error("no recording");
      const audio = new Audio(data.url);
      audio.onended = () => setState("idle");
      audio.onerror = () => speakLocally();
      audioRef.current = audio;
      await audio.play();
      setState("playing");
    } catch {
      speakLocally();
    }
  }

  return (
    <div className="mt-3 text-center">
      <button
        onClick={play}
        data-testid="read-aloud"
        aria-label={state === "playing" ? "stop reading" : "listen to this issue"}
        className="border border-[#2a2118] px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] transition-colors hover:bg-[#2a2118] hover:text-[#efe8d8] disabled:opacity-40"
        disabled={state === "loading"}
      >
        {state === "loading" && "clearing his throat…"}
        {state === "playing" && "■ stop"}
        {state === "idle" && "▶ Vibey reads it"}
      </button>
      {note && <p className="mt-1 text-[10px] uppercase tracking-widest opacity-50">{note}</p>}
    </div>
  );
}
