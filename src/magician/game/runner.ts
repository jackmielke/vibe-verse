/**
 * The game runner: one mode at a time, hearts, Vibey's two big spells, and
 * Vibey's own aim.
 *
 * Shared across modes so each mode stays about its rules:
 *  - five hearts; an oni swing or a fireball takes one unless a shield is
 *    up; zero ends the mode
 *  - `shield` (12 s of immunity, 25 s cooldown) and `blast` (everything
 *    within 9 m dies, 30 s cooldown), which are tools Vibey can cast when
 *    asked
 *  - Vibey shoots at the nearest enemy within 18 m every couple of seconds,
 *    which is what makes it an ally rather than a narrator
 */
import * as THREE from "three";
import { createEnemies, type Enemies, type Enemy } from "./enemies";
import { createBolts, type Bolts } from "./bolts";
import type { GameContext, GameHud, GameMode, GameModeId } from "./types";
import { MODE_INFO } from "./types";
import { createSiege } from "./modes/siege";
import { createSpirits } from "./modes/spirits";
import { createDragon } from "./modes/dragon";

export interface GameRunner {
  enemies: Enemies;
  bolts: Bolts;
  start(id: GameModeId): void;
  stop(): void;
  active(): GameModeId | null;
  hud(): GameHud | null;
  /** The player fires from a point in a direction. */
  fire(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** A fireball or enemy hit the player. Returns true if the mode is running and absorbed or counted it. */
  playerHit(): boolean;
  shield(): string;
  blast(): string;
  update(dt: number, time: number, lanterns: Array<{ x: number; z: number }>): void;
  /** A siege house was swung at. */
  dispose(): void;
}

export interface HouseState { x: number; z: number; group: THREE.Group; hp: number; alive: boolean; fire: THREE.Group | null }

const SHIELD_TIME = 12, SHIELD_CD = 25, BLAST_CD = 30;

export function createGameRunner(base: Omit<GameContext, "enemies" | "bolts" | "houses"> & { houses: HouseState[] }): GameRunner {
  const enemies = createEnemies();
  const bolts = createBolts();
  base.scene.add(enemies.group, bolts.group);
  let mode: GameMode | null = null;
  let hearts = 5;
  let shieldLeft = 0, shieldCd = 0, blastCd = 0;
  let vibeyAim = 0;
  let hitFlash = 0;
  const ctx: GameContext = { ...base, enemies, bolts, houses: base.houses };

  // A visible shield: a soft sphere around the player.
  const shieldMat = new THREE.MeshBasicMaterial({ color: "#8dffc8", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(1.6, 18, 12), shieldMat);
  shieldMesh.visible = false;
  base.scene.add(shieldMesh);

  const fireMat = new THREE.MeshBasicMaterial({ color: "#ff8a2a", transparent: true, opacity: 0.9 });
  const flameGeo = new THREE.ConeGeometry(0.5, 1.6, 6);
  function setHouseFire(h: HouseState, on: boolean) {
    if (on && !h.fire) {
      const g = new THREE.Group();
      for (let i = 0; i < 5; i++) { const f = new THREE.Mesh(flameGeo, fireMat); f.position.set((Math.random() - 0.5) * 2.5, 3.4 + Math.random() * 0.6, (Math.random() - 0.5) * 2); g.add(f); }
      const l = new THREE.PointLight("#ff8a2a", 3, 12, 2); l.position.y = 3.5; g.add(l);
      h.group.add(g);
      h.fire = g;
    } else if (!on && h.fire) { h.group.remove(h.fire); h.fire = null; }
  }

  function onDeath(e: Enemy, cause: string) {
    base.burst("smoke", e.position.x, e.position.y + 1, e.position.z);
    base.sound(cause === "weather" ? "fizz" : "pop");
    mode?.onKill?.(e.kind);
    if (cause === "lightning") base.toast("⚡ lightning strike");
    if (cause === "flood") base.toast("drowned");
  }

  const runner: GameRunner = {
    enemies, bolts,
    start(id) {
      runner.stop();
      mode = id === "siege" ? createSiege() : id === "spirits" ? createSpirits() : createDragon();
      hearts = 5; shieldLeft = 0; shieldCd = 0; blastCd = 0;
      for (const h of base.houses) { h.hp = 3; h.alive = true; setHouseFire(h, false); h.group.visible = true; }
      mode.start(ctx);
      base.toast(`${MODE_INFO[id].emoji} ${MODE_INFO[id].title}`);
    },
    stop() {
      if (!mode) return;
      mode.stop();
      mode = null;
      enemies.clear();
      for (const h of base.houses) { setHouseFire(h, false); h.alive = true; h.hp = 3; h.group.visible = true; }
      shieldMesh.visible = false;
    },
    active: () => mode?.id ?? null,
    hud() {
      if (!mode) return null;
      const h = mode.hud();
      return { ...h, hearts, shield: shieldLeft > 0 ? shieldLeft : -shieldCd, blast: -blastCd };
    },
    fire(origin, dir) {
      bolts.fire(origin, dir, "player");
      base.sound("whoosh");
      mode?.onBolt?.();
    },
    playerHit() {
      if (!mode) return false;
      const h = mode.hud();
      if (h.over) return true;
      if (shieldLeft > 0) { base.sound("chime"); return true; }
      if (mode.onPlayerHit?.()) return true;
      hearts--;
      hitFlash = 1;
      base.sound("hit");
      if (hearts <= 0) {
        hearts = 0;
        // Let the mode know it is over by ending it from outside: modes read
        // `hearts` through the runner's hud, so we stop enemies and flag.
        base.caption("Down… but the valley remembers you. Again?");
        base.notify("The visitor lost all their hearts and the game is over. One kind line and offer to play again.");
        const m = mode;
        // Freeze the mode: stop spawning by stopping it, but keep the HUD.
        finalHud = { ...m.hud(), over: true, won: false, hearts: 0 };
        m.stop();
        mode = frozen(finalHud);
        enemies.clear();
      }
      return true;
    },
    shield() {
      if (!mode) return "No game is running; shields are for games.";
      if (shieldCd > 0) return `The shield is recharging, ${Math.ceil(shieldCd)} seconds to go.`;
      shieldLeft = SHIELD_TIME; shieldCd = SHIELD_CD;
      shieldMesh.visible = true;
      base.sound("chime");
      base.toast("🛡 shield");
      return `Shield up for ${SHIELD_TIME} seconds.`;
    },
    blast() {
      if (!mode) return "No game is running; blasts are for games.";
      if (blastCd > 0) return `The blast is recharging, ${Math.ceil(blastCd)} seconds to go.`;
      blastCd = BLAST_CD;
      const p = base.player.position;
      let n = 0;
      for (const e of enemies.alive()) if (e.position.distanceTo(p) < 9) { e.hp = 0; n++; }
      base.burst("flash", p.x, p.y + 1, p.z);
      base.sound("thunder");
      base.toast("💥 blast");
      return `Blast! ${n} enem${n === 1 ? "y" : "ies"} gone.`;
    },
    update(dt, time, lanterns) {
      shieldLeft = Math.max(0, shieldLeft - dt);
      shieldCd = Math.max(0, shieldCd - dt);
      blastCd = Math.max(0, blastCd - dt);
      hitFlash = Math.max(0, hitFlash - dt * 3);
      const p = base.player.position;
      shieldMesh.position.set(p.x, p.y + 1, p.z);
      shieldMesh.visible = shieldLeft > 0;
      shieldMat.opacity = shieldLeft > 0 ? 0.18 + Math.sin(time * 6) * 0.06 : 0;
      if (!mode) return;
      mode.update(dt);
      const s = base.state();
      enemies.update(dt, time, {
        state: s, player: p, heightAt: base.heightAt,
        houses: base.houses.map((h) => ({ x: h.x, z: h.z, alive: h.alive })),
        lanterns, lightning: base.lightning(),
        events: {
          onDeath,
          onPlayerHit: () => { runner.playerHit(); },
          onHouseHit: (_e, i) => {
            const h = base.houses[i];
            if (!h || !h.alive) return;
            h.hp--;
            setHouseFire(h, true);
            base.sound("hit");
            if (h.hp <= 0) {
              h.alive = false;
              h.group.visible = false;
              setHouseFire(h, false);
              base.burst("smoke", h.x, base.heightAt(h.x, h.z) + 2, h.z);
              base.toast("a house burned");
              base.notify("An oni just burned a village house down. One urgent line.");
              if (base.houses.every((x) => !x.alive)) {
                const m = mode;
                if (m) { finalHud = { ...m.hud(), over: true, won: false, hearts }; m.stop(); mode = frozen(finalHud); enemies.clear(); }
                base.caption("The village is gone. We will rebuild. Again?");
              }
            }
          },
        },
      });
      bolts.update(dt, enemies, base.heightAt,
        (e, owner) => { e.takeHit(owner === "player" ? 1 : 1); base.burst("sparkle", e.position.x, e.position.y + 1.2, e.position.z); },
        (x, y, z) => { mode?.onBoltLand?.(x, y, z); });
      // Vibey's aim.
      vibeyAim -= dt;
      if (vibeyAim <= 0) {
        vibeyAim = 1.8;
        const from = base.vibey();
        const target = enemies.nearest(from, 18);
        if (target) {
          const o = from.clone(); o.y += 1.3;
          const d = target.position.clone(); d.y += 1.2; d.sub(o);
          bolts.fire(o, d, "vibey");
          base.emote("Punch");
        }
      }
    },
    dispose() {
      runner.stop();
      base.scene.remove(enemies.group, bolts.group, shieldMesh);
      enemies.dispose();
      bolts.dispose();
      shieldMat.dispose();
      shieldMesh.geometry.dispose();
      fireMat.dispose();
      flameGeo.dispose();
    },
  };
  let finalHud: GameHud | null = null;
  function frozen(h: GameHud): GameMode {
    return { id: h.mode ?? "siege", title: h.title, blurb: "", start() {}, update() {}, stop() {}, hud: () => h };
  }
  return runner;
}
