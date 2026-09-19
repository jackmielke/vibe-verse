/**
 * Spirit Lights — gather thirty lights while a yurei hunts you.
 *
 * The lights are small glowing orbs on the ground within sixty metres.
 * Walk into one, or pop it with a bolt from a distance. The yurei drifts at
 * you, and when it touches you three of your lights scatter and it backs
 * off. It cannot see you in fog and will not enter a lit lantern's glow,
 * which is the whole reason to ask Vibey for either.
 */
import * as THREE from "three";
import type { GameContext, GameHud, GameMode } from "../types";
import type { Enemy } from "../enemies";

const TOTAL = 30;
const TIME = 120;

export function createSpirits(): GameMode {
  let ctx: GameContext | null = null;
  const lights: Array<{ mesh: THREE.Mesh; light: THREE.PointLight; alive: boolean; phase: number }> = [];
  let collected = 0;
  let timer = TIME;
  let over = false, won = false;
  let yurei: Enemy | null = null;
  let stolenCooldown = 0;
  const geo = new THREE.SphereGeometry(0.28, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ color: "#ffe9a0" });
  const holder = new THREE.Group();

  function place(x: number, z: number) {
    if (!ctx) return;
    const m = new THREE.Mesh(geo, mat);
    const l = new THREE.PointLight("#ffd27a", 1.2, 6, 2);
    m.add(l);
    m.position.set(x, ctx.heightAt(x, z) + 0.9, z);
    holder.add(m);
    lights.push({ mesh: m, light: l, alive: true, phase: Math.random() * 10 });
  }

  const hud = (): GameHud => ({
    mode: "spirits", title: "Spirit Lights",
    objective: over ? (won ? "Every light is home." : `Time. ${collected} of ${TOTAL} lights gathered.`) : `Gather the lights: ${collected} / ${TOTAL}`,
    score: collected * 10 + (won ? Math.round(timer) * 2 : 0),
    hearts: 0, maxHearts: 5, timer: over ? null : timer,
    detail: ctx && yurei && !yurei.dead ? `the yurei is ${Math.round(yurei.position.distanceTo(ctx.player.position))} m away` : "",
    over, won, shield: 0, blast: 0,
  });

  return {
    id: "spirits", title: "Spirit Lights", blurb: "",
    start(c) {
      ctx = c; collected = 0; timer = TIME; over = false; won = false;
      c.scene.add(holder);
      const p = c.player.position;
      for (let i = 0; i < TOTAL; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 8 + Math.sqrt(Math.random()) * 55;
        place(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
      }
      yurei = c.enemies.spawn("yurei", p.x + 40, p.z + 40);
      yurei.targetKind = "player";
      c.caption("Thirty lights, two minutes, and something hungry. Go!");
      c.emote("Jump");
      c.sound("bell");
    },
    update(dt) {
      if (!ctx || over) return;
      timer -= dt;
      stolenCooldown = Math.max(0, stolenCooldown - dt);
      const p = ctx.player.position;
      const t = ctx.time();
      for (const l of lights) {
        if (!l.alive) continue;
        l.mesh.position.y += Math.sin(t * 2 + l.phase) * 0.004;
        l.light.intensity = 1 + Math.sin(t * 3 + l.phase) * 0.4;
        if (Math.hypot(l.mesh.position.x - p.x, l.mesh.position.z - p.z) < 1.6) {
          l.alive = false; l.mesh.visible = false; collected++;
          ctx.sound("pop");
          ctx.burst("sparkle", l.mesh.position.x, l.mesh.position.y, l.mesh.position.z);
          if (collected % 10 === 0) ctx.notify(`The visitor has ${collected} of ${TOTAL} spirit lights with ${Math.round(timer)} seconds left. One encouraging line.`);
        }
      }
      if (collected >= TOTAL) { over = true; won = true; ctx.sound("chime"); ctx.emote("Dance"); ctx.caption("Every light is home. You are quick."); ctx.notify("The visitor gathered all thirty spirit lights. Celebrate in one line."); }
      else if (timer <= 0) { over = true; won = false; timer = 0; ctx.caption(`Time. ${collected} of ${TOTAL}. Again?`); ctx.notify(`Time ran out in Spirit Lights with ${collected} of ${TOTAL} gathered. Console the visitor in one line and offer another go.`); }
    },
    stop() {
      for (const l of lights) holder.remove(l.mesh);
      lights.length = 0;
      holder.parent?.remove(holder);
      ctx?.enemies.clear();
      yurei = null;
      ctx = null;
    },
    hud,
    onPlayerHit() {
      // The yurei steals lights rather than hearts, and retreats.
      if (!ctx || stolenCooldown > 0) return true;
      stolenCooldown = 4;
      const lost = Math.min(3, collected);
      collected -= lost;
      const p = ctx.player.position;
      for (let i = 0; i < lost; i++) { const a = Math.random() * Math.PI * 2; place(p.x + Math.cos(a) * 9, p.z + Math.sin(a) * 9); }
      ctx.sound("hit");
      ctx.burst("smoke", p.x, p.y + 1, p.z);
      if (yurei) { yurei.position.x += (yurei.position.x - p.x) * 3; yurei.position.z += (yurei.position.z - p.z) * 3; }
      ctx.notify(`The yurei caught the visitor and scattered ${lost} lights. One quick line: suggest fog or lanterns to shake it.`);
      return true;
    },
    onBoltLand(x, _y, z) {
      for (const l of lights) {
        if (!l.alive) continue;
        if (Math.hypot(l.mesh.position.x - x, l.mesh.position.z - z) < 2.2) { l.alive = false; l.mesh.visible = false; collected++; ctx?.sound("pop"); ctx?.burst("sparkle", l.mesh.position.x, l.mesh.position.y, l.mesh.position.z); }
      }
    },
  };
}
