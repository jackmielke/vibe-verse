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
import { BookOpen, X, Sparkles, RefreshCw, ChevronLeft, ChevronRight, NotebookPen, Cpu } from "lucide-react";
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

interface VibeyIdentity {
  id: string;
  name: string | null;
  avatar_url: string | null;
  intro_message: string | null;
  model: string | null;
  temperature: number | string | null;
  skills: string[] | null;
  telegram_enabled: boolean | null;
  system_prompt: string | null;
  updated_at: string | null;
}

type Tab = "journal" | "identity" | "overnight";

interface ResearchRow {
  id: string;
  source_label: string;
  url: string;
  title: string | null;
  summary: string;
  fetched_at: string;
}

interface SoulDraftRow {
  id: string;
  status: "pending" | "applied" | "rejected" | string;
  proposed_addition: string | null;
  reasoning: string | null;
  diff_summary: string | null;
  created_at: string;
}

// Split the soul (system_prompt) into pages on blank lines, then
// merge any "stub" pages (a short heading like "Your goals:" with
// nothing else) into the page that follows them. The old splitter
// would leave a page that just said "Your goals:" and a separate
// page with the actual list — this fixes that.
function splitSoulIntoPages(soul: string): string[] {
  if (!soul) return [];
  const raw = soul
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged: string[] = [];
  // A "stub" is a short fragment with no body, usually a heading.
  const STUB_MAX = 60;
  const isStub = (s: string) =>
    s.length <= STUB_MAX && !/\n/.test(s);

  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (isStub(cur) && i + 1 < raw.length) {
      merged.push(`${cur}\n${raw[i + 1]}`);
      i += 1; // consume the next chunk as part of this page
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

interface Props {
  communityId: string;
  /** Set to true while at least one viewer (including the user) is
      currently in /space. Drives the auto-tick polling. */
  watching: boolean;
  /** Optional controlled open state — used when a 3D click in the
      scene drives the modal instead of the built-in floating book. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in 2D floating book chip. Used when a 3D
      version is rendered in the Three.js scene instead. */
  showFloatingBook?: boolean;
  /** Called whenever a new live entry lands. Lets the parent pulse
      the 3D book or play a sound, etc. */
  onLiveEntry?: () => void;
}

const PAGE_SIZE = 24;
const TICK_INTERVAL_MS = 60 * 1000;           // check eligibility every minute
const ENTRY_INTERVAL_MS = 10 * 60 * 1000;     // mirror the edge function's interval

export default function VibeyJournal({
  communityId,
  watching,
  open: openProp,
  onOpenChange,
  showFloatingBook = true,
  onLiveEntry,
}: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [openSelf, setOpenSelf] = useState(false);
  // Support both controlled (open prop from parent) and uncontrolled
  // (internal state) modes so the component works standalone too.
  const open = openProp ?? openSelf;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenSelf(next);
    onOpenChange?.(next);
  };
  const [tab, setTab] = useState<Tab>("journal");
  const [pageIndex, setPageIndex] = useState(0);
  const [identity, setIdentity] = useState<VibeyIdentity | null>(null);
  const [identityPage, setIdentityPage] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Overnight digest — research Vibey has read + soul drafts pending review.
  const [research, setResearch] = useState<ResearchRow[]>([]);
  const [drafts, setDrafts] = useState<SoulDraftRow[]>([]);
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
          onLiveEntry?.();
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
        onLiveEntry?.();
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

  // Load Overnight tab data (research + drafts) whenever it's visible.
  // Refreshes every minute while open so the morning view stays live.
  useEffect(() => {
    if (!open || tab !== "overnight") return;
    let cancelled = false;
    const load = async () => {
      const [{ data: r }, { data: d }] = await Promise.all([
        supabase
          .from("vibey_research_log")
          .select("id, source_label, url, title, summary, fetched_at")
          .eq("community_id", communityId)
          .eq("ok", true)
          .order("fetched_at", { ascending: false })
          .limit(20),
        supabase
          .from("vibey_soul_drafts")
          .select("id, status, proposed_addition, reasoning, diff_summary, created_at")
          .eq("community_id", communityId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      if (cancelled) return;
      if (r) setResearch(r as ResearchRow[]);
      if (d) setDrafts(d as SoulDraftRow[]);
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, tab, communityId]);

  // Lazy-load Vibey's identity when the Notes-to-Self tab is first
  // requested. We don't re-fetch on every tab change; the agent row
  // doesn't move that often.
  useEffect(() => {
    if (!open || tab !== "identity" || identity) return;
    let cancelled = false;
    supabase.functions
      .invoke("vibey-identity", { body: { community_id: communityId } })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          setError(err.message);
          return;
        }
        if (data?.agent) setIdentity(data.agent as VibeyIdentity);
      });
    return () => { cancelled = true; };
  }, [open, tab, identity, communityId]);

  const currentEntry = entries[pageIndex] ?? null;
  const isLiveEntry =
    currentEntry != null && liveIdsRef.current.has(currentEntry.id);

  // ---- Render ----------------------------------------------------------
  return (
    <>
      {showFloatingBook && (
        <FloatingBookButton
          onClick={() => setOpen(true)}
          generating={generating}
          unseen={unseen}
        />
      )}
      <AnimatePresence>
        {open && (
          <JournalOverlay
            tab={tab}
            setTab={setTab}
            entries={entries}
            pageIndex={pageIndex}
            setPageIndex={setPageIndex}
            identity={identity}
            identityPage={identityPage}
            setIdentityPage={setIdentityPage}
            research={research}
            drafts={drafts}
            onDraftChange={(id, next) => {
              setDrafts((prev) =>
                prev.map((d) => (d.id === id ? { ...d, status: next } : d)),
              );
            }}
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
      // The OUTER wrapper drifts on a long, looping path so the book
      // reads as "floating around the scene" rather than parked in
      // the corner. We anchor near the upper-left so we don't fight
      // the music player at the bottom, then let the keyframe carry
      // it across a generous orbit.
      className="absolute top-24 left-6 md:top-32 md:left-10 z-10 select-none"
      style={{
        perspective: "600px",
        animation: "vibeyJournalDrift 22s ease-in-out infinite",
        willChange: "transform",
      }}
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
          // Inner bob — quicker than the outer drift so the book
          // looks like it's hovering on its own thrusters.
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
  tab,
  setTab,
  entries,
  pageIndex,
  setPageIndex,
  identity,
  identityPage,
  setIdentityPage,
  research,
  drafts,
  onDraftChange,
  currentEntry,
  isLiveEntry,
  generating,
  error,
  onClose,
  onForce,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  entries: JournalEntry[];
  pageIndex: number;
  setPageIndex: (i: number) => void;
  identity: VibeyIdentity | null;
  identityPage: number;
  setIdentityPage: (i: number) => void;
  research: ResearchRow[];
  drafts: SoulDraftRow[];
  onDraftChange: (id: string, next: "pending" | "applied" | "rejected") => void;
  currentEntry: JournalEntry | null;
  isLiveEntry: boolean;
  generating: boolean;
  error: string | null;
  onClose: () => void;
  onForce: () => void;
}) {
  const total = entries.length;
  const soulPages = identity?.system_prompt ? splitSoulIntoPages(identity.system_prompt) : [];
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

  // Keyboard nav — pages within whichever tab is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (tab === "journal") {
        if (e.key === "ArrowLeft" && pageIndex < total - 1) setPageIndex(pageIndex + 1);
        if (e.key === "ArrowRight" && pageIndex > 0) setPageIndex(pageIndex - 1);
      } else if (tab === "identity") {
        if (e.key === "ArrowLeft" && identityPage > 0) setIdentityPage(identityPage - 1);
        if (e.key === "ArrowRight" && identityPage < soulPages.length - 1)
          setIdentityPage(identityPage + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, pageIndex, total, identityPage, soulPages.length, onClose, setPageIndex, setIdentityPage]);

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
        className="relative w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-md p-6 md:p-7 shadow-2xl"
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

        <div className="flex items-center gap-2 mb-2">
          <BookOpen className="w-4 h-4" style={{ color: "#2e1f10" }} />
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-70 font-sans font-semibold">
            Vibey's notebook
          </p>
          {generating && tab === "journal" && (
            <span className="ml-auto text-[10px] inline-flex items-center gap-1 opacity-70 font-sans">
              <Sparkles className="w-3 h-3 animate-pulse" />
              writing…
            </span>
          )}
        </div>

        {/* Tab switcher — Journal pages vs Notes to self (soul) */}
        <div className="flex gap-1 p-0.5 mb-3 rounded-md bg-amber-900/8 border border-amber-800/20 text-[11px] font-sans">
          <button
            onClick={() => setTab("journal")}
            className={`flex-1 px-2 py-1 rounded transition-colors inline-flex items-center justify-center gap-1.5 ${
              tab === "journal"
                ? "bg-amber-100 font-semibold"
                : "opacity-60 hover:opacity-100"
            }`}
            style={{ color: "#2e1f10" }}
          >
            <NotebookPen className="w-3 h-3" />
            Journal
          </button>
          <button
            onClick={() => setTab("identity")}
            className={`flex-1 px-2 py-1 rounded transition-colors inline-flex items-center justify-center gap-1.5 ${
              tab === "identity"
                ? "bg-amber-100 font-semibold"
                : "opacity-60 hover:opacity-100"
            }`}
            style={{ color: "#2e1f10" }}
          >
            <Cpu className="w-3 h-3" />
            Notes to self
          </button>
          <button
            onClick={() => setTab("overnight")}
            className={`flex-1 px-2 py-1 rounded transition-colors inline-flex items-center justify-center gap-1.5 relative ${
              tab === "overnight"
                ? "bg-amber-100 font-semibold"
                : "opacity-60 hover:opacity-100"
            }`}
            style={{ color: "#2e1f10" }}
            title="What Vibey read and what it wants to learn"
          >
            <Sparkles className="w-3 h-3" />
            Overnight
            {drafts.some((d) => d.status === "pending") && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                style={{ background: "#b8540a" }}
                aria-label="pending soul drafts"
              />
            )}
          </button>
        </div>

        {/* ----- OVERNIGHT (research + drafts) tab ----- */}
        {tab === "overnight" && (
          <OvernightDigest
            research={research}
            drafts={drafts}
            onDraftChange={onDraftChange}
          />
        )}

        {/* ----- IDENTITY (Notes to self) tab ----- */}
        {tab === "identity" && (
          <IdentityPage
            identity={identity}
            soulPages={soulPages}
            identityPage={identityPage}
            setIdentityPage={setIdentityPage}
          />
        )}

        {/* ----- JOURNAL tab ----- */}

        {/* Empty state */}
        {tab === "journal" && !currentEntry && !generating && (
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
        {tab === "journal" && currentEntry && (
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

        {/* Page navigation (journal tab) */}
        {tab === "journal" && total > 0 && (
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
        {tab === "journal" && (
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
        )}

        {error && (
          <p className="text-[10px] font-sans text-rose-700 bg-rose-200/40 border border-rose-400/30 rounded px-2 py-1 mt-3">
            {error}
          </p>
        )}
      </motion.div>
    </motion.div>
  );
}

// ----------------------------------------------------------------------
// IdentityPage — the "Notes to Self" tab. Pulls Vibey's live agent
// config (system_prompt, skills, model, temperature) and renders it
// as paginated handwritten pages plus a meta footer.
// ----------------------------------------------------------------------

function IdentityPage({
  identity,
  soulPages,
  identityPage,
  setIdentityPage,
}: {
  identity: VibeyIdentity | null;
  soulPages: string[];
  identityPage: number;
  setIdentityPage: (i: number) => void;
}) {
  if (!identity) {
    return (
      <p className="text-base font-sans opacity-60 italic py-6 text-center">
        Loading my own instructions…
      </p>
    );
  }

  const total = soulPages.length;
  const currentSection = soulPages[identityPage] ?? "";

  // Detect a SHOUTY heading at the top of a section ("PERSONALITY",
  // "BOUNDARIES" etc) and elevate it as the page title.
  const firstLine = currentSection.split("\n", 1)[0] ?? "";
  const isHeading =
    firstLine.length <= 40 &&
    firstLine === firstLine.toUpperCase() &&
    /[A-Z]/.test(firstLine);
  const title = isHeading
    ? firstLine.replace(/^(.*?)$/, (s) => s.charAt(0) + s.slice(1).toLowerCase())
    : `Page ${identityPage + 1}`;
  const bodyText = isHeading
    ? currentSection.slice(firstLine.length).replace(/^\n+/, "")
    : currentSection;

  return (
    <>
      {/* Top "card" — name, model, skills */}
      <div className="rounded-md border border-amber-800/30 bg-amber-100/40 px-3 py-2 mb-3 font-sans text-[11px] leading-snug">
        <p className="font-semibold text-[12px]">
          I am {identity.name ?? "Vibey"}.
        </p>
        {identity.intro_message && (
          <p className="opacity-70 italic mt-0.5">"{identity.intro_message}"</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 opacity-70">
          {identity.model && <span>model: {identity.model}</span>}
          {identity.temperature != null && (
            <span>temp: {identity.temperature}</span>
          )}
          {identity.telegram_enabled && <span>· on Telegram</span>}
        </div>
        {identity.skills && identity.skills.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {identity.skills.map((s) => (
              <span
                key={s}
                className="px-1.5 py-0.5 rounded bg-amber-200/60 border border-amber-800/30 text-[10px]"
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Paginated soul */}
      <h2 className="text-2xl leading-tight mb-2">{title}</h2>
      <p className="text-base leading-relaxed whitespace-pre-line min-h-[8rem]">
        {bodyText.trim() || "(blank page)"}
      </p>

      {total > 1 && (
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-amber-800/30">
          <button
            onClick={() => setIdentityPage(Math.max(0, identityPage - 1))}
            disabled={identityPage === 0}
            className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
            style={{ color: "#2e1f10" }}
          >
            <ChevronLeft className="w-3 h-3" />
            prev
          </button>
          <p className="text-[10px] font-sans opacity-60">
            page {identityPage + 1} of {total}
          </p>
          <button
            onClick={() => setIdentityPage(Math.min(total - 1, identityPage + 1))}
            disabled={identityPage >= total - 1}
            className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
            style={{ color: "#2e1f10" }}
          >
            next
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}

      <p className="mt-3 text-[10px] font-sans opacity-50">
        these are the instructions I read to myself before every reply ·
        live from the agents row · last updated{" "}
        {identity.updated_at
          ? new Date(identity.updated_at).toLocaleDateString()
          : "—"}
      </p>
    </>
  );
}

// ----------------------------------------------------------------------
// OvernightDigest — what Vibey read + the soul updates he wants to propose.
// Drafts have apply / reject buttons that PATCH the row directly via the
// anon client (RLS allows SELECT but not UPDATE — so the update goes
// through a small edge function call instead).
// ----------------------------------------------------------------------

// Each item is a single notebook page. Page 0 is always the
// drafts inbox (all pending drafts together — they're the headline);
// pages 1+ are individual research entries Vibey has been reading.
function OvernightDigest({
  research,
  drafts,
  onDraftChange,
}: {
  research: ResearchRow[];
  drafts: SoulDraftRow[];
  onDraftChange: (id: string, next: "pending" | "applied" | "rejected") => void;
}) {
  const [page, setPage] = useState(0);
  const totalPages = 1 + research.length; // 1 drafts page + N research pages

  const next = () => setPage((p) => Math.min(totalPages - 1, p + 1));
  const prev = () => setPage((p) => Math.max(0, p - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Arrow nav is handled at the overlay level for the main
      // journal/identity tabs; here we listen only for our own
      // dedicated keys so we don't fight with that handler.
      if (e.key === "PageDown") { e.preventDefault(); next(); }
      if (e.key === "PageUp") { e.preventDefault(); prev(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages]);

  return (
    <div>
      {page === 0 ? (
        <DraftsPage drafts={drafts} onDraftChange={onDraftChange} />
      ) : (
        <ResearchPage row={research[page - 1]} />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-amber-800/30">
          <button
            onClick={prev}
            disabled={page === 0}
            className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
            style={{ color: "#2e1f10" }}
          >
            <ChevronLeft className="w-3 h-3" />
            prev
          </button>
          <p className="text-[10px] font-sans opacity-60">
            {page === 0
              ? "drafts inbox"
              : `reading ${page} of ${research.length}`}
            {" · page "}{page + 1}{" of "}{totalPages}
          </p>
          <button
            onClick={next}
            disabled={page >= totalPages - 1}
            className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline inline-flex items-center gap-1"
            style={{ color: "#2e1f10" }}
          >
            next
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function DraftsPage({
  drafts,
  onDraftChange,
}: {
  drafts: SoulDraftRow[];
  onDraftChange: (id: string, next: "pending" | "applied" | "rejected") => void;
}) {
  const pending = drafts.filter((d) => d.status === "pending");
  const reviewed = drafts.filter((d) => d.status !== "pending");

  const updateDraft = async (id: string, status: "applied" | "rejected") => {
    onDraftChange(id, status); // optimistic
    await supabase.functions
      .invoke("vibey-soul-draft-review", { body: { id, status } })
      .catch((e) => console.warn("[overnight] draft review failed:", e));
  };

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xl">Drafts for my soul</h3>
        <span className="text-[10px] font-sans opacity-60">
          {pending.length} pending · {reviewed.length} reviewed
        </span>
      </div>
      {pending.length === 0 && (
        <p className="text-base font-sans opacity-60 italic">
          No new soul drafts yet. They'll show up here whenever I have a
          thought worth committing to.
        </p>
      )}
      <div className="space-y-3">
        {pending.map((d) => (
          <div
            key={d.id}
            className="rounded-md border border-amber-800/30 bg-amber-100/50 p-3"
          >
            <p className="text-[11px] uppercase tracking-widest font-sans opacity-60">
              {formatJournalDate(d.created_at)}
            </p>
            {d.diff_summary && (
              <h4 className="text-lg leading-tight mt-0.5">{d.diff_summary}</h4>
            )}
            {d.proposed_addition && (
              <blockquote className="text-base leading-relaxed mt-2 pl-3 border-l-2 border-amber-800/40 whitespace-pre-line">
                {d.proposed_addition}
              </blockquote>
            )}
            {d.reasoning && (
              <p className="text-[12px] font-sans opacity-70 mt-2 italic">
                why: {d.reasoning}
              </p>
            )}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => updateDraft(d.id, "applied")}
                className="px-3 py-1.5 rounded text-sm font-sans font-semibold text-emerald-50"
                style={{ background: "#3a7d3a" }}
              >
                Apply to soul
              </button>
              <button
                onClick={() => updateDraft(d.id, "rejected")}
                className="px-3 py-1.5 rounded text-sm font-sans font-semibold"
                style={{
                  color: "#2e1f10",
                  background: "rgba(120,80,60,0.12)",
                  border: "1px solid rgba(120,80,60,0.25)",
                }}
              >
                Skip
              </button>
            </div>
          </div>
        ))}
      </div>
      {reviewed.length > 0 && (
        <details className="mt-3">
          <summary className="text-[11px] font-sans opacity-60 cursor-pointer hover:opacity-100">
            {reviewed.length} reviewed
          </summary>
          <ul className="mt-2 space-y-1 text-[12px] font-sans">
            {reviewed.map((d) => (
              <li key={d.id} className="flex items-start gap-2 opacity-70">
                <span
                  className="inline-block w-12 text-center px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest"
                  style={{
                    background:
                      d.status === "applied"
                        ? "rgba(58, 125, 58, 0.2)"
                        : "rgba(120, 80, 60, 0.15)",
                  }}
                >
                  {d.status}
                </span>
                <span className="flex-1">
                  {d.diff_summary || (d.proposed_addition ?? "").slice(0, 80)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ResearchPage({ row }: { row: ResearchRow | undefined }) {
  if (!row) {
    return (
      <p className="text-base font-sans opacity-60 italic">
        Nothing on this page yet.
      </p>
    );
  }
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        {row.url && row.url.startsWith("http") ? (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] uppercase tracking-widest font-sans font-semibold hover:underline"
            style={{ color: "#2e1f10" }}
          >
            {row.source_label}
          </a>
        ) : (
          <span
            className="text-[11px] uppercase tracking-widest font-sans font-semibold"
            style={{ color: "#2e1f10" }}
          >
            {row.source_label}
          </span>
        )}
        <span className="text-[10px] font-sans opacity-60">
          {formatJournalDate(row.fetched_at)}
        </span>
      </div>
      {row.title && (
        <h2 className="text-2xl leading-tight mb-2">{row.title}</h2>
      )}
      <p className="text-base leading-relaxed whitespace-pre-line">
        {row.summary}
      </p>
    </section>
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
