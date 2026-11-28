/**
 * Start screens for Cannon Chase. The highlight reel is the real one (Jack's
 * pick, 2026-11-26); news, wanted and comic stay previewable with `?look=`.
 *
 * Every look gets the same handlers, so the buttons are the real ones: light
 * the fuse, two on one screen, a friend's phone, the aurora and Thanksgiving
 * switches, the garage and the hub. The art is real captures from the game
 * (src/assets/cannonrun/splash), and switching aurora or Thanksgiving on
 * changes which shots lead, so the switches visibly do something here.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import fontRye from "@/assets/cannonrun/splash/rye-latin-400-normal.woff2";
import fontBangers from "@/assets/cannonrun/splash/bangers-latin-400-normal.woff2";
import fontAnton from "@/assets/cannonrun/splash/anton-latin-400-normal.woff2";

import imgAuroraTrain from "@/assets/cannonrun/splash/aurora-train.jpg";
import imgAurora from "@/assets/cannonrun/splash/aurora.jpg";
import imgSpaceTripod from "@/assets/cannonrun/splash/space-tripod.jpg";
import imgSpaceMonster from "@/assets/cannonrun/splash/space-monster.jpg";
import imgSpaceTakeback from "@/assets/cannonrun/splash/space-takeback.jpg";
import imgExplode from "@/assets/cannonrun/splash/explode.jpg";
import imgFlying from "@/assets/cannonrun/splash/flying.jpg";
import imgHenchmen from "@/assets/cannonrun/splash/henchmen.jpg";
import imgLindaRigs from "@/assets/cannonrun/splash/linda-rigs.jpg";
import imgTwoTrains from "@/assets/cannonrun/splash/two-trains.jpg";
import imgMortTow from "@/assets/cannonrun/splash/mort-tow.jpg";
import imgThanks from "@/assets/cannonrun/splash/thanks.jpg";
import imgTrain from "@/assets/cannonrun/splash/train.jpg";
import imgTwoTrucks from "@/assets/cannonrun/splash/two-trucks.jpg";
import imgSunrise from "@/assets/cannonrun/splash/sunrise.jpg";
import imgShowdown from "@/assets/cannonrun/splash/showdown.jpg";
import imgComicGarage from "@/assets/cannonrun/splash/comic-garage.jpg";
import imgComicVroom from "@/assets/cannonrun/splash/comic-vroom.jpg";
import imgComicGone from "@/assets/cannonrun/splash/comic-gone.jpg";
import imgComicCall from "@/assets/cannonrun/splash/comic-call.jpg";

export const LOOKS = ["reel", "news", "wanted", "comic"] as const;
export type Look = (typeof LOOKS)[number];
export const LOOK_NAMES: Record<Look, string> = { reel: "Highlight reel", news: "Gatch News", wanted: "Wanted poster", comic: "Comic book" };

export type SplashProps = {
  phone: boolean;
  aurora: boolean;
  thanks: boolean;
  /** outer space mode, and its switch */
  space?: boolean;
  onSpace?: () => void;
  bank: number;
  onSolo: () => void;
  onDuo: () => void;
  onHost: () => void;
  onGarage: () => void;
  onStory: () => void;
  onAurora: () => void;
  onThanks: () => void;
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const FONTS = `
@font-face{font-family:'CC Rye';src:url(${fontRye}) format('woff2');font-display:swap}
@font-face{font-family:'CC Bangers';src:url(${fontBangers}) format('woff2');font-display:swap}
@font-face{font-family:'CC Anton';src:url(${fontAnton}) format('woff2');font-display:swap}
@keyframes cc-burns{from{transform:scale(1.02) translate3d(0,0,0)}to{transform:scale(1.16) translate3d(-2%,-1.5%,0)}}
@keyframes cc-ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes cc-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
@keyframes cc-pop{0%{transform:scale(.6) rotate(-8deg);opacity:0}70%{transform:scale(1.08) rotate(-4deg);opacity:1}100%{transform:scale(1) rotate(-4deg)}}
@keyframes cc-rise{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
@keyframes cc-sway{0%,100%{transform:rotate(-1.2deg)}50%{transform:rotate(1.2deg)}}
`;

type Shot = { src: string; line: string; tag: string };

