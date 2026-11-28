/**
 * The character picker drawn over a live flyover of Vibe City.
 *
 * Same job as CityEntryScreen (pick a character, a name, Enter), but with no
 * backdrop of its own: the city renders underneath, the camera on a drone
 * path from src/city/flyover.ts, so what is behind the picker is the city as
 * it is right now. Three layouts, one per path, previewed with
 * `/city?entry=drone|glide|tour`; `?entry=classic` is today's screen.
 *
 * Still one extra WebGL context (the character preview), same as before.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Dices, Shuffle } from "lucide-react";
import { CharacterPreview } from "@/island/CharacterPreview";
import type { CharacterOption } from "@/island/characters";
import { generateCharacterName } from "@/lib/character-naming";
import { characterArt } from "@/lib/characterArt";
import { FEATURED_CHARACTER_IDS, toOption, type CityChar } from "@/components/city/CityEntryScreen";
import { flyoverShot, type FlyoverId } from "@/city/flyover";
import loginBg from "@/assets/island-explorer/new-login-bg.jpg";

export type EntryLook = FlyoverId | "classic";

interface Props {
  look: FlyoverId;
  /** The city has drawn a few frames; until then the painted backdrop shows. */
  ready: boolean;
  characters: CityChar[];
  initialCharacter: string;
  initialName: string;
  onEnter: (pick: { character: string; name: string }) => void;
}

/** Caption and dip-to-black, written straight to the DOM off the same clock
 *  the camera uses, so no React render per frame. */
function useFlyoverClock(look: FlyoverId) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const step = () => {
      const s = flyoverShot(look, performance.now() * 0.001);
      if (s.label !== last && labelRef.current) {
        last = s.label;
        labelRef.current.textContent = s.label;
      }
      if (fadeRef.current) fadeRef.current.style.opacity = String(s.fade);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [look]);
  return { labelRef, fadeRef };
}

