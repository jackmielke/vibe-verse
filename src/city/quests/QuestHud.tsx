/**
 * The side quests' HUD: the E prompt, the dialog box, the hot-and-cold
 * tracker, the fishing reel, and the 📜 Quests menu (quest log, the hats
 * Granny gave you, the fish journal, "take me there").
 *
 * Like the landmarks' HUD it polls the quests itself, eight times a second,
 * and portals to <body> so `position: fixed` means the screen.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { QuestUi, Quests } from "./index";

const EMPTY: QuestUi = { prompt: null, dialog: null, tracker: null, fishing: null, hold: false };

export function QuestHud({
  system,
  compact,
  onWarp,
  onWearHat,
}: {
  system: MutableRefObject<Quests | null>;
  compact?: boolean;
  onWarp(at: [number, number, number]): void;
  onWearHat(id: string | null): void;
}) {
  const [ui, setUi] = useState<QuestUi>(EMPTY);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const last = useRef("");
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = system.current?.ui() ?? EMPTY;
      const key = JSON.stringify({
        ...next,
        tracker: next.tracker ? { ...next.tracker, arrow: next.tracker.arrow != null ? Math.round(next.tracker.arrow * 20) : null } : null,
        fishing: next.fishing?.reel
          ? { r: [Math.round(next.fishing.reel.zone * 100), Math.round(next.fishing.reel.fish * 100), Math.round(next.fishing.reel.progress * 100)] }
          : next.fishing,
      });
      if (key !== last.current) {
        last.current = key;
        setUi(next);
      }
    }, 60);
    return () => window.clearInterval(id);
  }, [system]);

  // The reel wants smoother updates than 8 Hz; the interval above runs at ~16 Hz.
  const q = system.current;
  const log = open && q ? q.log() : null;
  const hold = (on: boolean) => system.current?.setHold(on);

  return createPortal(
    <>
      {/* The quests menu button. */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`fixed z-30 rounded-full border border-amber-300/40 bg-black/60 px-3 py-1.5 text-xs font-semibold text-amber-100 shadow-lg backdrop-blur hover:bg-black/75 ${
          compact ? "left-2 top-[7.5rem]" : "left-3 top-[9.5rem]"
        }`}
        data-testid="quests-button"
      >
        📜 Quests
      </button>

      {open && log && (
        <div
          className={`fixed z-40 max-h-[70vh] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-amber-200/25 bg-zinc-950/90 p-4 text-sm text-white shadow-2xl backdrop-blur ${
            compact ? "left-2 top-[10rem]" : "left-3 top-[12rem]"
          }`}
          data-testid="quests-panel"
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-bold text-amber-200">Side quests</h3>
            <button onClick={() => setOpen(false)} className="rounded-full px-2 text-white/60 hover:text-white" aria-label="Close">
              ✕
            </button>
          </div>
          <ul className="space-y-3">
            {log.quests.map((e) => (
              <li key={e.title} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="font-semibold">{e.title}</div>
                <div className="mt-0.5 text-xs text-white/70">{e.status}</div>
                {e.extra && e.extra.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-white/60">
                    {e.extra.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                <button
                  onClick={() => {
                    onWarp(e.at);
                    setOpen(false);
                  }}
                  className="mt-2 rounded-full bg-amber-300/90 px-3 py-1 text-xs font-semibold text-black hover:bg-amber-200"
                >
                  📍 Take me there
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Hats you've earned</div>
            <div className="flex flex-wrap gap-2">
              {log.hats.map((h) => (
                <button
                  key={h.id}
                  disabled={!h.earned}
                  onClick={() => {
                    onWearHat(log.worn === h.id ? null : h.id);
                    setTick((n) => n + 1);
                  }}
                  title={h.earned ? (log.worn === h.id ? "Take it off" : "Wear it") : "Bring Granny's pets home to earn this"}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    !h.earned
                      ? "border-white/10 text-white/30"
                      : log.worn === h.id
                        ? "border-amber-300 bg-amber-300/20 text-amber-100"
                        : "border-white/25 text-white hover:bg-white/10"
                  }`}
                >
                  {h.earned ? h.emoji : "🔒"} {h.name}
                  {log.worn === h.id ? " ✓" : ""}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {ui.tracker && (
        <div
          className={`pointer-events-none fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-amber-200/25 bg-black/60 px-4 py-2 text-white backdrop-blur ${
            compact ? "top-28" : "top-32"
          }`}
          data-testid="quest-tracker"
        >
          {ui.tracker.arrow != null && (
            <span className="inline-block text-lg text-amber-300" style={{ transform: `rotate(${(-ui.tracker.arrow * 180) / Math.PI}deg)` }}>
              ⬆
            </span>
          )}
          <div className="leading-tight">
            <div className="text-sm font-semibold">
              {ui.tracker.emoji} {ui.tracker.text}
            </div>
            {ui.tracker.sub && <div className="text-xs text-white/65">{ui.tracker.sub}</div>}
          </div>
        </div>
      )}

      {ui.dialog && (
        <div
          className={`fixed left-1/2 z-40 w-[34rem] max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-2xl border border-amber-200/30 bg-zinc-950/88 p-4 text-white shadow-2xl backdrop-blur ${
            compact ? "bottom-[17rem]" : "bottom-28"
          }`}
          data-testid="quest-dialog"
        >
          <div className="mb-1 text-sm font-bold text-amber-200">
            {ui.dialog.emoji} {ui.dialog.speaker}
          </div>
          <p className="text-sm leading-relaxed text-white/90">{ui.dialog.text}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ui.dialog.options.map((o, i) => (
              <button
                key={o.id}
                disabled={!!o.disabled}
                title={o.disabled}
                onClick={(e) => {
                  system.current?.choose(o.id);
                  e.currentTarget.blur();
                }}
                className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                  o.disabled
                    ? "cursor-not-allowed bg-white/5 text-white/30"
                    : i === 0
                      ? "bg-amber-300 text-black hover:bg-amber-200"
                      : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                {o.label}
                {i === 0 && !compact && !o.disabled && <span className="ml-2 rounded bg-black/15 px-1 font-mono text-[10px]">E</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {ui.fishing?.reel && <Reel reel={ui.fishing.reel} compact={compact} />}
      {ui.fishing?.caught && (
        <div className="pointer-events-none fixed left-1/2 top-1/3 z-30 -translate-x-1/2 rounded-2xl border border-amber-200/40 bg-black/70 px-6 py-3 text-center text-white backdrop-blur">
          <div className="text-3xl">{ui.fishing.caught.emoji}</div>
          <div className="font-bold">{ui.fishing.caught.name}</div>
          <div className="text-xs text-white/70">
            {ui.fishing.caught.kg} kg{ui.fishing.caught.best ? " · personal best!" : ""}
            {ui.fishing.caught.coins > 0 ? ` · +${ui.fishing.caught.coins} ✦` : ""}
          </div>
        </div>
      )}
      {ui.fishing?.phase === "wait" && (
        <div className="pointer-events-none fixed left-1/2 top-1/3 z-30 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 text-sm text-white/80 backdrop-blur">
          Watch the float…
        </div>
      )}

      {ui.hold && (
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            hold(true);
          }}
          onPointerUp={() => hold(false)}
          onPointerLeave={() => hold(false)}
          onPointerCancel={() => hold(false)}
          className={`fixed z-40 select-none rounded-full border-2 border-emerald-300 bg-emerald-500/80 font-bold text-white shadow-xl active:bg-emerald-400 ${
            compact ? "bottom-40 right-6 h-24 w-24 text-base" : "bottom-24 right-10 h-20 w-20 text-sm"
          }`}
          style={{ touchAction: "none" }}
          data-testid="quest-hold"
        >
          HOLD
          {!compact && <div className="text-[10px] font-normal">or hold E</div>}
        </button>
      )}

      {ui.prompt && (
        <button
          onClick={(e) => {
            system.current?.act();
            e.currentTarget.blur();
          }}
          className={`fixed left-1/2 z-40 -translate-x-1/2 rounded-full border border-amber-300/50 bg-black/70 px-5 py-2.5 text-sm font-medium text-white shadow-lg backdrop-blur transition hover:bg-black/85 ${
            compact ? "bottom-[22rem]" : "bottom-40"
          }`}
          data-testid="quest-prompt"
        >
          {ui.prompt.emoji} {ui.prompt.label}
          {!compact && <span className="ml-2 rounded bg-white/15 px-1.5 py-0.5 font-mono text-xs text-amber-200">E</span>}
        </button>
      )}
    </>,
    document.body,
  );
}

function Reel({ reel, compact }: { reel: NonNullable<NonNullable<QuestUi["fishing"]>["reel"]>; compact?: boolean }) {
  const H = compact ? 220 : 280;
  return (
    <div className={`pointer-events-none fixed top-1/2 z-30 flex -translate-y-1/2 items-end gap-2 ${compact ? "right-4" : "right-[22%]"}`} data-testid="quest-reel">
      <div className="relative w-10 overflow-hidden rounded-xl border-2 border-white/40 bg-sky-950/80" style={{ height: H }}>
        <div
          className="absolute left-0 right-0 rounded-md border border-emerald-200 bg-emerald-400/60"
          style={{ bottom: `${reel.zone * 100}%`, height: `${reel.zoneSize * 100}%` }}
        />
        <div className="absolute left-1/2 -translate-x-1/2 text-xl" style={{ bottom: `calc(${reel.fish * 100}% - 12px)` }}>
          {reel.golden ? "✨" : "🐟"}
        </div>
      </div>
      <div className="relative w-2.5 overflow-hidden rounded-full bg-white/15" style={{ height: H }}>
        <div className="absolute bottom-0 left-0 right-0 rounded-full bg-amber-300" style={{ height: `${Math.max(0, Math.min(1, reel.progress)) * 100}%` }} />
      </div>
    </div>
  );
}