/** The story in eight beats. Aurora and Thanksgiving lead when they are switched on. */
function useShots(aurora: boolean, thanks: boolean, space = false): Shot[] {
  return useMemo(() => {
    const base: Shot[] = [
      { src: imgMortTow, tag: "MAD MORT", line: "It was Grandpa's cannon. Mad Mort wants it back." },
      { src: imgHenchmen, tag: "BACKUP", line: "His junkyard pals ride along, in ridiculous hats." },
      { src: imgExplode, tag: "COLLATERAL", line: "Anything in his way goes up. Usually on fire." },
      { src: imgLindaRigs, tag: "LUNATIC LINDA", line: "Then his cousin Linda shows up. She grinds her teeth." },
      { src: imgFlying, tag: "WRECK HIM", line: "Wreck his rides for cash. He comes back bigger." },
      { src: imgTrain, tag: "THE TRAIN", line: "He runs out of trucks. So he steals a train." },
      { src: imgTwoTrains, tag: "TWO PLAYERS", line: "Bring a friend and there are two trains." },
      { src: imgSunrise, tag: "DOT'S DINER", line: "Dot's Diner never closes, and neither does the chase." },
    ];
    const lead: Shot[] = [];
    if (space) lead.push(
      { src: imgSpaceTripod, tag: "OUTER SPACE", line: "You swiped his blaster. He boarded a rocket to get it back. Then a Tripod." },
      { src: imgSpaceMonster, tag: "MONSTER ROCKET", line: "Every truck he had, he has a rocket of now." },
      { src: imgSpaceTakeback, tag: "HIS BLASTER", line: "Let him catch you and he walks it home. In his helmet." },
    );
    if (thanks && !space) lead.push({ src: imgThanks, tag: "THANKSGIVING", line: "Pilgrim hats for everybody. Even the henchmen." });
    if (aurora) lead.push({ src: imgAuroraTrain, tag: "AURORA TONIGHT", line: "Northern lights over the desert. Nobody knows why." });
    return [...lead, ...base];
  }, [aurora, thanks, space]);
}

function useTick(n: number, ms: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (n <= 1) return;
    const id = window.setInterval(() => setI((v) => (v + 1) % n), ms);
    return () => window.clearInterval(id);
  }, [n, ms]);
  return i;
}

/** Stacked crossfading photos with a slow push-in on whichever one is up. */
function Crossfade({ shots, i, filter }: { shots: { src: string }[]; i: number; filter?: string }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {shots.map((s, k) => (
        <img
          key={s.src}
          src={s.src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            opacity: k === i ? 1 : 0,
            transition: "opacity 1.4s ease",
            animation: k === i ? "cc-burns 7s ease-out forwards" : undefined,
            filter,
          }}
        />
      ))}
    </div>
  );
}

export function SplashLook({ look, ...p }: SplashProps & { look: Look }) {
  return (
    <>
      <style>{FONTS}</style>
      {look === "reel" ? <Reel {...p} /> : look === "news" ? <News {...p} /> : look === "wanted" ? <Wanted {...p} /> : <ComicBook {...p} />}
    </>
  );
}

/* ================================================================ A. Highlight reel */

