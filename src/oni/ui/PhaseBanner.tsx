/**
 * The round, in one box at the top of the screen: waiting, the count-in,
 * the clock and who is left, or who won. Shared by /zombies, its projector and
 * the game of tag in the Magician's valley.
 */
import type { Hud } from "@/oni/world/Oni";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function PhaseBanner({ hud, big }: { hud: Hud | null; big: boolean }) {
  if (!hud) return null;
  const meOni = !!hud.me?.oni;
  const t = big ? "text-5xl" : "text-2xl sm:text-3xl";
  const box = `rounded-2xl bg-black/45 backdrop-blur text-center ${big ? "px-8 py-4" : "px-4 py-2"}`;
  if (hud.phase === "lobby") {
    return (
      <div className={box}>
        <div className={`${big ? "text-2xl" : "text-sm"} font-semibold`}>
          {hud.players.length < 2 ? "Waiting for players" : hud.nextIn !== null ? `First round in ${Math.ceil(hud.nextIn)}s` : "Get ready"}
        </div>
        {!big && hud.players.length < 2 && <div className="text-[11px] text-white/55">Tap invite and get a friend in, or practice against bots</div>}
      </div>
    );
  }
  if (hud.phase === "countdown") {
    const oniNames = hud.players.filter((p) => p.oni).map((p) => (p.me ? "you" : p.name));
    return (
      <div className={`${box} ${meOni ? "bg-[#2f7a22]/85" : ""}`}>
        <div className={`${t} font-bold tabular-nums`}>{Math.ceil(hud.countdown)}</div>
        <div className={big ? "text-xl" : "text-sm"}>{hud.me ? (meOni ? "You're the zombie! 🧟 Wait for it…" : `Run! The zombie is ${oniNames.join(" and ")}`) : `The zombie is ${oniNames.join(" and ")}`}</div>
      </div>
    );
  }
  if (hud.phase === "play") {
    return (
      <div className={`${box} ${meOni ? "bg-[#2f7a22]/80" : ""}`}>
        <div className={`${t} font-bold tabular-nums`}>{fmt(Math.ceil(hud.left))}</div>
        <div className={`${big ? "text-lg" : "text-xs"} flex items-center justify-center gap-3`}>
          <span>🏃 {hud.runners}</span><span>🧟 {hud.onis}</span>
          {hud.me && <span className="font-semibold">{meOni ? "get them!" : "don't get bitten"}</span>}
        </div>
      </div>
    );
  }
  const r = hud.result;
  return (
    <div className={box}>
      <div className={`${big ? "text-3xl" : "text-lg"} font-bold`}>
        {r?.lastStanding ? `🏆 ${r.lastStanding} ${r.lastStanding === "You" ? "were" : "was"} the last human standing` : r?.survivors.length ? `🏆 ${r.survivors.join(", ")} survived!` : "Round over"}
      </div>
      <div className={`${big ? "text-lg" : "text-xs"} text-white/70`}>
        {r?.lastStanding ? `lasted ${Math.round(r.survived)}s` : ""}{r?.topOni ? `${r.lastStanding ? " · " : ""}top zombie: ${r.topOni} (${r.topCount})` : ""}
        {hud.nextIn !== null ? ` · next round in ${Math.ceil(hud.nextIn)}s` : ""}
      </div>
    </div>
  );
}
