/**
 * Oni Siege — five waves on the village.
 *
 * Oni come from the torii and the hill path and go for the nearest standing
 * house; a house takes three swings and then burns. Every third oni is a
 * fire oni, which is the point: ask Vibey for rain and they hiss out. The
 * player's bolts do the rest, and Vibey's.
 */
import { LANDMARKS } from "../../tools";
import type { GameContext, GameHud, GameMode } from "../types";

const WAVES = 5;

export function createSiege(): GameMode {
  let ctx: GameContext | null = null;
  let wave = 0;
  let toSpawn = 0;
  let spawnTimer = 0;
  let between = 3;
  let kills = 0;
  let over = false, won = false;
  let lastNotify = 0;

  const standing = () => ctx?.houses.filter((h) => h.alive).length ?? 0;

  const hud = (): GameHud => ({
    mode: "siege", title: "Oni Siege",
    objective: over ? (won ? "The village stands. Well fought." : "The village has fallen.") : between > 0 ? `Wave ${Math.min(WAVES, wave + 1)} in ${Math.ceil(between)}…` : `Wave ${wave} of ${WAVES}: ${toSpawn + (ctx?.enemies.alive().length ?? 0)} oni left`,
    score: kills * 10 + (over && won ? standing() * 50 : 0),
    hearts: 0, maxHearts: 5, wave, waves: WAVES, timer: null,
    detail: `${standing()}/${ctx?.houses.length ?? 0} houses standing`,
    over, won, shield: 0, blast: 0,
  });

  function say(text: string) {
    if (!ctx) return;
    const now = ctx.time();
    if (now - lastNotify < 6) return;
    lastNotify = now;
    ctx.notify(text);
  }

  function startWave() {
    if (!ctx) return;
    wave++;
    toSpawn = 3 + wave * 2;
    spawnTimer = 0;
    ctx.sound("gong");
    ctx.toast(`wave ${wave}`);
    say(`Wave ${wave} of ${WAVES} is starting: ${toSpawn} oni coming from the torii and the hill. Rally the visitor in one line.`);
  }

  function spawnOne() {
    if (!ctx) return;
    const from = Math.random() < 0.5 ? LANDMARKS.torii : LANDMARKS.hilltop;
    const x = from.x + (Math.random() - 0.5) * 8, z = from.z + (Math.random() - 0.5) * 8;
    const kind = (toSpawn % 3 === 0) ? "fireoni" : "oni";
    const e = ctx.enemies.spawn(kind, x, z);
    // Go for the nearest standing house.
    let best = -1, bd = Infinity;
    ctx.houses.forEach((h, i) => { if (!h.alive) return; const d = Math.hypot(h.x - x, h.z - z); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { e.targetKind = "house"; e.targetIndex = best; } else e.targetKind = "player";
  }

  return {
    id: "siege", title: "Oni Siege", blurb: "",
    start(c) {
      ctx = c; wave = 0; kills = 0; over = false; won = false; between = 4; toSpawn = 0;
      c.patch({ fireballs: { on: false, rate: 0.6 } });
      c.caption("Oni at the gate! Shoot them, and tell me what weather you want.");
      c.emote("Punch");
      c.sound("gong");
    },
    update(dt) {
      if (!ctx || over) return;
      if (between > 0) {
        between -= dt;
        if (between <= 0) startWave();
        return;
      }
      if (toSpawn > 0) {
        spawnTimer -= dt;
        if (spawnTimer <= 0) { spawnTimer = 1.4; toSpawn--; spawnOne(); }
      } else if (ctx.enemies.alive().length === 0) {
        if (wave >= WAVES) { over = true; won = true; ctx.sound("chime"); ctx.emote("Dance"); ctx.caption("We did it! The village stands."); ctx.notify("The visitor won Oni Siege: all five waves beaten. Celebrate in one line."); }
        else { between = 6; ctx.caption(`Wave ${wave} cleared. Breathe.`); }
      }
    },
    stop() {
      ctx?.enemies.clear();
      ctx = null;
    },
    hud,
    onKill() { kills++; },
    onPlayerHit() { return false; },
  };
}
