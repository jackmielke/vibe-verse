/**
 * VibeyJournal — Vibey's stream-of-consciousness journal.
 *
 * Floats as a small glowing leather-bound book in the corner of
 * /space. When someone is watching the show, every ~10 minutes the
 * vibey-journal edge function generates a new entry sourced from
 * the community's Telegram chats + recent activity. Click the book
 * to open the full journal — entries render as handwritten pages,
 * and the newest one types itself in real time.
 *
 * Architecture:
 *   - Realtime subscription to `vibey_journal_entries` so all
 *     watchers see new pages land at the same moment.
 *   - Auto-tick poller: every few minutes, if the latest entry is
 *     older than 10 minutes AND we're not already generating, hit
 *     the edge function. The function itself is idempotent so it's
 *     fine if multiple watchers fire concurrently.
 *   - Typewriter animation only on entries that arrived this session;
 *     historical entries render fully so opening the journal cold
 *     doesn't replay everything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BookOpen, X, Sparkles, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface JournalEntry {
  id: string;
  community_id: string;
  body: string;
  mood: string | null;
  source_summary: string | null;
  message_count: number | null;
  created_at: string;
}

interface Props {
  communityId: string;
  /** Set to true while at least one viewer (including the user) is
      currently in /space. Drives the auto-tick polling. */
  watching: boolean;
}

const PAGE_SIZE = 24;
const TICK_INTERVAL_MS = 60 * 1000;           // check eligibility every minute
const ENTRY_INTERVAL_MS = 10 * 60 * 1000;     // mirror the edge function's interval

