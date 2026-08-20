/**
 * The wall of notes on the Empyrean's title card.
 *
 * A visitor should be able to leave a mark before they have decided whether to
 * play — so this sits on the arrival screen, not behind it, and it never asks
 * anybody to sign in. `empyrean_notes` is world-readable and world-writable by
 * design: it is a guestbook, and a guestbook that needs an account is a form.
 *
 * The name is remembered in localStorage so a returning visitor types only the
 * note. Insert failures are shown rather than swallowed; a note that silently
 * vanishes is worse than one that says it did not send.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Note {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

const NAME_KEY = "empyrean:guest-name";
const MAX_BODY = 180;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Guestbook() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuthor(localStorage.getItem(NAME_KEY) ?? "");
  }, []);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("empyrean_notes")
      .select("id, author, body, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (!err && data) setNotes(data as Note[]);
  }, []);

  useEffect(() => {
    void load();
    // Live, so two people on the title card at once see each other arrive.
    const channel = supabase
      .channel("empyrean-notes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "empyrean_notes" },
        (payload) => setNotes((n) => [payload.new as Note, ...n].slice(0, 30)),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const send = async () => {
    const name = author.trim() || "anonymous";
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const { error: err } = await supabase
      .from("empyrean_notes")
      .insert({ author: name.slice(0, 32), body: text.slice(0, MAX_BODY) });
    setSending(false);
    if (err) {
      setError("That note didn't make it. Try again?");
      return;
    }
    localStorage.setItem(NAME_KEY, name);
    setBody("");
    void load();
  };

  return (
    <div className="w-full max-w-md rounded-[1.75rem] sm:rounded-3xl border border-white/25 bg-white/10 p-4 text-left shadow-[0_20px_80px_rgba(10,10,40,0.45)] backdrop-blur-xl">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-[0.34em] text-white/80">
          Notes from the edge
        </p>
        <span className="text-[10px] text-white/55">{notes.length} left so far</span>
      </div>

      <div className="mt-3 max-h-32 sm:max-h-40 space-y-1.5 overflow-y-auto pr-1">
        {notes.length === 0 && (
          <p className="py-3 text-center text-xs text-white/60">
            Nobody's written anything yet. Go first.
          </p>
        )}
        {notes.map((n) => (
          <div
            key={n.id}
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 backdrop-blur-md"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-cyan-100">
                {n.author}
              </span>
              <span className="shrink-0 text-[10px] text-white/50">{ago(n.created_at)}</span>
            </div>
            <p className="mt-0.5 break-words text-[12px] leading-snug text-white/90">{n.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          maxLength={32}
          placeholder="your name"
          className="w-24 shrink-0 rounded-full sm:w-28 border border-white/20 bg-white/10 px-3 py-2 text-xs text-white placeholder:text-white/45 outline-none backdrop-blur-md focus:border-white/45"
        />
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          maxLength={MAX_BODY}
          placeholder="leave a note in the sky…"
          className="min-w-[8rem] flex-1 rounded-full border border-white/20 bg-white/10 px-3 py-2 text-xs text-white placeholder:text-white/45 outline-none backdrop-blur-md focus:border-white/45"
        />
        <button
          onClick={() => void send()}
          disabled={sending || !body.trim()}
          className="shrink-0 rounded-full border border-white/40 bg-white/20 px-3 py-2 text-xs font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/30 disabled:opacity-40"
        >
          {sending ? "…" : "Post"}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-rose-200">{error}</p>}
    </div>
  );
}
