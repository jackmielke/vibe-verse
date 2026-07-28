/**
 * /worlds — the shooter picker.
 *
 * The Vibeverse hub (`/`) is a 3D lobby; this is the flat, fast, thumb-first
 * front door to the big worlds. It has to load instantly on a phone on a bad
 * connection, so there is deliberately no 3D here — just images, type, and one
 * very large tap target per world.
 *
 * Honesty rule for this screen: the status chip tells you what a world
 * actually is right now. A world that renders beautifully but has no player
 * controller says so, because the worst possible outcome is someone tapping
 * "drop in" expecting a shooter and getting a static view with no explanation.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import sanFranciscoArt from "@/assets/worlds/san-francisco.jpg";

type WorldStatus = "playable" | "sandbox" | "soon";

interface WorldEntry {
  key: string;
  to: string;
  name: string;
  /** The line under the name — what the place *is*. */
  tagline: string;
  /**
   * In-game capture. Optional on purpose: a world whose automated capture only
   * produces a broken frame gets a designed panel instead, because misleading
   * card art is worse than no card art.
   */
  art?: string;
  /** Signal colour for this world's chrome. */
  accent: string;
  status: WorldStatus;
  /** What you can actually do right now. Shown verbatim; keep it true. */
  statusDetail: string;
  tags: string[];
}

const WORLDS: WorldEntry[] = [
  {
    key: "san-palmas",
    to: "/san-palmas",
    name: "San Palmas",
    tagline: "Tropical San Francisco. Guns, sun, and a very long draw distance.",
    accent: "#ffb020",
    status: "playable",
    statusDetail: "Playable — move, look and shoot",
    tags: ["FPS", "Open world", "Weapons", "Post-FX"],
  },
  {
    key: "san-francisco",
    to: "/sf",
    name: "San Francisco",
    tagline: "FREE FALL — the real city, hill for hill, bridge for bridge.",
    art: sanFranciscoArt,
    accent: "#ff6a2b",
    status: "sandbox",
    statusDetail: "Sandbox — fly the city; no weapons yet",
    tags: ["Real geometry", "22 landmarks", "Grapple + wingsuit soon"],
  },
];

const STATUS_STYLE: Record<WorldStatus, { label: string; className: string }> = {
  playable: {
    label: "Playable",
    className: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
  },
  sandbox: {
    label: "Sandbox",
    className: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  },
  soon: {
    label: "Soon",
    className: "bg-white/10 text-white/60 ring-white/20",
  },
};

/** Coarse pointer + small viewport ⇒ show the touch-specific copy. */
function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(hover: none), (pointer: coarse)");
    const apply = () => setTouch(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return touch;
}

