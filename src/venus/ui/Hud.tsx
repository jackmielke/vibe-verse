/**
 * The play HUD. Everything here reads `world.sim` directly; the page
 * re-renders it a few times a second.
 *
 * The altimeter is the most important thing on screen, so it is the biggest
 * and the only one with a picture: a column of the atmosphere from the oven
 * to the freeze, with a mark for where you are and a ghost for where you are
 * heading.
 */
import { useEffect, useMemo, useState } from "react";
import type { VenusWorld } from "../world/Venus";
import { BUILDABLE, MODULES, type ModuleId, type ResourceId } from "../modules";
import { BAND, FREEZE_ALT, HULL_STRESS_ALT, airAt, liftFactor } from "../atmosphere";
import { MAX_LEVEL, VICTORY, type Tile } from "../sim";
import { hint as hintOf, tickerLines } from "../ticker";

const GOLD = "#f6d28b";
const panel =
  "rounded-2xl border border-[#f6d28b]/25 bg-[#1b0f0a]/55 shadow-[0_8px_40px_rgba(0,0,0,0.35)] backdrop-blur-md";

const RES: Array<{ id: ResourceId; icon: string; label: string }> = [
  { id: "carbon", icon: "◆", label: "Carbon" },
  { id: "air", icon: "○", label: "Air" },
  { id: "water", icon: "≈", label: "Water" },
  { id: "science", icon: "✦", label: "Science" },
  { id: "culture", icon: "♪", label: "Culture" },
];

const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toString());
const rate = (n: number) => (Math.abs(n) < 0.05 ? "" : `${n > 0 ? "+" : ""}${n.toFixed(1)}/s`);

