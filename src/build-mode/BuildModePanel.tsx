/**
 * Build mode: type what you want changed about the world you are standing in.
 *
 * A prompt goes to `vibe-build`, which dispatches a Claude Code agent in
 * GitHub Actions. The agent may only touch this world's files, and the change
 * lands on main only after typecheck and build pass. With "Ship to main" off
 * it waits on its branch for a press of Ship it instead.
 *
 * Fast is Sonnet with a short leash; Smart is Opus with room to read around
 * and check its work. Both go through the same fence and the same checks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";

import {
  BUILD_SCOPES,
  LIVE_STATUSES,
  buildStatus,
  createBuild,
  discardBuild,
  cancelBuild,
  listBuilds,
  retryBuild,
  undoBuild,
  shipBuild,
  type Build,
  type BuildBilling,
  type BuildMode,
  type BuildScope,
} from "./api";
import { dictationSupported, say, useDictation } from "./voice";
import WhatsNewList from "@/whatsnew/WhatsNewList";
import { WHATS_NEW, markAllSeen } from "@/whatsnew";

const STATUS_LABEL: Record<Build["status"], string> = {
  queued: "Queued",
  running: "Building",
  shipped: "Live on main",
  ready: "Waiting to ship",
  failed: "Failed",
  nochange: "No change",
  discarded: "Thrown away",
};

const STATUS_TONE: Record<Build["status"], string> = {
  queued: "bg-white/10 text-white/70",
  running: "bg-amber-400/20 text-amber-200",
  shipped: "bg-emerald-400/20 text-emerald-200",
  ready: "bg-sky-400/20 text-sky-200",
  failed: "bg-rose-400/20 text-rose-200",
  nochange: "bg-white/10 text-white/60",
  discarded: "bg-white/5 text-white/40",
};

const MODE_KEY = "vibe.buildMode.mode";
const SHIP_KEY = "vibe.buildMode.ship";
const BILLING_KEY = "vibe.buildMode.billing";
const LAYOUT_KEY = "vibe.buildMode.layout";
const TAB_KEY = "vibe.buildMode.tab";
/** What's New entries already shown inside build mode, by id. */
const NEWS_KEY = "vibe.buildMode.newsSeen";

type PanelTab = "history" | "news";

/**
 * What's New entries this device has not seen in build mode yet. Kept apart
 * from the site-wide badge, so reading the changelog on the front page does
 * not hide what changed from the panel. A first ever open counts the latest
 * day only, not the whole back catalogue.
 */
function freshNews(): Set<string> {
  let seen: Set<string> | null = null;
  try {
    const raw = localStorage.getItem(NEWS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) seen = new Set(v.map(String));
  } catch {
    /* treat as a first visit */
  }
  if (!seen) {
    const latest = WHATS_NEW[0]?.date;
    return new Set(WHATS_NEW.filter((e) => e.date === latest).map((e) => e.id));
  }
  return new Set(WHATS_NEW.filter((e) => !seen!.has(e.id)).map((e) => e.id));
}

/** Width of the docked sidebar; the world shrinks by exactly this. */
const DOCK_W = 380;
/** Below this the world would be too narrow to play beside a sidebar. */
const DOCK_MIN_VIEWPORT = 820;

export type BuildLayout = "dock" | "mini";

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference, not state */
  }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Keys typed into the panel must not walk, jump or fire in the world. */
const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

