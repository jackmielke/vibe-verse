/**
 * Dragon's Breath — ring three bells while the mountain throws fire.
 *
 * The fireballs are the world's own system, turned on and made angrier
 * over time. Rain puts them out, and the dragon boils the rain off after a
 * dozen seconds, so weather is a resource rather than a cheat. Bells hang
 * at the bridge, the torii and the shrine; walk up and hit one (a bolt
 * works) to ring it.
 */
import * as THREE from "three";
import { LANDMARKS } from "../../tools";
import type { GameContext, GameHud, GameMode } from "../types";

interface Bell { mesh: THREE.Group; x: number; z: number; rung: boolean; name: string }

export function createDragon(): GameMode {
  let ctx: GameContext | null = null;
  const bells: Bell[] = [];
  let elapsed = 0;
  let rainClock = 0;
  let over = false, won = false;
  let lastNotify = 0;
  const bellMat = new THREE.MeshStandardMaterial({ color: "#c9a04a", metalness: 0.7, roughness: 0.3 });
  const frameMat = new THREE.MeshStandardMaterial({ color: "#3b2818", roughness: 0.9 });
  const holder = new THREE.Group();

  function makeBell(name: string, x: number, z: number) {
    if (!ctx) return;
    const g = new THREE.Group();
    const post1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 0.2), frameMat); post1.position.set(-1, 1.5, 0);
    const post2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 0.2), frameMat); post2.position.set(1, 1.5, 0);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 0.3), frameMat); beam.position.y = 3;
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 0.9, 12), bellMat); bell.position.y = 2.3;
    const light = new THREE.PointLight("#ffd27a", 1.5, 8, 2); light.position.y = 2.3;
    g.add(post1, post2, beam, bell, light);
    g.position.set(x, ctx.heightAt(x, z), z);
    holder.add(g);
    bells.push({ mesh: g, x, z, rung: false, name });
  }

  const hud = (): GameHud => ({
    mode: "dragon", title: "Dragon's Breath",
    objective: over ? (won ? "The mountain sleeps." : "The dragon won this one.") : `Ring the bells: ${bells.filter((b) => b.rung).length} / 3 · next: ${bells.find((b) => !b.rung)?.name ?? ""}`,
    score: won ? Math.max(0, Math.round(600 - elapsed)) : bells.filter((b) => b.rung).length * 100,
    hearts: 0, maxHearts: 5, timer: null,
    detail: `${Math.round(elapsed)}s · fire rate ${(ctx?.state().fireballs.rate ?? 0).toFixed(1)}/s`,
    over, won, shield: 0, blast: 0,
  });

  function ring(b: Bell) {
    if (!ctx || b.rung) return;
    b.rung = true;
    ctx.sound("bell");
    ctx.burst("sparkle", b.x, ctx.heightAt(b.x, b.z) + 2, b.z);
    ctx.toast(`${b.name} bell rung`);
    const left = bells.filter((x) => !x.rung).length;
    if (left === 0) {
      over = true; won = true;
      ctx.patch({ fireballs: { on: false, rate: 0.6 } });
      ctx.emote("Dance");
      ctx.caption("Three bells. The mountain is asleep again.");
      ctx.notify("The visitor rang all three bells and the dragon went back to sleep. Celebrate in one line.");
    } else {
      ctx.caption(`${b.name} bell rung. ${left} to go.`);
      ctx.notify(`The ${b.name} bell is rung, ${left} left. Point the visitor to the next one in one line.`);
    }
  }

  return {
    id: "dragon", title: "Dragon's Breath", blurb: "",
    start(c) {
      ctx = c; elapsed = 0; rainClock = 0; over = false; won = false;
      c.scene.add(holder);
      makeBell("bridge", LANDMARKS.bridge.x - 6, LANDMARKS.bridge.z + 5);
      makeBell("torii", LANDMARKS.torii.x + 4, LANDMARKS.torii.z + 3);
      makeBell("shrine", LANDMARKS.shrine.x + 5, LANDMARKS.shrine.z + 4);
      c.patch({ fireballs: { on: true, rate: 0.5 }, weather: "clear" });
      c.sound("roar");
      c.caption("The mountain is awake. Three bells: bridge, torii, shrine. Run!");
      c.emote("No");
    },
    update(dt) {
      if (!ctx || over) return;
      elapsed += dt;
      const s = ctx.state();
      const rate = Math.min(3, 0.5 + elapsed / 45);
      if (Math.abs(s.fireballs.rate - rate) > 0.05 || !s.fireballs.on) ctx.patch({ fireballs: { on: true, rate } });
      // The dragon boils the rain off.
      if (s.weather === "rain" || s.weather === "storm" || s.weather === "snow") {
        rainClock += dt;
        if (rainClock > 12) {
          rainClock = 0;
          ctx.patch({ weather: "clear" });
          ctx.sound("roar");
          ctx.burst("smoke", ctx.player.position.x, ctx.player.position.y + 2, ctx.player.position.z);
          if (ctx.time() - lastNotify > 8) { lastNotify = ctx.time(); ctx.notify("The dragon just boiled the rain away with a roar; the fireballs are back. One dramatic line."); }
        }
      } else rainClock = 0;
      const p = ctx.player.position;
      for (const b of bells) {
        if (b.rung) continue;
        b.mesh.rotation.y += dt * 0.4;
        if (Math.hypot(b.x - p.x, b.z - p.z) < 2.2) ring(b);
      }
    },
    stop() {
      for (const b of bells) holder.remove(b.mesh);
      bells.length = 0;
      holder.parent?.remove(holder);
      ctx?.patch({ fireballs: { on: false, rate: 0.6 } });
      ctx = null;
    },
    hud,
    onBoltLand(x, _y, z) {
      for (const b of bells) if (!b.rung && Math.hypot(b.x - x, b.z - z) < 3) ring(b);
    },
    onPlayerHit() { return false; },
  };
}