export function Hud({ world, selected, compact, muted, onMute }: { world: VenusWorld; selected: Tile | null; compact: boolean; muted: boolean; onMute: () => void }) {
  const sim = world.sim;
  const s = sim.s, d = sim.d;
  const [tickIdx, setTickIdx] = useState(0);
  const lines = tickerLines(sim);
  useEffect(() => {
    const id = setInterval(() => setTickIdx((i) => i + 1), 9000);
    return () => clearInterval(id);
  }, []);
  const h = hintOf(sim);
  const hint = h?.text ?? null;
  const building = world.building;
  // The module whose weight the altimeter is previewing: hovered, or being placed.
  const [hoverId, setHoverId] = useState<ModuleId | null>(null);
  const preview = hoverId ?? building;
  const [showPeers, setShowPeers] = useState(false);
  const peers = world.peers();

  return (
    <>
      {/* ------------------------------------------------ ticker */}
      {!compact && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 w-[min(640px,50vw)] -translate-x-1/2">
          <div className={`${panel} overflow-hidden px-4 py-2 text-center text-[12px] tracking-wide text-[#f3dcb4]`}>
            <span key={tickIdx} className="inline-block animate-[venusfade_9s_ease-in-out]">
              {lines[tickIdx % lines.length]}
            </span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ altimeter */}
      <Altimeter world={world} compact={compact} preview={preview} />

      {/* ------------------------------------------------ resources */}
      <div className={`absolute right-3 top-3 z-10 ${compact ? "w-[184px]" : "w-[250px]"} ${panel} p-3 text-[#f3e3c8]`}>
        <div className={`flex ${compact ? "flex-col items-start gap-1" : "items-center justify-between"}`}>
          <div className={`font-venus ${compact ? "text-[19px]" : "text-[22px]"} max-w-full truncate leading-none text-[#ffe8bf]`}>{s.cityName}</div>
          <div className="flex items-center gap-1">
            <button onClick={() => postcard(world)} title="Send a postcard" className="mr-1 text-[12px] text-[#f6d28b]/70 hover:text-[#f6d28b]">📸</button>
            <button onClick={onMute} title={muted ? "Sound on" : "Sound off"} className="mr-1 text-[12px] text-[#f6d28b]/70 hover:text-[#f6d28b]">{muted ? "🔇" : "🔊"}</button>
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                onClick={() => world.setSpeed(n)}
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${world.speed === n ? "bg-[#f6d28b] text-[#2a160c]" : "text-[#f6d28b]/70 hover:text-[#f6d28b]"}`}
              >
                {n}×
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-[#f6d28b]/60">
          {d.sun > 0.5 ? "☀" : "☾"} Lap {d.circuits + 1} · day {d.earthDay.toFixed(1)}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Stat label="People" value={`${fmt(s.pop)}`} sub={`/${fmt(Math.min(d.housing, d.food))}`} warn={d.housing - s.pop < 3 || d.food - s.pop < 3} />
          <div title={`Comfort ${Math.round(d.comfort * 100)}% (temperature) · Food ${d.food >= s.pop ? "enough" : "short"} · Power ${Math.round(d.powered * 100)}%${d.dry ? " · out of water" : ""}`}>
            <Stat label="Happy" value={`${Math.round(d.happiness * 100)}%`} sub={d.comfort < 0.9 ? (d.air.tempC > 30 ? "too hot" : "too cold") : undefined} warn={d.happiness < 0.5} />
          </div>
          {RES.map((r) => (
            <Stat
              key={r.id}
              label={`${r.icon} ${r.label}`}
              value={fmt(s.res[r.id])}
              sub={rate(d.rates[r.id])}
              warn={(r.id === "air" && s.res.air < 20) || (r.id === "carbon" && s.res.carbon < 15)}
            />
          ))}
        </div>

        <div className="mt-2">
          <div className="flex justify-between text-[10px] uppercase tracking-[0.18em] text-[#f6d28b]/70">
            <span>⚡ Power {d.powered < 0.99 ? "· brownout" : ""}</span>
            <span>{rate(d.rates.power) || "±0"}</span>
          </div>
          <Bar v={d.batteryCap > 0 ? s.res.power / d.batteryCap : 0} color={d.powered < 0.99 ? "#ff7a5a" : "#ffd35a"} />
        </div>

        <div className="mt-2">
          <div className="flex justify-between text-[10px] uppercase tracking-[0.18em] text-[#f6d28b]/70">
            <span>Utopia</span>
            <span>{Math.round(d.utopia * 100)}%</span>
          </div>
          <Bar v={d.utopia} color="#ffb4d8" />
          {!compact && (
            <div className="mt-1 text-[10px] leading-snug text-[#f3e3c8]/50">
              {VICTORY.pop.toLocaleString()} people, {VICTORY.culture.toLocaleString()} culture, {Math.round(VICTORY.happiness * 100)}% happy.
            </div>
          )}
        </div>

        <button onClick={() => setShowPeers((v) => !v)} className="mt-2 w-full text-left text-[10px] uppercase tracking-[0.18em] text-[#9ff4ff]/80 hover:text-[#c8faff]">
          {peers.length ? `☁ ${peers.length} ${peers.length === 1 ? "city" : "cities"} alongside ${showPeers ? "▴" : "▾"}` : "☁ Nobody else on this wind yet"}
        </button>
        {showPeers && peers.length > 0 && (
          <div className="mt-1 flex max-h-[140px] flex-col gap-1 overflow-y-auto">
            {peers.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-[#fff1da]">{p.name} <span className="text-[#f3e3c8]/50">· {p.pop.toLocaleString()}</span></span>
                <button
                  onClick={() => world.gift(p.id)}
                  disabled={s.res.carbon < 40}
                  className="shrink-0 rounded-md border border-[#9ff4ff]/40 px-1.5 py-0.5 text-[10px] text-[#c8faff] hover:bg-[#9ff4ff]/15 disabled:opacity-35"
                  title="Send them 40 of your carbon. There is no scarcity up here."
                >
                  gift ◆40
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ hint */}
      {hint && !selected && !sim.event && !building && (
        <div className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 ${compact ? "bottom-[128px] w-[92vw]" : "bottom-[150px] w-[min(560px,60vw)]"}`}>
          <div className={`${panel} px-4 py-2 text-center text-[12.5px] text-[#ffe9c6]`}>{hint}</div>
        </div>
      )}

      {/* ------------------------------------------------ selected */}
      {selected && <TilePanel world={world} tile={selected} compact={compact} />}

      {/* ------------------------------------------------ build bar */}
      <BuildBar world={world} compact={compact} building={building} onHover={setHoverId} suggest={h?.act ?? null} />

    </>
  );
}

async function postcard(world: VenusWorld) {
  const url = world.postcard();
  const name = `${world.sim.s.cityName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "venus"}-postcard.jpg`;
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name, { type: "image/jpeg" });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: `Greetings from ${world.sim.s.cityName}`, text: "Everybody went to Mars. I went to Venus." });
      return;
    }
  } catch { /* fall through to a download */ }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[9.5px] uppercase tracking-[0.16em] text-[#f6d28b]/60">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums leading-tight ${warn ? "text-[#ff8a6a]" : "text-[#fff1da]"}`}>
        {value}
        {sub && <span className="ml-1 text-[10px] font-normal text-[#f3e3c8]/50">{sub}</span>}
      </div>
    </div>
  );
}

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: color }} />
    </div>
  );
}

/* ------------------------------------------------------------ altimeter */