export default function VibeyJournal({ communityId, watching }: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which entry ids arrived live this session (so we typewriter
  // them, not the historical pages).
  const liveIdsRef = useRef<Set<string>>(new Set());
  // Marker for "we just got a new entry" so the closed-state book pulses.
  const [unseen, setUnseen] = useState(0);

  // ---- Initial load ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("vibey_journal_entries")
      .select("id, community_id, body, mood, source_summary, message_count, created_at")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE)
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); return; }
        if (data) setEntries(data as JournalEntry[]);
      });
    return () => { cancelled = true; };
  }, [communityId]);

  // ---- Realtime subscription -------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`vibey-journal-${communityId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "vibey_journal_entries",
          filter: `community_id=eq.${communityId}`,
        },
        (payload) => {
          const fresh = payload.new as JournalEntry;
          liveIdsRef.current.add(fresh.id);
          setEntries((prev) => {
            if (prev.some((e) => e.id === fresh.id)) return prev;
            return [fresh, ...prev].slice(0, PAGE_SIZE);
          });
          // If the journal isn't open, signal that there's something new.
          if (!open) setUnseen((u) => u + 1);
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId]);

  // ---- Auto-tick: ask the edge function for a new entry if eligible ---
  const triggerWrite = useCallback(async (force = false) => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.functions.invoke("vibey-journal", {
        body: { community_id: communityId, force },
      });
      if (err) throw err;
      // If the function created a new entry but the realtime channel
      // beat us (unlikely but possible), don't duplicate.
      if (data?.created && data.entry) {
        liveIdsRef.current.add(data.entry.id);
        setEntries((prev) => {
          if (prev.some((e) => e.id === data.entry.id)) return prev;
          return [data.entry, ...prev].slice(0, PAGE_SIZE);
        });
        if (!open) setUnseen((u) => u + 1);
      }
    } catch (e) {
      setError((e as Error).message ?? "Couldn't reach Vibey's journal");
    } finally {
      setGenerating(false);
    }
  }, [communityId, generating, open]);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const tryTick = () => {
      if (cancelled) return;
      const latest = entries[0];
      const age = latest
        ? Date.now() - new Date(latest.created_at).getTime()
        : Infinity;
      if (age >= ENTRY_INTERVAL_MS) {
        triggerWrite(false);
      }
    };
    // First check ~3 seconds after mount so the user sees something
    // happen if their visit is the trigger.
    const initial = window.setTimeout(tryTick, 3000);
    const id = window.setInterval(tryTick, TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(id);
    };
    // We only restart the timer when watching toggles. Entries[0]
    // changes constantly via realtime; using it in deps would reset
    // the timer too aggressively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, communityId]);

  // Reset unseen badge when the journal opens.
  useEffect(() => {
    if (open) setUnseen(0);
  }, [open]);

  const currentEntry = entries[pageIndex] ?? null;
  const isLiveEntry =
    currentEntry != null && liveIdsRef.current.has(currentEntry.id);

  // ---- Render ----------------------------------------------------------
  return (
    <>
      <FloatingBookButton
        onClick={() => setOpen(true)}
        generating={generating}
        unseen={unseen}
      />
      <AnimatePresence>
        {open && (
          <JournalOverlay
            entries={entries}
            pageIndex={pageIndex}
            setPageIndex={setPageIndex}
            currentEntry={currentEntry}
            isLiveEntry={isLiveEntry}
            generating={generating}
            error={error}
            onClose={() => setOpen(false)}
            onForce={() => triggerWrite(true)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ----------------------------------------------------------------------
// Floating closed-book button — sits in /space at bottom-left
// ----------------------------------------------------------------------

function FloatingBookButton({
  onClick,
  generating,
  unseen,
}: {
  onClick: () => void;
  generating: boolean;
  unseen: number;
}) {
  return (
    <button
      onClick={onClick}
      className="absolute left-4 bottom-32 md:bottom-20 z-10 select-none"
      style={{ perspective: "600px" }}
      title="Vibey's journal"
    >
      <div
        className="relative w-14 h-16 rounded-md rounded-l-sm group transition-transform hover:scale-[1.08]"
        style={{
          transformStyle: "preserve-3d",
          transform: "rotateY(-22deg) rotateX(8deg)",
          // Leather cover gradient + warm rim glow.
          background:
            "linear-gradient(135deg, #4a2e1a 0%, #2a1a10 60%, #1a0f08 100%)",
          boxShadow:
            "0 6px 18px rgba(0,0,0,0.6), 0 0 22px hsl(45 90% 60% / 0.35), inset 0 0 0 1px rgba(255,200,120,0.18)",
          animation: "vibeyJournalFloat 4.5s ease-in-out infinite",
        }}
      >
        {/* Spine — left edge of the book */}
        <div
          className="absolute inset-y-1 left-0 w-1.5 rounded-l-sm"
          style={{
            background:
              "linear-gradient(180deg, #c8941a 0%, #5a3c10 50%, #c8941a 100%)",
            boxShadow: "0 0 10px hsl(45 90% 55% / 0.7)",
          }}
        />
        {/* Page edges peeking out */}
        <div
          className="absolute inset-y-1.5 right-0.5 w-1"
          style={{
            background:
              "repeating-linear-gradient(180deg, #fdf6e3 0px, #fdf6e3 2px, #e6dabc 2px, #e6dabc 3px)",
            opacity: 0.9,
          }}
        />
        {/* Embossed "V" on the cover */}
        <span
          className="absolute inset-0 flex items-center justify-center font-display font-bold text-lg"
          style={{
            color: "rgba(255, 210, 130, 0.85)",
            textShadow:
              "0 1px 0 rgba(0,0,0,0.6), 0 0 12px hsl(45 90% 60% / 0.5)",
            pointerEvents: "none",
          }}
        >
          V
        </span>
        {/* Active "writing" glow when generating */}
        {generating && (
          <span
            className="absolute -top-1 -right-1 w-3 h-3 rounded-full"
            style={{
              background: "hsl(45 90% 60%)",
              boxShadow: "0 0 10px hsl(45 90% 60% / 0.9)",
              animation: "vibeyJournalPulse 1s ease-in-out infinite",
            }}
            title="Vibey is writing…"
          />
        )}
        {/* "New entry" badge */}
        {!generating && unseen > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-heading font-bold flex items-center justify-center px-1 shadow-lg">
            {unseen}
          </span>
        )}
      </div>
      <div className="mt-1 text-center">
        <span className="text-[9px] uppercase tracking-widest font-heading font-semibold text-foreground/70 group-hover:text-foreground">
          Journal
        </span>
      </div>
    </button>
  );
}

// ----------------------------------------------------------------------
// Journal overlay — handwritten pages, prev/next nav, typewriter
// ----------------------------------------------------------------------

function JournalOverlay({
  entries,
  pageIndex,
  setPageIndex,
  currentEntry,
  isLiveEntry,
  generating,
  error,
  onClose,
  onForce,
}: {
  entries: JournalEntry[];
  pageIndex: number;
  setPageIndex: (i: number) => void;
  currentEntry: JournalEntry | null;
  isLiveEntry: boolean;
  generating: boolean;
  error: string | null;
  onClose: () => void;
  onForce: () => void;
}) {
  const total = entries.length;
  // Typewriter: only render the live entry's body progressively.
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (!currentEntry) return;
    if (!isLiveEntry) {
      setTyped(currentEntry.body.length);
      return;
    }
    setTyped(0);
    let i = 0;
    const step = () => {
      i += 1;
      setTyped(i);
      if (i < currentEntry.body.length) {
        // 18-32ms per char so it reads like writing.
        window.setTimeout(step, 18 + Math.random() * 14);
      }
    };
    const t = window.setTimeout(step, 240);
    return () => window.clearTimeout(t);
  }, [currentEntry?.id, isLiveEntry, currentEntry?.body, currentEntry]);

  // Keyboard nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && pageIndex < total - 1) setPageIndex(pageIndex + 1);
      if (e.key === "ArrowRight" && pageIndex > 0) setPageIndex(pageIndex - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageIndex, total, onClose, setPageIndex]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[3px] p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92, rotate: -2, y: 30 }}
        animate={{ opacity: 1, scale: 1, rotate: -1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 20 }}
        transition={{ type: "spring", damping: 22, stiffness: 220 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-md p-6 md:p-7 shadow-2xl"
        style={{
          background:
            "repeating-linear-gradient(180deg, #fdf6e3 0px, #fdf6e3 28px, #e9dcb8 29px, #fdf6e3 30px)",
          color: "#2e1f10",
          fontFamily:
            "'Caveat', 'Homemade Apple', 'Bradley Hand', 'Comic Sans MS', cursive, ui-sans-serif",
          border: "1px solid #d4c39a",
          boxShadow:
            "0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 4px #fdf6e3, inset 0 0 0 5px #c9b88a",
        }}
      >
        {/* Tape corners for charm */}
        <div aria-hidden className="absolute -top-2 left-8 w-12 h-4 bg-amber-200/70 rotate-[-5deg]" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
        <div aria-hidden className="absolute -top-2 right-10 w-12 h-4 bg-amber-200/70 rotate-[6deg]" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />

        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-amber-900/10 transition-colors"
          title="Close"
          style={{ color: "#2e1f10" }}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 mb-3">
          <BookOpen className="w-4 h-4" style={{ color: "#2e1f10" }} />
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-70 font-sans font-semibold">
            Vibey's notebook
          </p>
          {generating && (
            <span className="ml-auto text-[10px] inline-flex items-center gap-1 opacity-70 font-sans">
              <Sparkles className="w-3 h-3 animate-pulse" />
              writing…
            </span>
          )}
        </div>

        {/* Empty state */}
        {!currentEntry && !generating && (
          <div className="py-8 text-center">
            <p className="text-xl">The page is blank.</p>
            <p className="text-sm mt-2 font-sans opacity-70">
              Vibey hasn't written anything yet. Hang around a moment — he tends
              to start journaling when someone's watching.
            </p>
            <button
              onClick={onForce}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-amber-800/40 bg-amber-100/40 hover:bg-amber-100/70 transition-colors px-3 py-1.5 text-xs font-sans font-semibold"
              style={{ color: "#2e1f10" }}
            >
              <Sparkles className="w-3 h-3" />
              Nudge Vibey
            </button>
          </div>
        )}

        {/* Active entry */}
        {currentEntry && (
          <>
            <div className="flex items-baseline gap-3 mb-2">
              <h2 className="text-2xl leading-tight">
                {formatJournalDate(currentEntry.created_at)}
              </h2>
              {currentEntry.mood && (
                <span className="text-[10px] uppercase tracking-widest opacity-60 font-sans">
                  {currentEntry.mood}
                </span>
              )}
            </div>

            <p className="text-lg leading-relaxed whitespace-pre-line min-h-[6rem]">
              {isLiveEntry ? (
                <>
                  {currentEntry.body.slice(0, typed)}
                  {typed < currentEntry.body.length && (
                    <span className="opacity-50 animate-pulse">▍</span>
                  )}
                </>
              ) : (
                currentEntry.body
              )}
            </p>

            {currentEntry.source_summary && (
              <p className="mt-4 text-[11px] font-sans opacity-50 italic">
                — {currentEntry.source_summary}
              </p>
            )}
          </>
        )}

        {/* Page navigation */}
        {total > 0 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-amber-800/30">
            <button
              onClick={() => setPageIndex(Math.min(total - 1, pageIndex + 1))}
              disabled={pageIndex >= total - 1}
              className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
              style={{ color: "#2e1f10" }}
            >
              <ChevronLeft className="w-3 h-3" />
              older
            </button>
            <p className="text-[10px] font-sans opacity-60">
              page {pageIndex + 1} of {total}
            </p>
            <button
              onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
              disabled={pageIndex === 0}
              className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
              style={{ color: "#2e1f10" }}
            >
              newer
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Manual refresh — power-user "write me one now" button */}
        <div className="flex items-center justify-between mt-3">
          <p className="text-[10px] font-sans opacity-50">
            new pages every ~10 min while someone's watching
          </p>
          <button
            onClick={onForce}
            disabled={generating}
            className="text-[10px] font-sans font-semibold inline-flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
            style={{ color: "#2e1f10" }}
            title="Force a new entry now"
          >
            <RefreshCw className={`w-3 h-3 ${generating ? "animate-spin" : ""}`} />
            nudge
          </button>
        </div>

        {error && (
          <p className="text-[10px] font-sans text-rose-700 bg-rose-200/40 border border-rose-400/30 rounded px-2 py-1 mt-3">
            {error}
          </p>
        )}
      </motion.div>
    </motion.div>
  );
}

function formatJournalDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
