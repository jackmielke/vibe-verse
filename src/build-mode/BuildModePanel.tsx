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

  return (
    <div
      className="fixed right-0 top-0 z-[9999] flex h-full w-full max-w-[380px] flex-col border-l border-white/10 bg-[#0b0d18]/95 text-white shadow-2xl backdrop-blur"
      onKeyDown={swallow}
      onKeyUp={swallow}
      onKeyPress={swallow}
      onPointerDown={swallow}
      onMouseDown={swallow}
      onClick={swallow}
      onWheel={swallow}
      role="dialog"
      aria-label="Build mode"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-sm font-semibold">✦ Build mode</div>
          <div className="text-xs text-white/50">Changes {BUILD_SCOPES[scope].name} only</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
          aria-label="Close build mode"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3 border-b border-white/10 px-4 py-4">
        {configured === false && (
          <div className="rounded-md bg-amber-400/15 px-3 py-2 text-xs text-amber-100">
            Not switched on yet: the GitHub token for build mode has not been added.
          </div>
        )}
        <div className="relative">
        <textarea
          ref={textRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape") onClose();
          }}
          rows={4}
          maxLength={4000}
          placeholder="Make the zipline twice as fast, and put a lighthouse on the east edge."
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
        {dictation.listening && <div className="text-[11px] text-rose-200">Listening. Say what you want on the island.</div>}
        {dictation.error && <div className="text-[11px] text-amber-200">{dictation.error}</div>}
        {countdown !== null && (
          <div className="flex items-center justify-between rounded-md bg-white/10 px-3 py-2 text-xs">
            <span>Building this in {countdown}…</span>
            <button type="button" onClick={cancelSpoken} className="font-semibold underline">
              Cancel
            </button>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
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
                className={`rounded px-3 py-1 ${mode === m ? "bg-white text-black" : "text-white/70 hover:text-white"}`}
              >
                {m === "fast" ? "⚡ Fast" : "🧠 Smart"}
              </button>
            ))}
          </div>
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
        {error && <div className="rounded-md bg-rose-500/15 px-3 py-2 text-xs text-rose-100">{error}</div>}
        {shippedSinceOpen && (
          <div className="flex items-center justify-between rounded-md bg-emerald-400/15 px-3 py-2 text-xs text-emerald-100">
            <span>A change landed. The deploy takes a minute or two.</span>
            <button type="button" onClick={() => window.location.reload()} className="font-semibold underline">
              Reload
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {total > 0 && <div className="text-[10px] uppercase tracking-wide text-white/35">History · {total} builds</div>}
        {builds.length === 0 && <div className="text-xs text-white/40">Nothing built yet.</div>}
        {builds.map((b) => (
          <div key={b.id} className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[b.status]}`}>
                {b.status === "running" ? "● " : ""}
                {STATUS_LABEL[b.status] ?? b.status}
              </span>
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
    </div>
  );
}