const COL_LO = 44, COL_HI = 64;
const yOf = (alt: number) => 100 - ((Math.max(COL_LO, Math.min(COL_HI, alt)) - COL_LO) / (COL_HI - COL_LO)) * 100;

function Altimeter({ world, compact, preview }: { world: VenusWorld; compact: boolean; preview: ModuleId | null }) {
  const sim = world.sim;
  const pAlt = preview ? sim.previewAlt(preview) : null;
  const pAir = pAlt !== null ? airAt(pAlt) : null;
  const pOk = pAlt !== null && pAlt >= BAND.low && pAlt <= BAND.high;
  const s = sim.s, d = sim.d;
  const air = d.air;
  const trend = d.eqAlt - s.alt;
  const [trim, setTrim] = useState(s.trim);
  useEffect(() => setTrim(s.trim), [s.trim]);
  const zoneText = {
    cook: "Hull cooking",
    hot: "Too warm",
    band: "In the band",
    cold: "Chilly",
    freeze: "Freezing",
  }[d.zone];
  const zoneColor = { cook: "#ff5a3a", hot: "#ffa35a", band: "#9fffc8", cold: "#9fdcff", freeze: "#bfe0ff" }[d.zone];

  return (
    <div className={`absolute z-10 ${compact ? "left-2 top-[58px] w-[150px] p-2" : "left-3 top-[64px] w-[230px] p-3"} ${panel} text-[#f3e3c8]`}>
      <div className="flex gap-3">
        {/* the column */}
        <div className={`relative ${compact ? "h-[120px]" : "h-[190px]"} w-5 shrink-0 overflow-hidden rounded-full`}
          style={{
            background: `linear-gradient(to top, #ff3a14 0%, #ff7a2a ${yOfInv(HULL_STRESS_ALT)}%, #ffc070 ${yOfInv(BAND.low)}%, #b8f5c8 ${yOfInv(BAND.low) + 2}%, #b8f5c8 ${yOfInv(BAND.high) - 2}%, #9fdcff ${yOfInv(BAND.high)}%, #e8f4ff ${yOfInv(FREEZE_ALT)}%, #ffffff 100%)`,
          }}
        >
          <div className="absolute left-0 right-0 h-[2px] bg-[#1b0f0a]/60" style={{ top: `${yOf(d.eqAlt)}%` }} />
          {pAlt !== null && (
            <div className="absolute left-0 right-0 h-[3px] animate-pulse" style={{ top: `${yOf(pAlt)}%`, background: pOk ? "#1b6a3a" : "#ff3a14" }} />
          )}
          <div className="absolute -left-1 -right-1 h-[4px] rounded bg-[#1b0f0a] shadow-[0_0_0_2px_#fff]" style={{ top: `calc(${yOf(s.alt)}% - 2px)` }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] uppercase tracking-[0.2em] text-[#f6d28b]/60">Altitude</div>
          <div className={`${compact ? "text-[22px]" : "text-[34px]"} font-venus leading-none tabular-nums text-[#fff1da]`}>
            {s.alt.toFixed(1)}<span className="ml-1 text-[13px] text-[#f6d28b]/70">km</span>
          </div>
          <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: zoneColor }}>
            {Math.abs(trend) < 0.05 ? "holding" : trend > 0 ? `rising → ${d.eqAlt.toFixed(1)}` : `sinking → ${d.eqAlt.toFixed(1)}`}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] tabular-nums">
            <div><span className="text-[#f6d28b]/60">T </span>{air.tempC.toFixed(0)} °C</div>
            <div><span className="text-[#f6d28b]/60">P </span>{air.pressure.toFixed(2)} bar</div>
          </div>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: zoneColor }}>{zoneText}</div>
          {pAlt !== null && pAir && (
            <div className={`mt-1 text-[10.5px] leading-snug ${pOk ? "text-[#9fffc8]" : "text-[#ffb08a]"}`}>
              With a {MODULES[preview!].name}: → {pAlt.toFixed(1)} km, {pAir.tempC.toFixed(0)} °C{pOk ? "" : pAlt < BAND.low ? " · too hot" : " · too cold"}
            </div>
          )}
          {!compact && (
            <div className="mt-2 text-[10.5px] leading-snug text-[#f3e3c8]/65">
              Lift {fmt(d.lift * liftFactor(s.alt))} t · mass {fmt(d.mass)} t
            </div>
          )}
          {s.integrity < 0.999 && (
            <div className="mt-1.5">
              <div className="text-[9.5px] uppercase tracking-[0.2em] text-[#ff8a6a]">Hull {Math.round(s.integrity * 100)}%</div>
              <Bar v={s.integrity} color="#ff6a4a" />
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => world.dumpBallast()}
          disabled={s.res.water < 2}
          className="rounded-lg border border-[#9fdcff]/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#bfe8ff] hover:bg-[#9fdcff]/15 disabled:opacity-35"
          title="Let three quarters of the water go. Water is a tonne a unit."
        >
          {compact ? "Ballast" : "Dump ballast"}
        </button>
        {(
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[9.5px] uppercase tracking-[0.14em] text-[#f6d28b]/70" title="Pump air into every envelope (costs air) or vent it (free).">
            Trim
            <input
              type="range"
              min={-25}
              max={15}
              value={Math.round(trim * 100)}
              onChange={(e) => setTrim(Number(e.target.value) / 100)}
              onPointerUp={() => world.setTrim(trim)}
              onKeyUp={() => world.setTrim(trim)}
              className="h-1 w-full accent-[#f6d28b]"
            />
            {!compact && <span className="w-8 text-right tabular-nums">{Math.round(trim * 100)}%</span>}
          </label>
        )}
      </div>
      <button
        onClick={() => world.setWalk(true)}
        className="mt-2 w-full rounded-lg border border-[#9ff4ff]/35 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#c8faff] hover:bg-[#9ff4ff]/15"
        title="Goggles on. Go and stand on the deck."
      >
        🥽 Step outside
      </button>
    </div>
  );
}
function yOfInv(alt: number) { return 100 - yOf(alt); }

