/**
 * "You played Cannon Chase. How was it?" Three rows of five, once per world.
 *
 * Never shown inside a world: it waits until the player is back on one of the
 * app's own pages (the front door, usually), because a card over a crosshair
 * is a card that gets you killed. `PlayTracker` marks a world as pending after
 * two minutes of active play; this shows it, sends the scores, and forgets.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { worldByKey } from "@/worlds/registry";
import {
  PENDING_KEY,
  hasRated,
  ratingSnoozed,
  sendRating,
  snoozeRating,
  worldForLocation,
  type Rating,
} from "@/lib/worldStats";

export const CRITERIA: { key: keyof Rating; label: string; hint: string }[] = [
  { key: "lore", label: "Lore", hint: "Is there a story or a world worth knowing?" },
  { key: "fun", label: "Fun", hint: "Did you want to keep playing?" },
  { key: "smooth", label: "Smooth", hint: "Did it run without stutters?" },
];

export function RatingRows({ value, onChange }: { value: Rating; onChange: (r: Rating) => void }) {
  return (
    <div className="space-y-2">
      {CRITERIA.map((c) => (
        <div key={c.key} className="flex items-center justify-between gap-3" title={c.hint}>
          <span className="w-16 text-sm text-white/80">{c.label}</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => {
              const on = (value[c.key] ?? 0) >= n;
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={`${c.label} ${n} of 5`}
                  onClick={() => onChange({ ...value, [c.key]: n })}
                  className={`h-7 w-7 rounded-full border text-xs transition ${
                    on ? "border-amber-300 bg-amber-300 text-black" : "border-white/25 text-white/50 hover:border-white/60"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RatePrompt() {
  const { pathname, search } = useLocation();
  const [worldKey, setWorldKey] = useState<string | null>(null);
  const [value, setValue] = useState<Rating>({});
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (worldForLocation(pathname, search) || pathname.startsWith("/auth/")) {
      setWorldKey(null);
      return;
    }
    let k: string | null = null;
    try {
      k = localStorage.getItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    if (k && worldByKey(k) && !hasRated(k) && !ratingSnoozed(k)) {
      setWorldKey(k);
      setValue({});
      setSent(false);
    } else setWorldKey(null);
  }, [pathname, search]);

  if (!worldKey) return null;
  const world = worldByKey(worldKey);
  if (!world) return null;

  const close = () => {
    if (!sent) snoozeRating(worldKey);
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    setWorldKey(null);
  };

  const any = value.lore || value.fun || value.smooth;

  return (
    <div className="fixed bottom-4 left-4 z-[60] w-[min(320px,calc(100vw-32px))] rounded-2xl border border-white/15 bg-[#0d0f1c]/95 p-4 text-white shadow-2xl backdrop-blur">
      <button onClick={close} aria-label="Not now" className="absolute right-3 top-3 text-white/50 hover:text-white">
        <X size={16} />
      </button>
      {sent ? (
        <div className="py-2 pr-6 text-sm">
          Thanks. Your scores went into the totals for {world.emoji} {world.name}, with nothing attached to you.
        </div>
      ) : (
        <>
          <div className="mb-1 pr-6 text-sm font-semibold">
            How was {world.emoji} {world.name}?
          </div>
          <div className="mb-3 text-xs text-white/50">Anonymous. Tap a number for any of the three.</div>
          <RatingRows value={value} onChange={setValue} />
          <div className="mt-4 flex justify-between">
            <button onClick={close} className="text-xs text-white/50 hover:text-white">
              Not now
            </button>
            <button
              disabled={!any}
              onClick={async () => {
                await sendRating(worldKey, value);
                setSent(true);
                setTimeout(() => setWorldKey(null), 2500);
              }}
              className="rounded-full bg-amber-300 px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-30"
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