function Reel(p: SplashProps) {
  const shots = useShots(p.aurora, p.thanks, p.space);
  const i = useTick(shots.length, 4800);
  const s = shots[i] ?? shots[0];
  const item = "group flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-[15px] font-semibold transition hover:bg-white/10";
  return (
    <div className="absolute inset-0 overflow-hidden">
      <Crossfade shots={shots} i={i} />
      <div className="absolute inset-0" style={{ background: p.phone ? "linear-gradient(180deg, rgba(5,7,14,.35) 0%, rgba(5,7,14,.15) 30%, rgba(5,7,14,.92) 62%, #05070e 100%)" : "linear-gradient(90deg, rgba(5,7,14,.94) 0%, rgba(5,7,14,.78) 34%, rgba(5,7,14,.1) 64%), linear-gradient(0deg, rgba(5,7,14,.85) 0%, transparent 30%)" }} />

      <div className={`absolute inset-0 flex flex-col overflow-y-auto ${p.phone ? "justify-end px-5 pb-8" : "justify-center px-[6vw]"}`}>
        <div className="w-full max-w-[420px]">
          <div className="text-[12px] font-bold tracking-[0.32em] text-[#ffd36a]">{p.space ? "LOW ORBIT · THE ASTEROID BELT" : "MIDNIGHT · ROUTE 66"}</div>
          <h1 className="mt-2 leading-[0.86] text-white" style={{ fontFamily: "'CC Anton', Impact, sans-serif", fontSize: p.phone ? 64 : 96, textShadow: "0 4px 30px rgba(0,0,0,.6)" }}>
            CANNON<br /><span className="text-[#ffd36a]">CHASE</span>
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/75">
            {p.space
              ? "You swiped Mad Mort's blaster and bolted it to the top of your freighter. He boarded a rocket to get it back. His headlights are right behind you."
              : "You stole Grandpa's ship cannon and bolted it in the bed of your pickup. Mad Mort says it's his. His headlights are right behind you."}
          </p>

          <div className="mt-5 flex flex-col gap-0.5">
            <button className={`${item} bg-[#ffd36a] text-black hover:bg-[#ffe08f]`} onClick={p.onSolo}>
              <span className="text-lg">💣</span><span className="flex-1">Light the fuse</span><span className="opacity-50">▶</span>
            </button>
            <button className={item} onClick={p.onDuo}><span className="w-6 text-center text-[#5ab4ff]">2P</span><span className="flex-1">{p.phone ? "Two trucks, one phone" : "Two trucks, one screen"}</span></button>
            <button className={item} onClick={p.onHost}><span className="w-6 text-center">📱</span><span className="flex-1">Play with a friend's phone</span></button>
            <button className={item} onClick={p.onGarage}>
              <span className="w-6 text-center">🔧</span><span className="flex-1">Garage</span><span className="text-[#4de0a8]" style={{ fontFamily: MONO }}>${p.bank.toLocaleString()}</span>
            </button>
            <button className={item} onClick={p.onStory}><span className="w-6 text-center">📖</span><span className="flex-1">Read the story</span></button>
            <Link to="/" className={`${item} text-white/60`}><span className="w-6 text-center">←</span><span className="flex-1">Back to the hub</span></Link>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {p.onSpace ? <Chip on={!!p.space} onClick={p.onSpace} color="#9a8aff">🚀 Outer space</Chip> : null}
            <Chip on={p.aurora} onClick={p.onAurora} color="#5dffb0">✦ Aurora sky</Chip>
            <Chip on={p.thanks} onClick={p.onThanks} color="#ffa64a">🦃 Thanksgiving</Chip>
          </div>

        </div>
      </div>

      {/* What you are looking at: the story beat for this shot. */}
      {!p.phone ? (
        <div key={i} className="pointer-events-none absolute bottom-8 right-8 max-w-[360px] text-right" style={{ animation: "cc-rise .7s ease both" }}>
          <div className="text-[11px] font-bold tracking-[0.3em] text-[#ffd36a]">{String(i + 1).padStart(2, "0")} · {s.tag}</div>
          <div className="mt-1 text-[20px] font-semibold leading-snug text-white" style={{ textShadow: "0 2px 12px rgba(0,0,0,.8)" }}>{s.line}</div>
          <div className="mt-3 flex justify-end gap-1">
            {shots.map((_, k) => <span key={k} className="h-1 rounded-full transition-all" style={{ width: k === i ? 26 : 8, background: k === i ? "#ffd36a" : "rgba(255,255,255,.3)" }} />)}
          </div>
        </div>
      ) : (
        <div key={i} className="pointer-events-none absolute left-5 right-5 top-[max(env(safe-area-inset-top),70px)]" style={{ animation: "cc-rise .7s ease both" }}>
          <div className="text-[10px] font-bold tracking-[0.3em] text-[#ffd36a]">{s.tag}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-white" style={{ textShadow: "0 2px 10px rgba(0,0,0,.9)" }}>{s.line}</div>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, color, children }: { on: boolean; onClick: () => void; color: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3.5 py-1.5 text-[12px] font-semibold ring-1 backdrop-blur-sm transition"
      style={on ? { background: `${color}33`, color, boxShadow: `inset 0 0 0 1px ${color}99` } : { background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.6)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)" }}
    >
      {children}: {on ? "on" : "off"}
    </button>
  );
}

/* ================================================================ B. Gatch News */

const HEADLINES = [
  { h: "MAN STEALS GRANDPA'S CANNON, FLEES IN PICKUP", s: "Owner \"Mad Mort\" in pursuit on Route 66. Witnesses describe him as \"extremely upset.\"" },
  { h: "MORT IS NOW DRIVING A CEMENT MIXER", s: "Chopper 7 confirms the tow truck did not make it. Neither did the monster truck." },
  { h: "COUSIN \"LUNATIC LINDA\" JOINS THE CHASE", s: "Linda, in a purple 18-wheeler, could be heard grinding her teeth from the air." },
  { h: "HE IS DRIVING A TRAIN", s: "We cannot stress this enough. A TRAIN. On the highway. With a whistle." },
  { h: "DOT'S DINER STAYING OPEN ALL NIGHT", s: "Dot says pies are on the house for whoever ends up in her parking lot." },
];

function News(p: SplashProps) {
  const shots = useShots(p.aurora, p.thanks, p.space);
  const i = useTick(shots.length, 3800);
  const h = useTick(HEADLINES.length, 5200);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(id); }, []);
  const ticker = [
    "TRAIN REPORTED ON ROUTE 66, PLEASE DO NOT WAVE AT IT",
    "JUNKYARD MEN IN SILLY HATS SEEN THROWING THINGS",
    p.aurora ? "AURORA VISIBLE OVER THE DESERT TONIGHT, SCIENTISTS BAFFLED" : "CLEAR SKIES, FULL MOON OVER THE DESERT",
    p.thanks ? "THANKSGIVING: TURKEYS ADVISED TO STAY OFF THE HIGHWAY" : "LOCAL TURKEY POPULATION RELIEVED",
    "IN-GAME CASH IS NOT REAL MONEY",
    "DOT'S DINER: PIE, COFFEE, OPEN 24 HOURS",
  ].join("   ◆   ");
  const hl = HEADLINES[h];
  const btn = "flex items-center justify-between gap-3 px-4 py-2.5 text-left text-[14px] font-bold uppercase tracking-wide transition";

  return (
    <div className="absolute inset-0 overflow-hidden bg-black" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <Crossfade shots={shots} i={i} filter="saturate(.85) contrast(1.1)" />
      {/* the chopper camera: scanlines, a vignette, corner brackets and a reticle */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px), radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.7) 100%)" }} />
      <div className="pointer-events-none absolute inset-[5%] hidden sm:block">
        {["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2", "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"].map((c) => <span key={c} className={`absolute h-8 w-8 border-white/50 ${c}`} />)}
        <span className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40" />
      </div>

      {/* top bug */}
      <div className="absolute left-4 top-[max(env(safe-area-inset-top),64px)] flex items-center gap-2 sm:left-8 sm:top-[84px]">
        <div className="rounded-sm bg-[#d8262a] px-2.5 py-1 text-[13px] font-black tracking-tight text-white shadow" style={{ fontFamily: "'CC Anton', Impact, sans-serif", letterSpacing: ".04em" }}>GATCH NEWS</div>
        <div className="flex items-center gap-1.5 rounded-sm bg-black/70 px-2 py-1 text-[11px] font-bold text-white">
          <span className="h-2 w-2 rounded-full bg-[#ff3b3b]" style={{ animation: "cc-blink 1.2s infinite" }} /> LIVE
        </div>
        <div className="hidden rounded-sm bg-black/60 px-2 py-1 text-[11px] font-semibold text-white/80 sm:block" style={{ fontFamily: MONO }}>CHOPPER 7 · ROUTE 66</div>
      </div>
      <div className="absolute right-4 top-[max(env(safe-area-inset-top),64px)] text-right text-[12px] font-semibold text-white/80 sm:right-8 sm:top-[84px]" style={{ fontFamily: MONO }}>
        {clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
        <div className="text-[10px] text-white/50">REC ●</div>
      </div>

      {/* the rundown: what is up next is you */}
      <div className={`absolute ${p.phone ? "inset-x-4 top-[104px]" : "right-8 top-1/2 w-[300px] -translate-y-[60%]"}`}>
        <div className="bg-[#0e1f4a] px-4 py-2 text-[11px] font-black tracking-[0.25em] text-[#ffd36a]">UP NEXT: YOU</div>
        <div className="flex flex-col bg-black/75 backdrop-blur">
          <button className={`${btn} bg-[#ffd36a] text-black hover:bg-[#ffe08f]`} onClick={p.onSolo}>Light the fuse <span>▶</span></button>
          <button className={`${btn} border-t border-white/10 text-white hover:bg-white/10`} onClick={p.onDuo}>{p.phone ? "Two trucks, one phone" : "Two trucks, one screen"} <span className="text-white/40">2P</span></button>
          <button className={`${btn} border-t border-white/10 text-white hover:bg-white/10`} onClick={p.onHost}>Play with a friend's phone <span className="text-white/40">📱</span></button>
          <button className={`${btn} border-t border-white/10 text-white hover:bg-white/10`} onClick={p.onGarage}>Garage <span className="text-[#4de0a8]" style={{ fontFamily: MONO }}>${p.bank.toLocaleString()}</span></button>
          <button className={`${btn} border-t border-white/10 text-white hover:bg-white/10`} onClick={p.onStory}>Read the story <span className="text-white/40">📖</span></button>
          <div className="grid grid-cols-2 border-t border-white/10">
            <button className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${p.aurora ? "bg-[#1f6b55] text-[#cfffe8]" : "text-white/55 hover:bg-white/10"}`} onClick={p.onAurora}>✦ Aurora {p.aurora ? "on" : "off"}</button>
            <button className={`border-l border-white/10 px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${p.thanks ? "bg-[#8a3a12] text-[#ffe2c0]" : "text-white/55 hover:bg-white/10"}`} onClick={p.onThanks}>🦃 Thanks {p.thanks ? "on" : "off"}</button>
          </div>
          <Link to="/" className="border-t border-white/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/50 hover:bg-white/10">← Change the channel (hub)</Link>
        </div>
      </div>

      {/* lower third */}
      <div className="absolute inset-x-0" style={{ bottom: "calc(max(env(safe-area-inset-bottom), 0px) + 30px)" }}>
        <div className={`${p.phone ? "mx-3" : "ml-8 mr-[360px] max-w-[860px]"}`}>
          <div className="flex items-stretch">
            <div className="flex items-center bg-[#d8262a] px-3 text-[13px] font-black tracking-wider text-white sm:text-[15px]" style={{ fontFamily: "'CC Anton', Impact, sans-serif" }}>BREAKING</div>
            <div key={h} className="flex-1 bg-white px-3 py-1.5 text-black" style={{ animation: "cc-rise .5s ease both" }}>
              <div className="leading-[1.05]" style={{ fontFamily: "'CC Anton', Impact, sans-serif", fontSize: p.phone ? 20 : 34 }}>{hl.h}</div>
            </div>
          </div>
          <div key={`s${h}`} className="bg-[#0e1f4a]/95 px-3 py-1.5 text-[12px] text-white/85 sm:text-[14px]" style={{ animation: "cc-rise .6s ease both" }}>{hl.s}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-white/70">
            <span className="bg-black/70 px-2 py-0.5" style={{ fontFamily: "'CC Anton', Impact, sans-serif", fontSize: 13, letterSpacing: ".06em" }}>CANNON CHASE</span>
            <span className="hidden sm:inline">COVERAGE CONTINUES ALL NIGHT</span>
          </div>
        </div>
      </div>
      {/* ticker */}
      <div className="absolute inset-x-0 flex h-[30px] items-center overflow-hidden bg-[#ffd36a] text-black" style={{ bottom: "max(env(safe-area-inset-bottom), 0px)" }}>
        <div className="z-10 flex h-full items-center bg-black px-3 text-[11px] font-black tracking-widest text-[#ffd36a]">GATCH</div>
        <div className="flex whitespace-nowrap text-[13px] font-bold" style={{ animation: "cc-ticker 40s linear infinite" }}>
          <span className="px-6">{ticker}   ◆   </span><span className="px-6">{ticker}   ◆   </span>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ C. Wanted poster */

function Wanted(p: SplashProps) {
  const bg = p.aurora ? imgAurora : p.thanks ? imgThanks : imgTwoTrucks;
  const ink = "#3a2414";
  const paper = "radial-gradient(ellipse at 30% 20%, #f6e6c2 0%, #ecd4a2 55%, #d9b77c 100%)";
  const stamp = "w-full border-2 px-4 py-2 text-[15px] uppercase tracking-wider transition hover:-translate-y-0.5";
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <img src={bg} alt="" className="fixed inset-0 h-full w-full object-cover" style={{ filter: "blur(3px) brightness(.55) sepia(.35)" }} />
      <div className="fixed inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(40,20,5,.2) 0%, rgba(10,6,2,.85) 100%)" }} />

      <div className="relative flex min-h-full items-center justify-center px-4 pb-10 pt-16">
        <div className="relative w-full max-w-[460px]" style={{ animation: p.phone ? undefined : "cc-sway 7s ease-in-out infinite", transformOrigin: "50% -40px" }}>
          {/* the nail */}
          <span className="absolute left-1/2 top-2 z-10 h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-[#5b5b5b] shadow-[inset_-2px_-2px_0_rgba(0,0,0,.4),0_2px_3px_rgba(0,0,0,.5)]" />
          <div
            className="relative px-6 pb-6 pt-8 text-center sm:px-9"
            style={{ background: paper, color: ink, boxShadow: "0 30px 60px rgba(0,0,0,.6), inset 0 0 60px rgba(120,70,20,.35)", clipPath: "polygon(0 1%, 6% 0, 18% 1.2%, 33% 0, 51% .8%, 70% 0, 86% 1%, 100% 0, 99.2% 22%, 100% 48%, 99% 76%, 100% 100%, 82% 99.2%, 64% 100%, 45% 99%, 25% 100%, 9% 99.3%, 0 100%, .8% 74%, 0 50%, 1% 25%)" }}
          >
            <div className="text-[12px] tracking-[0.35em]" style={{ fontFamily: "'CC Rye', Georgia, serif" }}>★ ROUTE 66 ★</div>
            <div className="mt-1 leading-none" style={{ fontFamily: "'CC Rye', Georgia, serif", fontSize: p.phone ? 58 : 76 }}>WANTED</div>
            <div className="mt-1 text-[13px] font-semibold uppercase tracking-[0.18em]">for the theft of Grandpa's cannon</div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {[{ name: "MAD MORT", note: "says it's his", pos: "4% 0%" }, { name: "LUNATIC LINDA", note: "his cousin. bites.", pos: "96% 0%" }].map((x) => (
                <div key={x.name}>
                  <div className="aspect-square overflow-hidden border-[3px] p-1" style={{ borderColor: ink }}>
                    <div className="h-full w-full overflow-hidden">
                      <img src={imgComicCall} alt={x.name} className="w-full object-cover" style={{ height: "150%", objectPosition: x.pos, filter: "sepia(.55) contrast(1.05)" }} />
                    </div>
                  </div>
                  <div className="mt-1.5 text-[15px] leading-tight" style={{ fontFamily: "'CC Rye', Georgia, serif" }}>{x.name}</div>
                  <div className="text-[11px] italic opacity-70">{x.note}</div>
                </div>
              ))}
            </div>

            <p className="mt-4 text-[13px] leading-snug">
              Ship's cannon, brass, very heavy, last seen bolted into the bed of a pickup doing ninety. Approach with tow trucks, monster trucks, cement mixers, an 18-wheeler and, if all else fails, <b>a train</b>.
            </p>
            <div className="relative mt-3 border-y-2 py-1.5" style={{ borderColor: ink }}>
              <div className="pointer-events-none absolute -right-3 -top-4 rotate-[10deg] border-[3px] bg-[#f3dfb6]/80 px-2 py-0.5 text-[12px] tracking-widest text-[#b3261e] sm:-right-8 sm:text-[14px]" style={{ fontFamily: "'CC Rye', Georgia, serif", borderColor: "#b3261e", animation: "cc-pop .6s .4s ease both" }}>
                {p.thanks ? "HAPPY THANKSGIVING" : "ARMED & HONKING"}
              </div>
              <div className="text-[11px] uppercase tracking-[0.3em]">Reward</div>
              <div className="text-[26px] leading-none" style={{ fontFamily: "'CC Rye', Georgia, serif" }}>ONE PIE</div>
              <div className="text-[11px] italic">payable at Dot's Diner</div>
            </div>

            <div className="mt-5 flex flex-col gap-2" style={{ fontFamily: "'CC Rye', Georgia, serif" }}>
              <button className={`${stamp} text-[#fbe9c6]`} style={{ background: "#8c1d12", borderColor: "#5a1008", boxShadow: "0 3px 0 #5a1008" }} onClick={p.onSolo}>💣 Light the fuse</button>
              <div className={`grid gap-2 ${p.phone ? "grid-cols-1" : "grid-cols-2"}`}>
                <button className={`${stamp} text-[13px]`} style={{ borderColor: ink }} onClick={p.onDuo}>Two trucks</button>
                <button className={`${stamp} text-[13px]`} style={{ borderColor: ink }} onClick={p.onHost}>Friend's phone</button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap justify-center gap-2 text-[12px] font-bold uppercase tracking-wide">
              <button onClick={p.onAurora} className="border-2 border-dashed px-2.5 py-1" style={{ borderColor: ink, background: p.aurora ? "#2f6b55" : "transparent", color: p.aurora ? "#eafff4" : ink }}>✦ Aurora {p.aurora ? "on" : "off"}</button>
              <button onClick={p.onThanks} className="border-2 border-dashed px-2.5 py-1" style={{ borderColor: ink, background: p.thanks ? "#8a3a12" : "transparent", color: p.thanks ? "#ffe2c0" : ink }}>🦃 Thanksgiving {p.thanks ? "on" : "off"}</button>
            </div>
            <div className="mt-3 flex justify-center gap-4 text-[13px] font-semibold underline decoration-dotted underline-offset-4">
              <button onClick={p.onStory}>Read the story</button>
              <button onClick={p.onGarage}>Garage (${p.bank.toLocaleString()})</button>
              <Link to="/">Hub</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ D. Comic book */

function ComicBook(p: SplashProps) {
  const panels: { src: string; cap?: string; boom?: string; pos?: string }[] = [
    { src: imgComicGarage },
    { src: imgComicVroom },
    { src: imgComicGone },
    { src: imgComicCall },
    { src: p.aurora ? imgAuroraTrain : p.thanks ? imgThanks : imgLindaRigs, cap: p.aurora ? "UNDER THE NORTHERN LIGHTS..." : p.thanks ? "ON THANKSGIVING, NO LESS..." : "THE RIDES GET BIGGER...", boom: "KA-BLAM!" },
    { src: imgTrain, cap: "...AND BIGGER.", boom: "TOOT TOOT!" },
    { src: imgShowdown, cap: "AND IT NEVER STOPS." },
  ];
  const yellow = "#ffd84a";
  const boxBtn = "border-[3px] border-black px-5 py-2.5 text-[20px] tracking-wide text-black transition hover:-translate-y-0.5";
  return (
    <div
      className="absolute inset-0 overflow-y-auto"
      style={{ background: "radial-gradient(circle, rgba(255,255,255,.07) 1.2px, transparent 1.6px) 0 0/12px 12px, radial-gradient(ellipse at 50% 30%, #23305e 0%, #0b0f1c 70%)", fontFamily: "'CC Bangers', Impact, sans-serif" }}
    >
      <div className="mx-auto flex min-h-full max-w-[1100px] flex-col items-center px-4 pb-8 pt-16">
        <div className="relative">
          <h1 className="text-center leading-[0.9]" style={{ fontSize: p.phone ? 64 : 104, color: yellow, WebkitTextStroke: "3px #000", textShadow: "6px 6px 0 #d8262a, 9px 9px 0 #000", letterSpacing: ".02em", transform: "rotate(-3deg)" }}>
            CANNON CHASE!
          </h1>
          <div className="absolute -right-4 -top-6 rotate-[12deg] rounded-full border-[3px] border-black bg-white px-3 py-1 text-[15px] text-black sm:-right-16" style={{ animation: "cc-pop .6s .3s ease both" }}>
            ISSUE #1
          </div>
        </div>
        <div className="mt-3 border-[3px] border-black bg-[#fff3c4] px-3 py-1 text-[16px] tracking-wide text-black shadow-[4px_4px_0_#000] sm:text-[19px]" style={{ transform: "rotate(1deg)" }}>
          IN WHICH YOU STEAL GRANDPA'S CANNON AND MAD MORT WANTS IT BACK
        </div>

        <div className={`mt-6 grid w-full gap-3 ${p.phone ? "grid-cols-2" : "grid-cols-4"}`}>
          {panels.map((x, k) => (
            <div
              key={k}
              className={`relative overflow-hidden border-[3px] border-black bg-black shadow-[5px_5px_0_#000] ${k === 6 ? (p.phone ? "col-span-2" : "col-span-2") : ""} ${k === 3 && !p.phone ? "row-span-1" : ""}`}
              style={{ transform: `rotate(${[-1.2, 0.8, -0.6, 1, -0.8, 0.6, -0.4][k]}deg)`, animation: `cc-rise .5s ${0.08 * k}s ease both`, aspectRatio: k === 6 ? (p.phone ? "2 / 1" : "2.72 / 1") : "4 / 3" }}
            >
              <img src={x.src} alt="" className="h-full w-full object-cover" style={{ objectPosition: x.pos ?? "center" }} />
              {x.cap ? <div className="absolute left-1.5 top-1.5 border-2 border-black bg-[#fff3c4] px-1.5 text-[12px] tracking-wide text-black sm:text-[15px]">{x.cap}</div> : null}
              {x.boom ? <div className="absolute bottom-2 right-2 rotate-[-8deg] text-[18px] sm:text-[26px]" style={{ color: yellow, WebkitTextStroke: "1.5px #000", textShadow: "3px 3px 0 #d8262a" }}>{x.boom}</div> : null}
            </div>
          ))}
          {!p.phone ? (
            <div className="col-span-4 mt-2 border-[3px] border-black bg-[#fff3c4] p-4 shadow-[5px_5px_0_#000]" style={{ transform: "rotate(-.3deg)" }}>
              <div className="mb-2 text-[15px] tracking-wide text-black/70">NOW IT'S YOUR TURN...</div>
              <div className="grid grid-cols-[1.3fr_1fr_1fr_auto] items-center gap-3"><Buttons p={p} yellow={yellow} boxBtn={boxBtn} /></div>
            </div>
          ) : null}
        </div>
        {p.phone ? (
          <div className="mt-5 flex w-full flex-col gap-2 border-[3px] border-black bg-[#fff3c4] p-4 shadow-[5px_5px_0_#000]">
            <Buttons p={p} yellow={yellow} boxBtn={boxBtn} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Buttons({ p, yellow, boxBtn }: { p: SplashProps; yellow: string; boxBtn: string }) {
  return (
    <>
      <button className={`${boxBtn} w-full`} style={{ background: yellow, boxShadow: "4px 4px 0 #000" }} onClick={p.onSolo}>LIGHT THE FUSE! 💣</button>
      <div className="grid grid-cols-2 gap-2">
        <button className={`${boxBtn} bg-white text-[16px]`} style={{ boxShadow: "3px 3px 0 #000" }} onClick={p.onDuo}>TWO TRUCKS</button>
        <button className={`${boxBtn} bg-white text-[16px] ${p.phone ? "col-span-2" : ""}`} style={{ boxShadow: "3px 3px 0 #000" }} onClick={p.onHost}>FRIEND'S PHONE</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button className={`${boxBtn} text-[14px]`} style={{ background: p.aurora ? "#5dffb0" : "#fff", boxShadow: "3px 3px 0 #000" }} onClick={p.onAurora}>✦ AURORA {p.aurora ? "ON" : "OFF"}</button>
        <button className={`${boxBtn} text-[14px]`} style={{ background: p.thanks ? "#ffa64a" : "#fff", boxShadow: "3px 3px 0 #000" }} onClick={p.onThanks}>🦃 THANKS {p.thanks ? "ON" : "OFF"}</button>
      </div>
      <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 pt-1 text-[16px] text-black">
        <button className="underline decoration-2 underline-offset-4" onClick={p.onStory}>STORY</button>
        <button className="underline decoration-2 underline-offset-4" onClick={p.onGarage}>GARAGE ${p.bank.toLocaleString()}</button>
        <Link to="/" className="underline decoration-2 underline-offset-4">HUB</Link>
      </div>
    </>
  );
}

/** Preview-only strip for flipping between looks without editing the URL by hand. */
export function LookSwitcher({ look, onPick }: { look: Look | "classic"; onPick: (l: Look | "classic") => void }) {
  const all: (Look | "classic")[] = ["classic", ...LOOKS];
  const next = all[(all.indexOf(look) + 1) % all.length];
  return (
    <>
    <button onClick={() => onPick(next)} className="absolute right-3 top-[max(env(safe-area-inset-top),12px)] z-50 rounded-full bg-black/80 px-3 py-1.5 text-[11px] font-semibold text-white ring-1 ring-white/15 sm:hidden" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      Next look: {next === "classic" ? "Current" : LOOK_NAMES[next]} ›
    </button>
    <div className="absolute left-1/2 hidden sm:flex top-[max(env(safe-area-inset-top),10px)] z-50 -translate-x-1/2 gap-1 rounded-full bg-black/80 p-1 text-[11px] font-semibold text-white ring-1 ring-white/15 backdrop-blur" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      {all.map((l) => (
        <button key={l} onClick={() => onPick(l)} className={`rounded-full px-3 py-1 ${l === look ? "bg-white text-black" : "text-white/70 hover:text-white"}`}>
          {l === "classic" ? "Current" : LOOK_NAMES[l]}
        </button>
      ))}
    </div>
    </>
  );
}