/* ------------------------------------------------------------ build bar */

function BuildBar({ world, compact, building, onHover, suggest }: { world: VenusWorld; compact: boolean; building: ModuleId | null; onHover: (id: ModuleId | null) => void; suggest: string | null }) {
  const sim = world.sim;
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 px-2 pb-2">
      {building && (
        <div className="mb-2 flex justify-center">
          <div className={`${panel} flex items-center gap-3 px-4 py-2 text-[12px] text-[#ffe9c6]`}>
            <span>{compact ? "Tap a glowing slot" : "Click a glowing slot"} to place the {MODULES[building].name}.</span>
            <button onClick={() => world.placeSuggested()} className="rounded-md bg-[#f6d28b] px-2 py-0.5 text-[11px] font-bold text-[#2a160c]">Place here</button>
            <button onClick={() => world.setBuild(null)} className="text-[11px] uppercase tracking-[0.14em] text-[#f6d28b]/70 hover:text-white">Cancel</button>
          </div>
        </div>
      )}
      <div
        className="mx-auto flex max-w-[1520px] gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]"
        style={{ maskImage: "linear-gradient(to right, black 92%, transparent)", WebkitMaskImage: "linear-gradient(to right, black 92%, transparent)" }}
        onMouseLeave={() => onHover(null)}
        onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
      >
        {BUILDABLE.map((id) => {
          const m = MODULES[id];
          const why = sim.whyNot(id);
          const locked = !!m.unlockPop && sim.s.pop < m.unlockPop;
          const on = building === id;
          const net = m.lift - m.mass;
          return (
            <button
              key={id}
              onClick={() => world.setBuild(on ? null : id)}
              onMouseEnter={() => onHover(id)}
              disabled={!!why && !on}
              title={`${m.name}: ${m.detail}${why ? `\n\n${why}` : ""}`}
              className={`group relative shrink-0 ${compact ? "w-[92px] p-1.5" : "w-[104px] p-2"} rounded-xl border text-left transition ${
                on ? "border-[#fff] bg-[#f6d28b]/25" : suggest === id && !why ? "border-[#9fffc8] bg-[#1b0f0a]/60" : "border-[#f6d28b]/20 bg-[#1b0f0a]/60 hover:border-[#f6d28b]/60"
              } backdrop-blur-md disabled:opacity-30 disabled:grayscale`}
              style={suggest === id && !why && !on ? { animation: "venuspulse 1.8s infinite" } : undefined}
            >
              <div className="flex items-center justify-between">
                <span className={compact ? "text-[18px]" : "text-[22px]"}>{locked ? "🔒" : m.icon}</span>
                <span className={`text-[10px] font-semibold tabular-nums ${net >= 0 ? "text-[#9fffc8]" : "text-[#ffb08a]"}`}>
                  {net >= 0 ? "▲" : "▼"}{Math.abs(net)}t
                </span>
              </div>
              <div className="mt-0.5 truncate text-[11.5px] font-semibold text-[#fff1da]">{m.name}</div>
              {!compact && <div className="truncate text-[10px] text-[#f3e3c8]/55">{m.line}</div>}
              <div className="mt-0.5 flex gap-1.5 text-[10px] tabular-nums text-[#f6d28b]/85">
                {locked ? <span>{m.unlockPop} people</span> : Object.entries(m.cost).map(([k, v]) => (
                  <span key={k} className={sim.s.res[k as ResourceId] < (v as number) ? "text-[#ff8a6a]" : ""}>
                    {({ carbon: "◆", air: "○", science: "✦", water: "≈", power: "⚡", culture: "♪" } as Record<string, string>)[k]}{v}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- tile panel */

function TilePanel({ world, tile, compact }: { world: VenusWorld; tile: Tile; compact: boolean }) {
  const sim = world.sim;
  const m = MODULES[tile.id];
  const L = tile.level ?? 1;
  const up = sim.whyNotUpgrade(tile.q, tile.r);
  const cost = useMemo(() => sim.upgradeCost(tile), [sim, tile, L]);
  const [confirm, setConfirm] = useState(false);
  const orphans = sim.wouldOrphan(tile.q, tile.r);
  const leaving = tile.leaving ? Math.max(0, Math.ceil(tile.leaving - sim.s.t)) : 0;
  const lines: string[] = [];
  if (m.housing) lines.push(`Houses ${m.housing * L}`);
  if (m.food) lines.push(`Feeds ${m.food * L}`);
  if (m.lift) lines.push(`Lift ${m.lift * L} t`);
  lines.push(`Mass ${m.mass * L} t`);
  if (m.power) lines.push(`${m.power > 0 ? "+" : ""}${m.power * L} ⚡`);
  if (m.solar) lines.push(`+${m.solar * L} ⚡ in daylight`);
  for (const [k, v] of Object.entries(m.makes ?? {})) lines.push(`+${((v as number) * L).toFixed(1)} ${k}/s`);
  return (
    <div className={`absolute z-20 ${compact ? "inset-x-2 bottom-[112px]" : "right-3 top-[340px] w-[250px]"} ${panel} p-3 text-[#f3e3c8]`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[22px]">{m.icon}</div>
          <div className="font-venus text-[20px] leading-tight text-[#ffe8bf]">{m.name}</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[#f6d28b]/60">Level {L} of {tile.id === "core" ? MAX_LEVEL : MAX_LEVEL}</div>
        </div>
        <button onClick={() => world.deselect()} className="text-[#f6d28b]/60 hover:text-white">✕</button>
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-[#f3e3c8]/75">{m.detail}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-[#fff1da]/85">
        {lines.map((l) => <span key={l}>{l}</span>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          onClick={() => world.upgradeSelected()}
          disabled={!!up}
          className="rounded-lg bg-[#f6d28b] px-2.5 py-1 text-[11px] font-bold text-[#2a160c] disabled:opacity-40"
          title={up ?? "Grow it: everything it does, doubled or tripled. Including its weight."}
        >
          {L >= MAX_LEVEL ? "Fully grown" : `Grow · ${Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(", ")}`}
        </button>
        {tile.id !== "core" && leaving > 0 && (
          <div className="text-[11px] text-[#ffcf9a]">Winching off… {leaving}s. Still weighs until it's gone. Cut it to drop it now.</div>
        )}
        {tile.id !== "core" && (
          <>
            {!leaving && <button onClick={() => world.recycleSelected()} className="rounded-lg border border-[#f6d28b]/40 px-2.5 py-1 text-[11px] text-[#f6d28b] hover:bg-[#f6d28b]/10" title="Winch it off over 25 seconds and get half the carbon back. It still weighs while it goes.">
              Recycle
            </button>}
            {confirm ? (
              <button onClick={() => world.cutSelected()} className="rounded-lg bg-[#ff5a3a] px-2.5 py-1 text-[11px] font-bold text-white">
                Drop it. Sure.
              </button>
            ) : (
              <button onClick={() => setConfirm(true)} className="rounded-lg border border-[#ff7a5a]/60 px-2.5 py-1 text-[11px] text-[#ff9a7a] hover:bg-[#ff5a3a]/15" title="Cut the tether. Its whole mass is gone this instant, and so is it. The emergency button.">
                Cut loose
              </button>
            )}
          </>
        )}
      </div>
      {up && L < MAX_LEVEL && <div className="mt-1.5 text-[10.5px] text-[#ff9a7a]">{up}</div>}
      {orphans > 0 && tile.id !== "core" && (
        <div className="mt-1.5 text-[10.5px] text-[#ffb08a]">Careful: {orphans} {orphans === 1 ? "module hangs" : "modules hang"} off this one and would go with it.</div>
      )}
    </div>
  );
}

export { GOLD };
