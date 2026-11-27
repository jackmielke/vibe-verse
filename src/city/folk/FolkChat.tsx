/**
 * Talking to Vibe City's pedestrians.
 *
 * Shows a "Talk to Rosa (T)" pill while somebody is in reach, and a small
 * chat panel once you start. Each line goes to `folk-chat`, which keeps the
 * personalities; when that is unreachable the person answers from their own
 * lines in `cast.ts`, so the conversation never just stops. Replies also
 * appear as a speech bubble over their head, for anyone watching.
 */
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FolkDef } from "./cast";

export interface FolkChatProps {
  near: FolkDef | null;
  open: FolkDef | null;
  look: string;
  onOpen(def: FolkDef): void;
  onClose(): void;
  /** Show their reply over their head. */
  onSay(id: string, text: string): void;
}

type Line = { role: "user" | "assistant"; content: string };

export function folkFallback(def: FolkDef, turn: number): string {
  return turn < def.lines.length ? def.lines[turn] : def.lines[Math.floor(Math.random() * def.lines.length)];
}

export default function FolkChat({ near, open, look, onOpen, onClose, onSay }: FolkChatProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const turns = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const memory = useRef(new Map<string, Line[]>());

  // Opening somebody restores what you said to them earlier this visit, and
  // a first hello comes from their own lines at once.
  useEffect(() => {
    if (!open) return;
    const prev = memory.current.get(open.id);
    if (prev?.length) {
      setLines(prev);
    } else {
      const hi = folkFallback(open, 0);
      const first: Line[] = [{ role: "assistant", content: hi }];
      setLines(first);
      onSay(open.id, hi);
      turns.current = 1;
    }
    setTimeout(() => inputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id]);

  useEffect(() => {
    if (open) memory.current.set(open.id, lines);
  }, [lines, open]);

  const send = async () => {
    const text = draft.trim();
    if (!open || !text || busy) return;
    setDraft("");
    const next: Line[] = [...lines, { role: "user", content: text.slice(0, 300) }];
    setLines(next);
    setBusy(true);
    let reply = "";
    try {
      const { data, error } = await supabase.functions.invoke("folk-chat", { body: { id: open.id, messages: next.slice(-10), look } });
      if (!error && data && typeof (data as { reply?: unknown }).reply === "string") reply = (data as { reply: string }).reply;
    } catch {
      /* fall through to their own lines */
    }
    if (!reply) reply = folkFallback(open, turns.current);
    turns.current++;
    setLines((l) => [...l, { role: "assistant", content: reply }]);
    onSay(open.id, reply);
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  if (!open) {
    if (!near) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-36 z-40 flex justify-center md:bottom-24">
        <button
          className="pointer-events-auto rounded-full bg-violet-600/90 px-4 py-2 text-sm font-semibold text-white shadow-lg backdrop-blur hover:bg-violet-500"
          onClick={(e) => {
            onOpen(near);
            e.currentTarget.blur();
          }}
        >
          💬 Talk to {near.name} <span className="ml-1 hidden rounded bg-white/20 px-1.5 text-xs md:inline">T</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-white/15 bg-slate-950/85 p-3 text-white shadow-2xl backdrop-blur-md"
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-bold">{open.name}</div>
          <div className="text-xs text-white/60">{open.role}</div>
        </div>
        <button className="rounded-full px-2 py-1 text-xs text-white/70 hover:bg-white/10" onClick={onClose} aria-label="Stop talking">
          Bye ✕
        </button>
      </div>
      <div className="mb-2 max-h-48 space-y-1.5 overflow-y-auto text-sm">
        {lines.map((l, i) => (
          <div key={i} className={l.role === "user" ? "text-right" : ""}>
            <span className={`inline-block rounded-xl px-2.5 py-1.5 ${l.role === "user" ? "bg-violet-600/80" : "bg-white/10"}`}>{l.content}</span>
          </div>
        ))}
        {busy && <div className="text-xs text-white/50">{open.name} is thinking…</div>}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          maxLength={300}
          placeholder={`Say something to ${open.name}…`}
          className="min-w-0 flex-1 rounded-full bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/40 focus:bg-white/15"
        />
        <button type="submit" disabled={busy || !draft.trim()} className="rounded-full bg-violet-600 px-3 py-2 text-sm font-semibold disabled:opacity-40">
          Send
        </button>
      </form>
    </div>
  );
}
