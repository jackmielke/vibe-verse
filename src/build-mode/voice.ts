/**
 * Talking to build mode, step one: the browser's own speech in and out.
 *
 * No key and no model. `SpeechRecognition` turns what you say into the
 * prompt and `speechSynthesis` reads it back, so "I want bazookas" becomes
 * exactly the text a typed prompt would have been, through the same fence and
 * the same checks. A real conversational builder (the Magician's voice with a
 * `build_it` tool) is the next step and can replace this hook without the
 * panel knowing.
 *
 * Chrome and Safari have recognition; Firefox does not, and the mic button
 * simply does not appear there.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Alt = { transcript: string };
type ResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<ArrayLike<Alt> & { isFinal: boolean }>;
};
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: ResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: Event & { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const dictationSupported = () => recognitionCtor() !== null;

/** Say something out loud, if the browser can. Never throws. */
export function say(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.15;
    synth.speak(u);
  } catch {
    /* silence is fine */
  }
}

/**
 * Push to talk. `start()` listens until you stop talking (or press again),
 * streaming the words into `interim`, and calls `onFinal` once with the
 * whole utterance.
 */
export function useDictation(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalText = useRef("");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("This browser cannot listen. Chrome or Safari can.");
      return;
    }
    rec.current?.abort();
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* nothing was speaking */
    }
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    finalText.current = "";
    setInterim("");
    setError(null);
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += res[0].transcript;
        else live += res[0].transcript;
      }
      setInterim((finalText.current + live).trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") setError("The microphone is blocked for this site.");
      else if (e.error && e.error !== "no-speech" && e.error !== "aborted") setError(`Mic: ${e.error}`);
    };
    r.onend = () => {
      setListening(false);
      rec.current = null;
      const text = finalText.current.trim();
      if (text) onFinalRef.current(text);
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  useEffect(() => () => rec.current?.abort(), []);

  return { listening, interim, error, start, stop };
}
