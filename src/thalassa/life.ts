/**
 * What is alive: townsfolk strolling the quay and the terrace street, gulls
 * wheeling over the bay, sheep on the hills, and dolphins that break the
 * surface out by the island.
 *
 * The townsfolk are the roster's own characters (the same Quaternius cast
 * every world uses), loaded once per model and cloned with their skeletons,
 * so a dozen people cost a handful of downloads.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { makeRng } from "@/shared/proc/rng";
import { characterUrl } from "./assets";
import { mergeStatic } from "./kit";
import { ACROPOLIS, Ground, groundType, heightAt, offsetLine, quayWidth, sBay, slopeAt, townMask, inTown } from "./map";
import type { BuildCtx, FrameCtx, Part } from "./types";

const FOLK = ["Worker_Female", "Chef_Male", "OldClassy_Male", "Pirate_Male", "Casual2_Female", "Worker_Male", "Kimono_Female", "OldClassy_Female", "Viking_Male", "Pirate_Female"];

interface Walker {
  path: Array<{ x: number; z: number }>;
  s: number; // index-space position along the path
  dir: 1 | -1;
  speed: number;
  pause: number;
  holder: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  walk: THREE.AnimationAction | null;
  idle: THREE.AnimationAction | null;
}

export function createLife(ctx: BuildCtx): Part {
  const rng = makeRng("thalassa-life");
  const r = () => rng.next();
  const group = new THREE.Group();
  group.name = "life";
  const lite = ctx.quality.tier !== "desktop";
  let cancelled = false;
  const disposables: Array<{ dispose(): void }> = [];

  /* ---- townsfolk ---- */
  const quayRuns = offsetLine(() => 6.5, (x, z) => townMask(x, z) > 0.6 && z < 97, 2).filter((p) => p.length > 8);
  const streetRuns = offsetLine((x, z) => quayWidth(x, z) + 24, (x, z) => inTown(x, z), 2).filter((p) => p.length > 8);
  const routes = [...quayRuns, ...quayRuns, ...streetRuns];
  const acroRing = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return { x: ACROPOLIS.x + Math.cos(a) * 12, z: ACROPOLIS.z + Math.sin(a) * 12 };
  });
  acroRing.push(acroRing[0]);
  routes.push(acroRing);

  const walkers: Walker[] = [];
  const count = lite ? 9 : 16;
  const loader = new GLTFLoader();
  const models = new Map<string, Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[]; scale: number; lift: number } | null>>();
  const model = (id: string) => {
    let p = models.get(id);
    if (!p) {
      const url = characterUrl(id);
      p = url
        ? loader.loadAsync(url).then((g) => {
          const box = new THREE.Box3().setFromObject(g.scene);
          const h = box.max.y - box.min.y || 1;
          return { scene: g.scene, clips: g.animations ?? [], scale: 1.7 / h, lift: -box.min.y };
        }).catch(() => null)
        : Promise.resolve(null);
      models.set(id, p);
    }
    return p;
  };
  for (let i = 0; i < count; i++) {
    const path = routes[i % routes.length];
    const id = FOLK[i % FOLK.length];
    const holder = new THREE.Group();
    group.add(holder);
    const w: Walker = { path, s: r() * (path.length - 1), dir: r() < 0.5 ? 1 : -1, speed: 1.0 + r() * 0.5, pause: 0, holder, mixer: null, walk: null, idle: null };
    walkers.push(w);
    void model(id).then((m) => {
      if (!m || cancelled) return;
      const obj = cloneSkinned(m.scene);
      obj.scale.setScalar(m.scale);
      obj.position.y = m.lift * m.scale;
      obj.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.castShadow = true; mesh.frustumCulled = false; } });
      holder.add(obj);
      if (m.clips.length) {
        const mixer = new THREE.AnimationMixer(obj);
        const walkClip = m.clips.find((c) => /^walk$|walk/i.test(c.name) && !/gun|carry/i.test(c.name)) ?? m.clips[0];
        const idleClip = m.clips.find((c) => /idle/i.test(c.name) && !/gun|sword/i.test(c.name)) ?? m.clips[0];
        w.walk = mixer.clipAction(walkClip);
        w.idle = mixer.clipAction(idleClip);
        w.walk.play();
        w.idle.play();
        w.idle.weight = 0;
        mixer.update(r() * 2);
        w.mixer = mixer;
      }
    });
  }

  /* ---- gulls ---- */
  const gullMat = new THREE.MeshStandardMaterial({ color: "#f7f7f2", roughness: 0.8, side: THREE.DoubleSide });
  const tipMat = new THREE.MeshStandardMaterial({ color: "#3a3a40", roughness: 0.8, side: THREE.DoubleSide });
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -0.12, 0, 0, 0.14, 0.62, 0.02, 0.02, 0, 0, 0.14, 0.62, 0.02, 0.02, 0.5, 0.0, 0.16], 3));
  wingGeo.computeVertexNormals();
  const tipGeo = new THREE.BufferGeometry();
  tipGeo.setAttribute("position", new THREE.Float32BufferAttribute([0.62, 0.02, 0.02, 0.5, 0.0, 0.16, 0.85, 0.0, 0.1], 3));
  tipGeo.computeVertexNormals();
  const bodyGeo = new THREE.CapsuleGeometry(0.08, 0.32, 3, 6).rotateX(Math.PI / 2);
  disposables.push(gullMat, tipMat, wingGeo, tipGeo, bodyGeo);
  interface Gull { g: THREE.Group; l: THREE.Group; rr: THREE.Group; cx: number; cz: number; rad: number; y: number; speed: number; phase: number }
  const gulls: Gull[] = [];
  const nGulls = lite ? 10 : 18;
  for (let i = 0; i < nGulls; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, gullMat);
    g.add(body);
    const mk = (side: number) => {
      const w = new THREE.Group();
      const a = new THREE.Mesh(wingGeo, gullMat);
      const b = new THREE.Mesh(tipGeo, tipMat);
      w.add(a, b);
      w.scale.x = side;
      g.add(w);
      return w;
    };
    const l = mk(1), rr = mk(-1);
    g.scale.setScalar(1.4);
    group.add(g);
    const centres = [[-10, 30], [40, 60], [150, 22], [-60, -30], [100, -40]];
    const [cx, cz] = centres[i % centres.length];
    gulls.push({ g, l, rr, cx: cx + (r() - 0.5) * 40, cz: cz + (r() - 0.5) * 40, rad: 18 + r() * 40, y: 14 + r() * 26, speed: (0.12 + r() * 0.12) * (r() < 0.5 ? 1 : -1), phase: r() * 6.28 });
  }

  /* ---- sheep on the hills ---- */
  const woolMat = new THREE.MeshStandardMaterial({ color: "#f4f0e6", roughness: 1 });
  const faceMat = new THREE.MeshStandardMaterial({ color: "#3a332e", roughness: 0.9 });
  const woolGeo = new THREE.IcosahedronGeometry(0.5, 1).scale(1.3, 0.85, 0.9);
  const headGeo = new THREE.IcosahedronGeometry(0.2, 1).scale(1.2, 1, 0.9);
  const legGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.45, 5);
  disposables.push(woolMat, faceMat, woolGeo, headGeo, legGeo);
  interface Sheep { g: THREE.Group; head: THREE.Mesh; x: number; z: number; tx: number; tz: number; wait: number; heading: number }
  const flock: Sheep[] = [];
  const pastures = [[-150, -20], [-180, 90], [60, -40], [-40, -140], [70, 0]];
  for (let i = 0; i < (lite ? 10 : 22); i++) {
    const [px, pz] = pastures[i % pastures.length];
    let x = px + (r() - 0.5) * 30, z = pz + (r() - 0.5) * 30;
    if (groundType(x, z) !== Ground.Grass || inTown(x, z)) { x = px; z = pz; }
    if (groundType(x, z) !== Ground.Grass) continue;
    const g = new THREE.Group();
    const wool = new THREE.Mesh(woolGeo, woolMat);
    wool.position.y = 0.72;
    wool.castShadow = true;
    const head = new THREE.Mesh(headGeo, faceMat);
    head.position.set(0.7, 0.8, 0);
    g.add(wool, head);
    for (const [lx, lz] of [[0.35, 0.2], [0.35, -0.2], [-0.35, 0.2], [-0.35, -0.2]]) {
      const leg = new THREE.Mesh(legGeo, faceMat);
      leg.position.set(lx, 0.22, lz);
      g.add(leg);
    }
    mergeStatic(g, new Set([head]), false); // the geometries are shared by the flock
    group.add(g);
    flock.push({ g, head, x, z, tx: x, tz: z, wait: r() * 6, heading: r() * 6 });
  }

  /* ---- dolphins ---- */
  const dolphinMat = new THREE.MeshStandardMaterial({ color: "#5c7a92", roughness: 0.35, metalness: 0.1 });
  const dBody = new THREE.CapsuleGeometry(0.32, 1.6, 4, 10).rotateZ(Math.PI / 2);
  const dFin = new THREE.ConeGeometry(0.18, 0.5, 4).translate(0, 0.45, 0);
  const dTail = new THREE.ConeGeometry(0.3, 0.5, 4).rotateZ(Math.PI / 2).scale(1, 0.25, 1.4).translate(-1.3, 0, 0);
  disposables.push(dolphinMat, dBody, dFin, dTail);
  interface Dolphin { g: THREE.Group; cx: number; cz: number; heading: number; phase: number; period: number }
  const pod: Dolphin[] = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(dBody.clone(), dolphinMat), new THREE.Mesh(dFin.clone(), dolphinMat), new THREE.Mesh(dTail.clone(), dolphinMat));
    mergeStatic(g);
    group.add(g);
    pod.push({ g, cx: 200 + (r() - 0.5) * 20, cz: 75 + (r() - 0.5) * 20, heading: -0.6 + (r() - 0.5) * 0.3, phase: i * 0.35, period: 3.2 + r() * 0.6 });
  }

  const p = new THREE.Vector3();
  return {
    group,
    update(dt: number, time: number, fctx: FrameCtx) {
      // Townsfolk, with a little level of detail: far ones do not animate.
      for (const w of walkers) {
        if (w.pause > 0) w.pause -= dt;
        const moving = w.pause <= 0;
        if (moving) {
          const n = w.path.length - 1;
          const i0 = Math.max(0, Math.min(n - 1, Math.floor(w.s)));
          const seg = Math.hypot(w.path[i0 + 1].x - w.path[i0].x, w.path[i0 + 1].z - w.path[i0].z) || 1;
          w.s += (w.dir * w.speed * dt) / seg;
          if (w.s >= n || w.s <= 0) { w.dir = (w.dir * -1) as 1 | -1; w.s = Math.max(0, Math.min(n - 0.001, w.s)); }
          if (r() < dt * 0.04) w.pause = 3 + r() * 6;
        }
        const n = w.path.length - 1;
        const i0 = Math.max(0, Math.min(n - 1, Math.floor(w.s)));
        const t = w.s - i0;
        const a = w.path[i0], b = w.path[i0 + 1];
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        w.holder.position.set(x, heightAt(x, z), z);
        const want = Math.atan2((b.x - a.x) * w.dir, (b.z - a.z) * w.dir);
        let d = want - w.holder.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        w.holder.rotation.y += d * Math.min(1, dt * 5);
        if (w.mixer && w.walk && w.idle) {
          const k = moving ? 1 : 0;
          w.walk.weight += (k - w.walk.weight) * Math.min(1, dt * 4);
          w.idle.weight = 1 - w.walk.weight;
          const dist = Math.hypot(x - fctx.player.x, z - fctx.player.z);
          if (dist < 70) w.mixer.update(dt);
          w.holder.visible = dist < 160;
        }
      }
      // Gulls: wide lazy circles, wings flapping and gliding by turns.
      for (const gl of gulls) {
        const a = time * gl.speed + gl.phase;
        const x = gl.cx + Math.cos(a) * gl.rad, z = gl.cz + Math.sin(a) * gl.rad;
        const y = gl.y + Math.sin(time * 0.4 + gl.phase) * 3;
        gl.g.position.set(x, y, z);
        gl.g.rotation.set(0, -a + (gl.speed > 0 ? 0 : Math.PI) , gl.speed > 0 ? 0.25 : -0.25, "YXZ");
        const glide = Math.sin(time * 0.3 + gl.phase) > 0.2;
        const flap = glide ? 0.12 : Math.sin(time * 9 + gl.phase) * 0.6;
        gl.l.rotation.z = flap;
        gl.rr.rotation.z = -flap;
      }
      // Sheep: amble to a nearby spot, graze, repeat.
      for (const s of flock) {
        s.wait -= dt;
        const dx = s.tx - s.x, dz = s.tz - s.z;
        const d = Math.hypot(dx, dz);
        if (s.wait <= 0 && d < 0.2) {
          const nx = s.x + (r() - 0.5) * 10, nz = s.z + (r() - 0.5) * 10;
          if (groundType(nx, nz) === Ground.Grass && slopeAt(nx, nz) < 0.5 && !inTown(nx, nz) && -sBay(nx, nz) > 25) { s.tx = nx; s.tz = nz; }
          s.wait = 4 + r() * 8;
        }
        if (d > 0.2) {
          s.x += (dx / d) * 0.6 * dt;
          s.z += (dz / d) * 0.6 * dt;
          s.heading = Math.atan2(-dz, dx);
        }
        s.g.position.set(s.x, heightAt(s.x, s.z), s.z);
        s.g.rotation.y = s.heading;
        s.head.position.y = d > 0.2 ? 0.8 : 0.45 + Math.sin(time * 2 + s.x) * 0.05;
      }
      // Dolphins: leaping arcs in turn, swimming a slow loop.
      for (const dl of pod) {
        dl.heading += dt * 0.05;
        const ph = ((time + dl.phase) % dl.period) / dl.period;
        const cx = dl.cx + Math.cos(time * 0.05 + dl.phase) * 40, cz = dl.cz + Math.sin(time * 0.05 + dl.phase) * 30;
        const fwd = (ph - 0.5) * 7;
        p.set(cx + Math.cos(dl.heading) * fwd, 0, cz - Math.sin(dl.heading) * fwd);
        const jump = Math.sin(ph * Math.PI);
        dl.g.position.set(p.x, -1.4 + jump * 2.6, p.z);
        dl.g.rotation.set(0, dl.heading, -(ph - 0.5) * 2.2, "YXZ");
        dl.g.visible = jump > 0.25;
      }
    },
    dispose() {
      cancelled = true;
      for (const d of disposables) d.dispose();
      group.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isSkinnedMesh) m.skeleton?.dispose();
        else if (m.isMesh && m.name !== "shared") m.geometry.dispose();
      });
      void models;
    },
  };
}