function WorldCard({ world, touch }: { world: WorldEntry; touch: boolean }) {
  const status = STATUS_STYLE[world.status];
  return (
    <Link
      to={world.to}
      className="group relative block overflow-hidden rounded-2xl ring-1 ring-white/10 transition
                 active:scale-[0.985] sm:hover:ring-white/25 focus-visible:outline-none
                 focus-visible:ring-2 focus-visible:ring-white/60"
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      {/* Art. Fixed aspect so the grid never reflows as images load. */}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-neutral-900">
        {world.art ? (
          <img
            src={world.art}
            alt={`${world.name} — in-game capture`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-500 sm:group-hover:scale-[1.04]"
          />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                `radial-gradient(120% 90% at 20% 0%, ${world.accent}44, transparent 62%),` +
                `radial-gradient(90% 80% at 92% 22%, ${world.accent}22, transparent 60%),` +
                "linear-gradient(178deg, #10141c 0%, #080a0f 68%)",
            }}
          >
            {/* A skyline suggestion, drawn rather than photographed. */}
            <svg
              viewBox="0 0 160 60"
              preserveAspectRatio="none"
              className="absolute inset-x-0 bottom-0 h-1/2 w-full opacity-30"
              aria-hidden
            >
              <path
                d="M0 60V44h9V33h7v11h6V26h8v18h5V36h9v8h7V20h8v24h6V31h10v13h7V38h8v6h6V28h9v16h7v-9h8v9h6V33h9v11h7V41h8v19z"
                fill={world.accent}
              />
            </svg>
          </div>
        )}
        {/* Scrim: the type below has to stay legible over any frame. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-transparent" />
        <div
          className="absolute inset-x-0 bottom-0 h-[3px]"
          style={{ background: world.accent }}
        />

        <span
          className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-semibold
                      uppercase tracking-[0.14em] ring-1 backdrop-blur-sm ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      {/* Copy */}
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
        <h2
          className="text-2xl font-black uppercase leading-none tracking-tight text-white sm:text-3xl"
          style={{ textShadow: "0 2px 18px rgba(0,0,0,.85)" }}
        >
          {world.name}
        </h2>
        <p className="mt-1.5 max-w-[46ch] text-[13px] leading-snug text-white/70">
          {world.tagline}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {world.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium uppercase
                         tracking-wider text-white/65 ring-1 ring-white/10"
            >
              {t}
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[11px] font-medium text-white/50">{world.statusDetail}</span>
          <span
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm
                       font-bold uppercase tracking-wide text-black"
            style={{ background: world.accent }}
          >
            {touch ? "Tap to drop in" : "Drop in"}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>
    </Link>
  );
}

export default function Worlds() {
  const touch = useIsTouch();
  const playable = useMemo(() => WORLDS.filter((w) => w.status === "playable").length, []);

  useEffect(() => {
    const prev = document.title;
    document.title = "Worlds — Vibeverse";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div
      className="min-h-[100dvh] bg-[#06070a] text-white"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 0px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 0px)",
      }}
    >
      {/* A very cheap ambient wash — no 3D, no cost. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(1100px 620px at 12% -8%, rgba(255,106,43,.16), transparent 60%)," +
            "radial-gradient(900px 520px at 88% 4%, rgba(255,176,32,.12), transparent 62%)",
        }}
      />

      <div className="relative mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6 sm:pt-14">
        <header className="mb-7 sm:mb-10">
          <Link
            to="/"
            className="inline-flex min-h-[36px] items-center gap-1.5 text-[11px] font-medium
                       uppercase tracking-[0.3em] text-white/40 transition hover:text-white/70"
          >
            ← Vibeverse
          </Link>
          <h1 className="mt-3 text-[clamp(2.4rem,11vw,4.5rem)] font-black uppercase leading-[0.85] tracking-tight">
            Worlds
          </h1>
          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-white/55">
            Full-scale playable cities. {playable} of {WORLDS.length} is ready to play right
            now — the rest are open to explore while they are being built.
          </p>
        </header>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
          {WORLDS.map((w) => (
            <WorldCard key={w.key} world={w} touch={touch} />
          ))}
        </div>

        <section className="mt-10 rounded-2xl bg-white/[0.04] p-5 ring-1 ring-white/10">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
            Controls
          </h3>
          <div className="mt-3 grid gap-3 text-[13px] leading-relaxed text-white/65 sm:grid-cols-2">
            <p>
              <span className="font-semibold text-white/85">Desktop</span> — click to capture
              the pointer, <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[11px]">WASD</kbd>{" "}
              to move, mouse to look, <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[11px]">Esc</kbd>{" "}
              to release.
            </p>
            <p>
              <span className="font-semibold text-white/85">Phone</span> — drag the right half
              of the screen to look, the left stick to move. These are big worlds; they run
              best with everything else closed.
            </p>
          </div>
        </section>

        <p className="mt-8 text-center text-[11px] text-white/25">
          More of the Vibeverse — city, island, space, garden and the rest —{" "}
          <Link to="/" className="underline decoration-white/20 underline-offset-4 hover:text-white/50">
            back at the hub
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
