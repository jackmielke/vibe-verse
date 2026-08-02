/**
 * Talk to Vibey from the security desk.
 *
 * Same brain as everywhere else in the vibeverse: the `unit7-chat` edge
 * function, which Vibe City, Jerry the snail and the /start onboarding all sit
 * on. Nothing here is a new AI integration — it is the existing one, given a
 * persona line about where he currently is.
 *
 * Two rules make this safe to have open during a night:
 *
 * 1. **The night does not pause.** Talking to him costs you attention, and the
 *    building does not care that you are busy. That is the trade.
 * 2. **Typing must never work the doors.** The engine binds A/D/Q/E/Space on
 *    `window`, so a message containing the letter "d" would otherwise slam the
 *    east door. `FnafEngine.onKey` ignores events whose target is a field, and
 *    this panel is the only reason that guard exists.
 */
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const PERSONA =
  "(For this reply you are VIBEY — the vibeverse's little white robot mascot, " +
  "two antennas, big goggle eyes, a lightning-bolt smiley on your belly. You " +
  "have wandered into Vibey Fazbear's Pizza after hours and you are delighted " +
  "about it. The night guard is talking to you over the desk intercom while " +
  "four animatronics roam the building. You are warm, funny, a bit chaotic, " +
  "and never sinister. Keep it to one or two short sentences.) ";

interface Msg {
  who: "you" | "vibey";
  text: string;
}

const OPENERS = [
  "hi!! it's so dark in here. i love it",
  "oh hey!! you're the one in the little room!",
  "i found the kitchen. there are SO many pans",
];

export default function VibeyChat({ onTypingChange }: { onTypingChange?: (typing: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && log.length === 0) {
      setLog([{ who: "vibey", text: OPENERS[Math.floor(Math.random() * OPENERS.length)] }]);
    }
  }, [open, log.length]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [log]);

  // Let the engine know a field has the keyboard, so it stops reading keys.
  useEffect(() => {
    onTypingChange?.(open);
    return () => onTypingChange?.(false);
  }, [open, onTypingChange]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    setLog((l) => [...l, { who: "you", text: t }]);
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("unit7-chat", {
        body: { history: history.current.slice(-12), text: PERSONA + t },
      });
      if (error) throw error;
      const say =
        data && typeof data === "object" && "say" in data
          ? String((data as Record<string, unknown>).say)
          : null;
      if (!say) throw new Error("no reply");
      history.current.push({ role: "user", content: t }, { role: "assistant", content: say });
      setLog((l) => [...l, { who: "vibey", text: say }]);
    } catch {
      // Offline, or the function is down. He is a robot in a haunted pizzeria;
      // losing the intercom is in character, and it must not break the night.
      setLog((l) => [...l, { who: "vibey", text: "…bzzt… (the intercom cuts out)" }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="pointer-events-auto absolute bottom-6 left-6 z-20 flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-3 py-2 font-mono text-[10px] tracking-[0.22em] text-white/50 transition hover:border-white/35 hover:text-white/90"
      >
        <span className="text-sm leading-none">🤖</span> TALK TO VIBEY
      </button>
    );
  }

  return (
    <div className="pointer-events-auto absolute bottom-6 left-6 z-20 flex w-[min(78vw,320px)] flex-col overflow-hidden rounded-xl border border-white/15 bg-black/85 font-mono backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-[10px] tracking-[0.28em] text-sky-300/80">🤖 VIBEY — INTERCOM</span>
        <button
          onClick={() => setOpen(false)}
          className="text-[11px] text-white/40 transition hover:text-white/90"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div ref={scroller} className="max-h-52 space-y-2 overflow-y-auto px-3 py-2.5">
        {log.map((m, i) => (
          <div
            key={i}
            className={`text-[11px] leading-relaxed ${
              m.who === "you" ? "text-right text-white/55" : "text-sky-200/90"
            }`}
          >
            {m.text}
          </div>
        ))}
        {busy && <div className="text-[11px] text-sky-200/40">…</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 px-2 py-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Every key here is the field's, not the office's.
            e.stopPropagation();
            if (e.key === "Enter") void send();
          }}
          placeholder="say something…"
          className="min-w-0 flex-1 bg-transparent px-1 text-[11px] text-white/85 outline-none placeholder:text-white/25"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          className="rounded-md border border-sky-400/30 bg-sky-400/15 px-2.5 py-1 text-[10px] tracking-widest text-sky-200 transition disabled:opacity-30 hover:bg-sky-400/30"
        >
          SEND
        </button>
      </div>
    </div>
  );
}