export default function BuildModePanel({
  scope,
  onClose,
}: {
  scope: BuildScope;
  onClose: () => void;
}) {
  const location = useLocation();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<BuildMode>(() =>
    readPref(MODE_KEY, "fast") === "smart" ? "smart" : "fast",
  );
  const [ship, setShip] = useState(() => readPref(SHIP_KEY, "true") !== "false");
  const [billing, setBilling] = useState<BuildBilling>(() =>
    readPref(BILLING_KEY, "api") === "plan" ? "plan" : "api",
  );
  const [layout, setLayoutState] = useState<BuildLayout>(() =>
    readPref(LAYOUT_KEY, "dock") === "mini" ? "mini" : "dock",
  );
  const setLayout = (l: BuildLayout) => {
    setLayoutState(l);
    writePref(LAYOUT_KEY, l);
  };
  /**
   * The lower half of the sidebar: your builds, or What's New. It opens on
   * What's New whenever something has shipped since you were last in here,
   * and on whichever you left it on otherwise.
   */
  const [news] = useState(freshNews);
  const [tab, setTabState] = useState<PanelTab>(() =>
    news.size > 0 ? "news" : readPref(TAB_KEY, "history") === "news" ? "news" : "history",
  );
  const setTab = (t: PanelTab) => {
    setTabState(t);
    writePref(TAB_KEY, t);
  };
  const [newsRead, setNewsRead] = useState(false);
  useEffect(() => {
    if (tab !== "news" || layout !== "dock") return;
    writePref(NEWS_KEY, JSON.stringify(WHATS_NEW.map((e) => e.id)));
    markAllSeen();
    setNewsRead(true);
  }, [tab, layout]);
  const unreadNews = newsRead ? 0 : news.size;
  const [wide, setWide] = useState(() => window.innerWidth >= DOCK_MIN_VIEWPORT);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= DOCK_MIN_VIEWPORT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  /**
   * Docked, the page itself gets narrower instead of being covered. The class
   * on <html> pins #root to the left of the sidebar, and its transform makes
   * #root the containing block for every `position: fixed` inside it, so a
   * world's HUD and canvas all land in the narrower box without any world
   * knowing build mode exists. Canvases resize through their own observers.
   * On a phone there is no room for both, so the sidebar overlays as before.
   */
  const docked = layout === "dock" && wide;
  useEffect(() => {
    if (!docked) return;
    const html = document.documentElement;
    html.style.setProperty("--vb-dock", `${DOCK_W}px`);
    html.classList.add("vb-docked");
    window.dispatchEvent(new Event("resize"));
    return () => {
      html.classList.remove("vb-docked");
      window.dispatchEvent(new Event("resize"));
    };
  }, [docked]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shippedSinceOpen, setShippedSinceOpen] = useState(false);
  const seenShipped = useRef<Set<string> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** Seconds left before a spoken request sends itself; null when idle. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const spoken = useRef<string | null>(null);
  const usedVoice = useRef(false);
  const canListen = dictationSupported();

  /** How much history is on screen; Show more raises it. */
  const [shown, setShown] = useState(20);
  const [total, setTotal] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { builds, total } = await listBuilds(shown);
      setBuilds(builds);
      setTotal(total);
      const shipped = new Set(builds.filter((b) => b.status === "shipped").map((b) => b.id));
      if (seenShipped.current === null) seenShipped.current = shipped;
      else if ([...shipped].some((id) => !seenShipped.current!.has(id))) {
        setShippedSinceOpen(true);
        if (usedVoice.current) say("Your change is live. Reload to see it.");
      }
      seenShipped.current = new Set([...(seenShipped.current ?? []), ...shipped]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [shown]);

  useEffect(() => {
    buildStatus()
      .then((s) => setConfigured(s.configured))
      .catch((e) => setError((e as Error).message));
    void refresh();
    textRef.current?.focus();
  }, [refresh]);

  const anyLive = builds.some((b) => LIVE_STATUSES.includes(b.status));
  useEffect(() => {
    const t = window.setInterval(() => void refresh(), anyLive ? 8000 : 30000);
    return () => window.clearInterval(t);
  }, [anyLive, refresh]);

  const send = async (override?: string) => {
    const text = (override ?? prompt).trim();
    if (text.length < 3 || sending) return;
    setSending(true);
    setError(null);
    try {
      const { build } = await createBuild({
        prompt: text,
        mode,
        ship,
        billing,
        scope,
        route: location.pathname + location.search,
      });
      setBuilds((bs) => [build, ...bs]);
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const dictation = useDictation((text) => {
    usedVoice.current = true;
    spoken.current = text;
    setPrompt(text);
    say(`Got it. ${text}. Building it now.`);
    setCountdown(4);
  });

  // While you talk, the box shows what it has heard so far.
  useEffect(() => {
    if (dictation.listening && dictation.interim) setPrompt(dictation.interim);
  }, [dictation.listening, dictation.interim]);

  // A spoken request sends itself after a short beat, so you can still say no.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      const text = spoken.current;
      spoken.current = null;
      if (text) void send(text);
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  const cancelSpoken = () => {
    setCountdown(null);
    spoken.current = null;
    say("Okay, not building that.");
  };

  const act = async (b: Build, what: "ship" | "discard" | "cancel" | "retry" | "undo") => {
    if (what === "undo" && !window.confirm(`Undo "${b.prompt.slice(0, 80)}"? This ships a revert to main.`)) return;
    if (what === "cancel" && !window.confirm("Stop this build?")) return;
    setBusyId(b.id);
    setError(null);
    try {
      if (what === "retry" || what === "undo") {
        const { build } = what === "retry" ? await retryBuild(b.id, billing) : await undoBuild(b.id);
        setBuilds((bs) => [build, ...bs]);
        return;
      }
      const run = { ship: shipBuild, discard: discardBuild, cancel: cancelBuild }[what];
      const { build } = await run(b.id);
      setBuilds((bs) => bs.map((x) => (x.id === build.id ? build : x)));
      if (what === "ship") setShippedSinceOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const swallowAll = {
    onKeyDown: swallow,
    onKeyUp: swallow,
    onKeyPress: swallow,
    onPointerDown: swallow,
    onMouseDown: swallow,
    onClick: swallow,
    onWheel: swallow,
  };

  const promptBox = (rows: number) => (
    <>
      <div className="relative">
        <textarea
          ref={textRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || layout === "mini") && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape") onClose();
          }}
          rows={rows}
          maxLength={4000}
          placeholder={
            layout === "mini"
              ? "What should change here?"
              : "Make the zipline twice as fast, and put a lighthouse on the east edge."
          }
          className="w-full resize-none rounded-md border border-white/15 bg-black/40 px-3 py-2 pr-11 text-sm text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
        />
        {canListen && (
          <button
            type="button"
            onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
            aria-label={dictation.listening ? "Stop listening" : "Say what to build"}
            title={dictation.listening ? "Stop listening" : "Say what to build"}
            className={`absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full text-sm ${
              dictation.listening ? "animate-pulse bg-rose-500 text-white" : "bg-white/10 text-white/80 hover:bg-white/20"
            }`}
          >
            🎙️
          </button>
        )}
      </div>
      {dictation.listening && <div className="text-[11px] text-rose-200">Listening. Say what you want to change.</div>}
      {dictation.error && <div className="text-[11px] text-amber-200">{dictation.error}</div>}
      {countdown !== null && (
        <div className="flex items-center justify-between rounded-md bg-white/10 px-3 py-2 text-xs">
          <span>Building this in {countdown}…</span>
          <button type="button" onClick={cancelSpoken} className="font-semibold underline">
            Cancel
          </button>
        </div>
      )}
    </>
  );

  const speed = (
    <div className="flex rounded-md border border-white/15 p-0.5 text-xs" role="radiogroup" aria-label="Speed">
      {(["fast", "smart"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => {
            setMode(m);
            writePref(MODE_KEY, m);
          }}
          title={m === "fast" ? "Sonnet: quick and cheap, a few minutes" : "Opus: reads more, checks more, slower"}
          className={`rounded ${layout === "mini" ? "px-2" : "px-3"} py-1 ${mode === m ? "bg-white text-black" : "text-white/70 hover:text-white"}`}
        >
          {m === "fast" ? "⚡ Fast" : "🧠 Smart"}
        </button>
      ))}
    </div>
  );

  const notes = (
    <>
      {error && <div className="rounded-md bg-rose-500/15 px-3 py-2 text-xs text-rose-100">{error}</div>}
      {shippedSinceOpen && (
        <div className="flex items-center justify-between rounded-md bg-emerald-400/15 px-3 py-2 text-xs text-emerald-100">
          <span>A change landed. The deploy takes a minute or two.</span>
          <button type="button" onClick={() => window.location.reload()} className="font-semibold underline">
            Reload
          </button>
        </div>
      )}
    </>
  );

  const chip = (b: Build) => (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[b.status]}`}>
      {b.status === "running" ? "● " : ""}
      {STATUS_LABEL[b.status] ?? b.status}
    </span>
  );

  const layoutButtons = (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setLayout(layout === "dock" ? "mini" : "dock")}
        className="rounded-md px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
        title={layout === "dock" ? "Shrink to a small widget" : "Open as a sidebar beside the world"}
        aria-label={layout === "dock" ? "Shrink to a small widget" : "Open as a sidebar"}
      >
        {layout === "dock" ? "▭ Mini" : "◧ Sidebar"}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
        aria-label="Close build mode"
      >
        ✕
      </button>
    </div>
  );

  if (layout === "mini") {
    // The widget: one line of prompt, the speed, a send button, and how the
    // latest build is doing. Everything else is one tap away in the sidebar.
    const latest = builds.find((b) => LIVE_STATUSES.includes(b.status)) ?? builds[0];
    return createPortal(
      <div
        className="fixed bottom-4 right-4 z-[9999] w-[min(320px,calc(100vw-2rem))] space-y-2 rounded-xl border border-white/10 bg-[#0b0d18]/90 p-3 text-white shadow-2xl backdrop-blur"
        {...swallowAll}
        role="dialog"
        aria-label="Build mode"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-white/80">
            ✦ Build <span className="font-normal text-white/40">· {BUILD_SCOPES[scope].name}</span>
          </div>
          {layoutButtons}
        </div>
        {configured === false && (
          <div className="rounded-md bg-amber-400/15 px-2 py-1.5 text-[11px] text-amber-100">Not switched on yet.</div>
        )}
        {promptBox(2)}
        <div className="flex items-center gap-2">
          {speed}
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || prompt.trim().length < 3}
            className="flex-1 rounded-md bg-white py-1.5 text-xs font-semibold text-black disabled:opacity-40"
            title={ship ? "Lands on main once typecheck and build pass" : "Waits on its branch for Ship it"}
          >
            {sending ? "Sending…" : ship ? "Build & ship" : "Build"}
          </button>
        </div>
        {notes}
        {unreadNews > 0 && (
          <button
            type="button"
            onClick={() => {
              setTab("news");
              setLayout("dock");
            }}
            className="flex w-full items-center gap-2 rounded-md bg-amber-300/10 px-2 py-1.5 text-left text-[11px] text-amber-100 hover:bg-amber-300/15"
          >
            <span aria-hidden>✨</span>
            <span className="flex-1">{unreadNews} new since you were last here</span>
            <span className="text-amber-100/60">See</span>
          </button>
        )}
        {latest && (
          <button
            type="button"
            onClick={() => {
              setTab("history");
              setLayout("dock");
            }}
            className="flex w-full items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1.5 text-left hover:bg-white/[0.08]"
            title="Open the full history"
          >
            {chip(latest)}
            <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">
              {latest.status === "running" || latest.status === "queued"
                ? `${latest.step ?? (latest.status === "queued" ? "Waiting its turn" : "Starting")}…`
                : latest.prompt}
            </span>
            {total > 1 && <span className="shrink-0 text-[10px] text-white/35">{total}</span>}
          </button>
        )}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className={`fixed right-0 top-0 z-[9999] flex h-full w-full flex-col border-l border-white/10 bg-[#0b0d18] text-white ${
        docked ? "" : "max-w-[380px] bg-[#0b0d18]/95 shadow-2xl backdrop-blur"
      }`}
      style={docked ? { width: DOCK_W } : undefined}
      {...swallowAll}
      role={docked ? "complementary" : "dialog"}
      aria-label="Build mode"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-sm font-semibold">✦ Build mode</div>
          <div className="text-xs text-white/50">Changes {BUILD_SCOPES[scope].name} only</div>
        </div>
        {layoutButtons}
      </div>

      <div className="space-y-3 border-b border-white/10 px-4 py-4">
        {configured === false && (
          <div className="rounded-md bg-amber-400/15 px-3 py-2 text-xs text-amber-100">
            Not switched on yet: the GitHub token for build mode has not been added.
          </div>
        )}
        {promptBox(4)}

        <div className="flex items-center justify-between gap-2">
          {speed}
          <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
            <input
              type="checkbox"
              checked={ship}
              onChange={(e) => {
                setShip(e.target.checked);
                writePref(SHIP_KEY, String(e.target.checked));
              }}
              className="accent-emerald-400"
            />
            Ship to main
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-white/50">Pays with</span>
          <div className="flex rounded-md border border-white/15 p-0.5" role="radiogroup" aria-label="Pays with">
            {(["api", "plan"] as const).map((b) => (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={billing === b}
                onClick={() => {
                  setBilling(b);
                  writePref(BILLING_KEY, b);
                }}
                title={b === "api" ? "Anthropic console credits (ANTHROPIC_API_KEY)" : "Your Claude plan (CLAUDE_CODE_OAUTH_TOKEN)"}
                className={`rounded px-3 py-1 ${billing === b ? "bg-white text-black" : "text-white/70 hover:text-white"}`}
              >
                {b === "api" ? "💳 API credits" : "✳️ Claude plan"}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || prompt.trim().length < 3}
          className="w-full rounded-md bg-white py-2 text-sm font-semibold text-black disabled:opacity-40"
        >
          {sending ? "Sending…" : ship ? "Build and ship" : "Build on a branch"}
        </button>
        <p className="text-[11px] leading-snug text-white/40">
          {ship
            ? "Lands on main once typecheck and build pass, then the site redeploys."
            : "Waits on its own branch until you press Ship it."}{" "}
          {canListen ? "Tap the mic and just say it, or Ctrl/Cmd+Enter to send." : "Ctrl/Cmd+Enter sends."}
        </p>
        {notes}
      </div>

      <div className="flex gap-1 border-b border-white/10 px-4 pt-2" role="tablist" aria-label="Build mode views">
        {(
          [
            ["history", "History", total > 0 ? String(total) : ""],
            ["news", "✨ What's New", ""],
          ] as const
        ).map(([t, label, count]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-xs ${
              tab === t ? "border-white font-semibold text-white" : "border-transparent text-white/50 hover:text-white/80"
            }`}
          >
            {label}
            {count && <span className="text-[10px] font-normal text-white/35">{count}</span>}
            {t === "history" && anyLive && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" aria-label="A build is running" />
            )}
            {t === "news" && unreadNews > 0 && (
              <span className="rounded-full bg-amber-300 px-1.5 text-[10px] font-bold leading-4 text-black">{unreadNews}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "news" ? (
        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3" role="tabpanel">
          <WhatsNewList compact fresh={news} onNavigate={onClose} />
        </div>
      ) : (
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3" role="tabpanel">
        {builds.length === 0 && <div className="text-xs text-white/40">Nothing built yet.</div>}
        {builds.map((b) => (
          <div key={b.id} className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              {chip(b)}
              <span className="text-[10px] text-white/40">
                {b.mode === "smart" ? "🧠" : "⚡"} {ago(b.created_at)}
                {b.requester_name ? ` · ${b.requester_name}` : ""}
              </span>
            </div>
            <div className="text-xs text-white/85">{b.prompt}</div>
            {(b.status === "running" || b.status === "queued") && (
              <div className="mt-1 text-[11px] text-amber-200/80">
                {b.step ?? (b.status === "queued" ? "Waiting its turn" : "Starting")}…
              </div>
            )}
            {b.summary && b.status !== "queued" && b.status !== "running" && (
              <div className="mt-1.5 whitespace-pre-line text-[11px] leading-snug text-white/55">{b.summary}</div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
              {b.run_url && (
                <a href={b.run_url} target="_blank" rel="noreferrer" className="text-white/50 underline hover:text-white">
                  Run log
                </a>
              )}
              {b.head_sha && (
                <a
                  href={`https://github.com/jackmielke/vibe-verse/commit/${b.head_sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/50 underline hover:text-white"
                >
                  The change
                </a>
              )}
              {b.status === "ready" && (
                <>
                  <button
                    type="button"
                    disabled={busyId === b.id}
                    onClick={() => void act(b, "ship")}
                    className="rounded bg-emerald-400 px-2 py-0.5 font-semibold text-black disabled:opacity-40"
                  >
                    Ship it
                  </button>
                  <button
                    type="button"
                    disabled={busyId === b.id}
                    onClick={() => void act(b, "discard")}
                    className="text-white/50 underline hover:text-white disabled:opacity-40"
                  >
                    Throw away
                  </button>
                </>
              )}
              {(b.status === "running" || b.status === "queued") && (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => void act(b, "cancel")}
                  className="text-rose-200/80 underline hover:text-rose-100 disabled:opacity-40"
                >
                  Stop
                </button>
              )}
              {b.status === "shipped" && b.head_sha && !b.prompt.startsWith("Undo:") && (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => void act(b, "undo")}
                  className="text-white/50 underline hover:text-white disabled:opacity-40"
                >
                  Undo
                </button>
              )}
              {b.status !== "running" && b.status !== "queued" && !b.prompt.startsWith("Undo:") && (
                <>
                  <button
                    type="button"
                    disabled={busyId === b.id}
                    onClick={() => void act(b, "retry")}
                    className="text-white/50 underline hover:text-white disabled:opacity-40"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPrompt(b.prompt);
                      textRef.current?.focus();
                    }}
                    className="text-white/50 underline hover:text-white"
                  >
                    Edit
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {total > builds.length && (
          <button
            type="button"
            onClick={() => setShown((n) => n + 20)}
            className="w-full rounded-md border border-white/10 py-2 text-xs text-white/60 hover:bg-white/5"
          >
            Show more ({total - builds.length} older)
          </button>
        )}
      </div>
      )}
    </div>,
    document.body,
  );
}