function LiveChip({ labelRef, className = "" }: { labelRef: React.RefObject<HTMLSpanElement>; className?: string }) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border border-white/25 bg-slate-950/45 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/90 backdrop-blur-md ${className}`}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
      </span>
      Live
      <span className="text-white/45">·</span>
      <span ref={labelRef} className="normal-case tracking-[0.04em]">Vibe City</span>
    </div>
  );
}

export default function CityFlyoverEntry({ look, ready, characters, initialCharacter, initialName, onEnter }: Props) {
  const options = useMemo(() => characters.map((c, i) => toOption(c, i)), [characters]);
  const featured = useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]));
    const top = FEATURED_CHARACTER_IDS.map((id) => byId.get(id)).filter(Boolean) as CharacterOption[];
    const seen = new Set(top.map((o) => o.id));
    return [...top, ...options.filter((o) => !seen.has(o.id) && characterArt(o.id))];
  }, [options]);
  const [picked, setPicked] = useState(initialCharacter);
  const [name, setName] = useState(initialName);
  const [tick, setTick] = useState(0);
  const current = options.find((o) => o.id === picked) ?? options[0];
  const { labelRef, fadeRef } = useFlyoverClock(look);

  const pick = (c: CharacterOption) => {
    setPicked(c.id);
    setName(generateCharacterName(c.name));
    setTick((t) => t + 1);
  };
  const random = () => {
    if (!options.length) return;
    let next = options[Math.floor(Math.random() * options.length)];
    for (let g = 0; g < 6 && next.id === picked && options.length > 1; g++) {
      next = options[Math.floor(Math.random() * options.length)];
    }
    pick(next);
  };
  const enter = () => {
    const clean = name.trim() || generateCharacterName(current?.name);
    onEnter({ character: current?.id ?? picked, name: clean });
  };

  const preview = current ? (
    <CharacterPreview key={`${current.id}-${tick}`} character={current} spinning />
  ) : null;

  const nameRow = (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 32))}
        maxLength={32}
        aria-label="Your name"
        placeholder="Your name"
        className="h-12 min-w-0 flex-1 rounded-2xl border border-white/30 bg-slate-950/30 px-4 text-base font-semibold text-white outline-none placeholder:text-white/50 focus:border-white/80"
      />
      <button
        type="button"
        onClick={() => setName(generateCharacterName(current?.name))}
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/30 bg-white/10 text-white transition hover:bg-white/20"
        aria-label="Roll a new name"
        title="Roll a new name"
      >
        <Dices className="h-5 w-5" />
      </button>
    </div>
  );

  const pickerRow = (
    <div className="grid grid-cols-2 gap-2">
      <select
        value={picked}
        onChange={(e) => {
          const next = options.find((o) => o.id === e.target.value);
          if (next) pick(next);
        }}
        aria-label="All characters"
        className="h-11 min-w-0 appearance-none rounded-2xl border border-white/25 bg-slate-950/55 px-3 text-sm font-medium text-white outline-none focus:border-white/80"
      >
        {options.map((c) => (
          <option key={c.id} value={c.id} className="text-slate-900">
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={random}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/25 bg-white/10 px-3 text-sm font-semibold text-white transition hover:bg-white/20"
      >
        <Shuffle className="h-4 w-4" />
        Random
      </button>
    </div>
  );

  const cta = (label = "Enter Vibe Island") => (
    <button
      type="button"
      onClick={enter}
      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-4 text-sm font-extrabold uppercase tracking-[0.2em] text-slate-900 shadow-[0_18px_50px_rgba(0,0,0,0.35)] transition hover:-translate-y-0.5"
    >
      {label}
      <ArrowRight className="h-4 w-4" />
    </button>
  );

  const portrait = (c: CharacterOption, size: string) => {
    const on = c.id === picked;
    const art = characterArt(c.id);
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => pick(c)}
        title={c.name}
        aria-label={`Play as ${c.name}`}
        aria-pressed={on}
        className={`group relative shrink-0 overflow-hidden rounded-2xl border transition ${size} ${
          on ? "border-white bg-white/30 shadow-[0_0_0_3px_rgba(255,255,255,0.35)]" : "border-white/20 bg-slate-950/30 hover:border-white/70 hover:bg-white/15"
        }`}
      >
        {art ? (
          <img src={art} alt="" loading="lazy" className="mx-auto h-full w-auto object-contain pt-1 transition group-hover:scale-105" />
        ) : (
          <span className="flex h-full items-center justify-center px-1 text-center text-[10px] font-semibold leading-tight text-white/85">
            {c.name}
          </span>
        )}
      </button>
    );
  };

  // The painted backdrop stays until the city has actually drawn, so a slow
  // load opens on the old picture rather than a black rectangle.
  const backdrop = (
    <div
      className="pointer-events-none absolute inset-0 bg-cover bg-center transition-opacity duration-[1600ms]"
      style={{ backgroundImage: `url(${loginBg})`, backgroundColor: "#b7dceb", opacity: ready ? 0 : 1 }}
    />
  );

  /* ---------- A · Drone: today's layout, made of glass. ---------- */
  if (look === "drone") {
    return (
      <div className="absolute inset-0 z-20 overflow-y-auto text-white">
        {backdrop}
        <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-slate-950/45 via-slate-950/0 to-slate-950/60" />
        <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-10 pt-24 sm:px-6 lg:pt-28">
          <div className="mx-auto mb-7 max-w-2xl text-center">
            <LiveChip labelRef={labelRef} className="mb-4" />
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.45em] text-white/85 drop-shadow">
              Welcome to Vibe City
            </div>
            <h1 className="text-4xl font-light tracking-[-0.04em] drop-shadow-xl sm:text-6xl">Pick your vibe</h1>
            <p className="mx-auto mt-3 max-w-lg text-sm font-medium text-white/85 drop-shadow">
              That is the city right now, live. Pick who you want to be in it.
            </p>
          </div>
          <section className="mb-8 rounded-3xl border border-white/25 bg-slate-950/15 p-4 shadow-2xl lg:p-5">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="relative h-[360px] overflow-hidden rounded-2xl border border-white/20 sm:h-[440px]">
                {preview}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-slate-950/55 to-transparent" />
                <div className="absolute bottom-4 left-4 right-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/75">Selected character</div>
                  <div className="truncate text-4xl font-light tracking-[-0.05em] drop-shadow sm:text-5xl">{current?.name}</div>
                  <p className="mt-1 max-w-xl text-sm font-medium text-white/80">{current?.description}</p>
                </div>
              </div>
              <div className="flex flex-col justify-center gap-4 rounded-2xl border border-white/20 bg-slate-950/35 p-5 backdrop-blur-xl">
                <label className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/75">Your name</label>
                {nameRow}
                {pickerRow}
                {cta()}
              </div>
            </div>
          </section>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-white/80 drop-shadow">
            Browse characters
          </div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
            {featured.slice(0, 32).map((c) => portrait(c, "h-28 w-full backdrop-blur-sm"))}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- B · Glide: a side panel, the character stands in the city. ---------- */
  if (look === "glide") {
    return (
      <div className="absolute inset-0 z-20 overflow-y-auto text-white lg:overflow-hidden">
        {backdrop}
        <div className="pointer-events-none fixed inset-0 bg-gradient-to-r from-slate-950/70 via-slate-950/10 to-transparent" />
        <div className="relative flex min-h-full flex-col-reverse lg:h-full lg:flex-row">
          <aside className="relative z-10 flex w-full flex-col gap-4 rounded-t-3xl border-t border-white/15 bg-slate-950/55 px-5 pb-8 pt-6 backdrop-blur-xl lg:h-full lg:w-[440px] lg:rounded-none lg:border-r lg:border-t-0 lg:px-8 lg:pt-24">
            <div className="text-[11px] font-semibold uppercase tracking-[0.4em] text-white/70">Welcome to Vibe City</div>
            <h1 className="-mt-1 text-4xl font-light tracking-[-0.04em] lg:text-5xl">Pick your vibe</h1>
            {nameRow}
            {pickerRow}
            <div className="-mx-1 grid max-h-[30vh] grid-cols-4 gap-2 overflow-y-auto px-1 py-1 lg:max-h-none lg:flex-1">
              {featured.slice(0, 40).map((c) => portrait(c, "h-20 w-full"))}
            </div>
            {cta()}
          </aside>
          <div className="relative flex min-h-[46vh] flex-1 flex-col lg:min-h-0">
            <div className="absolute right-4 top-20 lg:right-8 lg:top-24">
              <LiveChip labelRef={labelRef} />
            </div>
            <div className="relative mx-auto mt-16 h-[40vh] w-full max-w-[560px] lg:mt-auto lg:h-[72vh]">{preview}</div>
            <div className="pointer-events-none px-6 pb-6 text-center lg:pb-12">
              <div className="truncate text-4xl font-extralight tracking-[-0.05em] drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)] sm:text-6xl">
                {current?.name}
              </div>
              <p className="mt-1 text-sm font-medium text-white/85 drop-shadow">{current?.description}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- C · Tour: letterboxed postcard cuts, a strip of faces. ---------- */
  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-hidden text-white">
      {backdrop}
      <div ref={fadeRef} className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: 0 }} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(2,6,23,0.55))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[40vh] bg-gradient-to-b from-slate-950/45 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[40vh] bg-gradient-to-t from-slate-950/55 to-transparent" />
      <div className="relative h-[7vh] shrink-0 bg-black lg:h-[9vh]" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="pt-6 text-center lg:pt-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.5em] text-white/80 drop-shadow">Vibe City · live</div>
          <h1 className="mt-1 font-serif text-4xl italic tracking-[-0.02em] drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)] sm:text-6xl">
            Pick your vibe
          </h1>
        </div>
        <div className="relative mx-auto min-h-0 w-full max-w-[420px] flex-1">{preview}</div>
        <div className="flex flex-col gap-3 px-4 pb-4 lg:flex-row lg:items-end lg:gap-6 lg:px-10">
          <div className="min-w-0 lg:w-64">
            <div className="text-[10px] font-semibold uppercase tracking-[0.35em] text-white/70">Now over</div>
            <div className="truncate font-serif text-2xl italic drop-shadow lg:text-3xl">
              <span ref={labelRef}>Vibe City</span>
            </div>
            <div className="mt-1 truncate text-sm text-white/80">
              You are <span className="font-semibold text-white">{current?.name}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {featured.slice(0, 40).map((c) => portrait(c, "h-20 w-16 lg:h-24 lg:w-20"))}
          </div>
          <div className="flex w-full flex-col gap-2 lg:w-80">
            {nameRow}
            {cta()}
          </div>
        </div>
      </div>
      <div className="relative h-[7vh] shrink-0 bg-black lg:h-[9vh]" />
    </div>
  );
}

const LOOKS: { id: EntryLook; label: string }[] = [
  { id: "classic", label: "Today" },
  { id: "drone", label: "A · Drone" },
  { id: "glide", label: "B · Glide" },
  { id: "tour", label: "C · Tour" },
];

/** Preview-only switcher: flips between the looks and keeps the URL in step. */
export function EntryLookSwitcher({ look, onLook }: { look: EntryLook; onLook: (l: EntryLook) => void }) {
  return (
    <div className="absolute left-1/2 top-[68px] z-30 flex -translate-x-1/2 gap-1 whitespace-nowrap rounded-full border border-white/20 bg-slate-950/70 p-1 text-xs font-semibold text-white backdrop-blur-md">
      {LOOKS.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => {
            const u = new URL(window.location.href);
            u.searchParams.set("entry", l.id);
            window.history.replaceState(null, "", u.toString());
            onLook(l.id);
          }}
          className={`rounded-full px-3 py-1.5 transition ${look === l.id ? "bg-white text-slate-900" : "hover:bg-white/15"}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
