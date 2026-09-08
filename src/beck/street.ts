/**
 * What is at the edge of the road: a mailbox at the end of every driveway
 * with the real house number on it, a green street-name blade at every
 * intersection with the county's abbreviations, a stop sign where a side
 * road meets Blakely Avenue, the speed limit, power poles carrying the
 * mapped lines and the roads that have no mapped line but obviously have
 * power, the mapped fences, hedges and gates, and the fire hydrants.
 */
import * as THREE from "three";
import { lines, mulberry32, nearestOnLine, point, resample, roadWidth, signName, type Neighbourhood } from "./geo";
import type { Ground } from "./terrain";
import { signFace } from "./textures";

export interface Street {
  group: THREE.Group;
  dispose(): void;
}

export function buildStreet(data: Neighbourhood, ground: Ground): Street {
  const group = new THREE.Group();
  const rnd = mulberry32(4242);
  const disposables: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const galv = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.45, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.95 });
  const poleWood = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
  const hydrantRed = new THREE.MeshStandardMaterial({ color: 0xc8341e, roughness: 0.5 });
  const wire = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  const cedarFence = new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.95 });
  const hedge = new THREE.MeshStandardMaterial({ color: 0x3f6a2e, roughness: 1 });
  disposables.push(galv, wood, poleWood, black, hydrantRed, wire, cedarFence, hedge);

  const mainRoads = data.roads.filter((r) => ["secondary", "tertiary", "residential"].includes(r.cls));
  const mainLines = mainRoads.flatMap((r) => lines(r.g).map((l) => ({ l, r })));

  // ---- Mailboxes: every driveway that meets a main road, numbered from the nearest address.
  const boxGeo = new THREE.BoxGeometry(0.2, 0.22, 0.48);
  const postGeo = new THREE.BoxGeometry(0.09, 1.1, 0.09);
  const boxes: { m: THREE.Matrix4; label: string }[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const d of data.roads) {
    if (d.cls !== "service") continue;
    for (const l of lines(d.g)) {
      for (const end of [l[0], l[l.length - 1]]) {
        let best: { d: number; x: number; z: number; tx: number; tz: number } | null = null;
        for (const ml of mainLines) {
          const n = nearestOnLine(end[0], end[1], ml.l);
          if (!best || n.d < best.d) best = n;
        }
        if (!best || best.d > 4) continue;
        // Which house: the nearest address to the driveway's far end.
        const far = end === l[0] ? l[l.length - 1] : l[0];
        let addr: { n: string; d: number } | null = null;
        for (const a of data.addresses) {
          const p = point(a.g)!;
          const dd = Math.hypot(p[0] - far[0], p[1] - far[1]);
          if (!addr || dd < addr.d) addr = { n: a.n, d: dd };
        }
        if (!addr || addr.d > 60) continue;
        // Stand on the shoulder, driveway side, facing the road.
        const nx = -best.tz;
        const nz = best.tx;
        const side = Math.sign((end[0] - best.x) * nx + (end[1] - best.z) * nz) || 1;
        const w = roadWidth("residential") / 2 + 0.9;
        const x = best.x + nx * side * w + best.tx * 1.6;
        const z = best.z + nz * side * w + best.tz * 1.6;
        const y = ground.heightAt(x, z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-nx * side, -nz * side) + Math.PI / 2);
        m4.compose(new THREE.Vector3(x, y + 1.1, z), q, one);
        boxes.push({ m: m4.clone(), label: addr.n });
        const post = new THREE.Mesh(postGeo, wood);
        post.position.set(x, y + 0.55, z);
        post.castShadow = true;
        group.add(post);
      }
    }
  }
  const boxMesh = new THREE.InstancedMesh(boxGeo, black, Math.max(1, boxes.length));
  boxes.forEach((b, i) => boxMesh.setMatrixAt(i, b.m));
  boxMesh.count = boxes.length;
  boxMesh.castShadow = true;
  group.add(boxMesh);
  // Numbers: a small label plane on the road side of each box.
  for (const b of boxes) {
    const t = signFace((g, w, h) => {
      g.fillStyle = "#1a1a1a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#f2f2f2";
      g.font = "bold 84px Helvetica, Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(b.label, w / 2, h / 2 + 4);
    }, 256, 96);
    textures.push(t);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
    disposables.push(mat);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.13), mat);
    plane.applyMatrix4(b.m);
    plane.translateX(0.101);
    plane.rotateY(Math.PI / 2);
    group.add(plane);
  }

  // ---- Intersections: where a named main road ends on another.
  const bladeGeo = new THREE.PlaneGeometry(0.9, 0.2);
  const signPostGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6);
  const placed: number[][] = [];
  for (const a of mainLines) {
    for (const end of [a.l[0], a.l[a.l.length - 1]]) {
      for (const b of mainLines) {
        if (b === a || !b.r.name || b.r.name === a.r.name) continue;
        const n = nearestOnLine(end[0], end[1], b.l);
        if (n.d > 3) continue;
        if (placed.some((p) => Math.hypot(p[0] - end[0], p[1] - end[1]) < 12)) continue;
        placed.push(end);
        // Corner: back from the junction along a, off to the side.
        const dir = a.l.length > 1 ? (end === a.l[0] ? [a.l[1][0] - end[0], a.l[1][1] - end[1]] : [a.l[a.l.length - 2][0] - end[0], a.l[a.l.length - 2][1] - end[1]]) : [1, 0];
        const dl = Math.hypot(dir[0], dir[1]) || 1;
        const tx = dir[0] / dl;
        const tz = dir[1] / dl;
        const x = end[0] + tx * (roadWidth(b.r.cls) / 2 + 2.2) + -tz * (roadWidth(a.r.cls) / 2 + 1.4);
        const z = end[1] + tz * (roadWidth(b.r.cls) / 2 + 2.2) + tx * (roadWidth(a.r.cls) / 2 + 1.4);
        const y = ground.heightAt(x, z);
        const post = new THREE.Mesh(signPostGeo, galv);
        post.position.set(x, y + 1.3, z);
        group.add(post);
        const names = [signName(a.r.name), signName(b.r.name)].filter(Boolean);
        names.forEach((nm, i) => {
          const t = signFace((g, w, h) => {
            g.fillStyle = "#1f6a3a";
            g.fillRect(0, 0, w, h);
            g.strokeStyle = "#ffffff";
            g.lineWidth = 6;
            g.strokeRect(6, 6, w - 12, h - 12);
            g.fillStyle = "#ffffff";
            g.font = "bold 72px Helvetica, Arial, sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(nm.toUpperCase(), w / 2, h / 2 + 4);
          });
          textures.push(t);
          const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, side: THREE.DoubleSide });
          disposables.push(mat);
          const blade = new THREE.Mesh(bladeGeo, mat);
          blade.position.set(x, y + 2.45 - i * 0.24, z);
          const along = i === 0 ? [tx, tz] : [-tz, tx];
          blade.rotation.y = Math.atan2(along[0], along[1]) + Math.PI / 2;
          group.add(blade);
        });
        // Stop sign when a lesser road meets a greater one.
        const rank = (c: string) => (c === "secondary" ? 3 : c === "tertiary" ? 2 : 1);
        if (rank(b.r.cls) > rank(a.r.cls)) {
          const t = signFace((g, w, h) => {
            g.clearRect(0, 0, w, h);
            g.fillStyle = "#b8121b";
            g.beginPath();
            for (let k = 0; k < 8; k++) {
              const ang = (k / 8) * Math.PI * 2 + Math.PI / 8;
              g.lineTo(w / 2 + Math.cos(ang) * (w / 2 - 4), h / 2 + Math.sin(ang) * (h / 2 - 4));
            }
            g.closePath();
            g.fill();
            g.strokeStyle = "#ffffff";
            g.lineWidth = 8;
            g.stroke();
            g.fillStyle = "#ffffff";
            g.font = "bold 92px Helvetica, Arial, sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText("STOP", w / 2, h / 2 + 6);
          }, 256, 256);
          textures.push(t);
          const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.4, side: THREE.DoubleSide });
          disposables.push(mat);
          const sx = end[0] + tx * (roadWidth(b.r.cls) / 2 + 1.2) + -tz * (roadWidth(a.r.cls) / 2 + 1.2) * -1;
          const sz = end[1] + tz * (roadWidth(b.r.cls) / 2 + 1.2) + tx * (roadWidth(a.r.cls) / 2 + 1.2) * -1;
          const sy = ground.heightAt(sx, sz);
          const p2 = new THREE.Mesh(signPostGeo, galv);
          p2.position.set(sx, sy + 1.3, sz);
          group.add(p2);
          const face = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.75), mat);
          face.position.set(sx, sy + 2.3, sz);
          face.rotation.y = Math.atan2(tx, tz);
          group.add(face);
        }
      }
    }
  }

  // ---- Speed limit 25 on Beck Road, both directions, near the ends.
  const beck = mainLines.find((m) => m.r.name && m.r.name.toLowerCase().includes("beck road"));
  if (beck) {
    const t = signFace((g, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#000000";
      g.lineWidth = 8;
      g.strokeRect(10, 10, w - 20, h - 20);
      g.fillStyle = "#000000";
      g.textAlign = "center";
      g.font = "bold 44px Helvetica, Arial, sans-serif";
      g.fillText("SPEED", w / 2, 70);
      g.fillText("LIMIT", w / 2, 118);
      g.font = "bold 150px Helvetica, Arial, sans-serif";
      g.fillText("25", w / 2, 270);
    }, 256, 320);
    textures.push(t);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, side: THREE.DoubleSide });
    disposables.push(mat);
    const pts = resample(beck.l, 2);
    for (const i of [Math.floor(pts.length * 0.12), Math.floor(pts.length * 0.88)]) {
      const p = pts[i];
      const side = i < pts.length / 2 ? 1 : -1;
      const x = p.x + -p.tz * side * (roadWidth(beck.r.cls) / 2 + 1.3);
      const z = p.z + p.tx * side * (roadWidth(beck.r.cls) / 2 + 1.3);
      const y = ground.heightAt(x, z);
      const post = new THREE.Mesh(signPostGeo, galv);
      post.position.set(x, y + 1.3, z);
      group.add(post);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.75), mat);
      face.position.set(x, y + 2.3, z);
      face.rotation.y = Math.atan2(p.tx * side, p.tz * side) + Math.PI;
      group.add(face);
    }
  }

  // ---- Power poles: along the mapped minor lines, and every 45 m along the main roads.
  const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 10, 8);
  poleGeo.translate(0, 5, 0);
  const crossGeo = new THREE.BoxGeometry(2.2, 0.1, 0.1);
  const poles: { x: number; z: number; y: number }[] = [];
  const addPole = (x: number, z: number) => {
    if (poles.some((p) => Math.hypot(p.x - x, p.z - z) < 12)) return;
    const y = ground.heightAt(x, z);
    poles.push({ x, z, y });
  };
  for (const f of data.infra) {
    if (f.cls !== "minor_line") continue;
    for (const l of lines(f.g)) for (const p of resample(l, 45)) addPole(p.x, p.z);
  }
  for (const ml of mainLines) {
    if (ml.r.cls === "residential" && rnd() < 0.3) continue;
    const w = roadWidth(ml.r.cls) / 2 + 2.6;
    for (const p of resample(ml.l, 45)) addPole(p.x + -p.tz * w, p.z + p.tx * w);
  }
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleWood, Math.max(1, poles.length));
  const crossMesh = new THREE.InstancedMesh(crossGeo, poleWood, Math.max(1, poles.length));
  poles.forEach((p, i) => {
    m4.compose(new THREE.Vector3(p.x, p.y - 0.3, p.z), q.identity(), one);
    poleMesh.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(p.x, p.y + 9.2, p.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI), one);
    crossMesh.setMatrixAt(i, m4);
  });
  poleMesh.count = poles.length;
  crossMesh.count = poles.length;
  poleMesh.castShadow = true;
  group.add(poleMesh, crossMesh);
  // Wires: catenaries between poles that are within 70 m of each other along the same road.
  const wpos: number[] = [];
  for (let i = 0; i < poles.length; i++) {
    let best = -1;
    let bd = 70;
    for (let j = i + 1; j < poles.length; j++) {
      const d = Math.hypot(poles[j].x - poles[i].x, poles[j].z - poles[i].z);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const a = poles[i];
    const b = poles[best];
    for (const off of [-0.6, 0.6]) {
      for (let k = 0; k < 8; k++) {
        const t0 = k / 8;
        const t1 = (k + 1) / 8;
        const sag = (t: number) => 4 * t * (1 - t) * -1.2;
        wpos.push(a.x + (b.x - a.x) * t0 + off, a.y + 9.5 + (b.y - a.y) * t0 + sag(t0), a.z + (b.z - a.z) * t0, a.x + (b.x - a.x) * t1 + off, a.y + 9.5 + (b.y - a.y) * t1 + sag(t1), a.z + (b.z - a.z) * t1);
      }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute("position", new THREE.Float32BufferAttribute(wpos, 3));
  group.add(new THREE.LineSegments(wgeo, wire));

  // ---- Fences, hedges, gates, hydrants from the infrastructure data.
  for (const f of data.infra) {
    if (f.cls === "fence" || f.cls === "hedge") {
      for (const l of lines(f.g)) {
        const pts = resample(l, f.cls === "fence" ? 2.4 : 1.5);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.2) continue;
          const y = (ground.heightAt(a.x, a.z) + ground.heightAt(b.x, b.z)) / 2;
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          if (f.cls === "fence") {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, len), cedarFence);
            rail.position.set((a.x + b.x) / 2, y + 1.0, (a.z + b.z) / 2);
            rail.rotation.y = yaw;
            group.add(rail);
            const rail2 = rail.clone();
            rail2.position.y = y + 0.5;
            group.add(rail2);
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.25, 0.1), cedarFence);
            post.position.set(a.x, ground.heightAt(a.x, a.z) + 0.62, a.z);
            group.add(post);
          } else {
            const h = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, len + 0.3), hedge);
            h.position.set((a.x + b.x) / 2, y + 0.8, (a.z + b.z) / 2);
            h.rotation.y = yaw;
            h.castShadow = true;
            group.add(h);
          }
        }
      }
    } else if (f.cls === "gate") {
      const p = point(f.g);
      if (!p) continue;
      const y = ground.heightAt(p[0], p[1]);
      const gate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.1, 0.08), galv);
      gate.position.set(p[0], y + 0.7, p[1]);
      const near = mainLines.map((ml) => nearestOnLine(p[0], p[1], ml.l)).sort((u, v) => u.d - v.d)[0];
      if (near) gate.rotation.y = Math.atan2(near.tx, near.tz);
      group.add(gate);
    } else if (f.cls === "fire_hydrant") {
      const p = point(f.g);
      if (!p) continue;
      const y = ground.heightAt(p[0], p[1]);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.75, 10), hydrantRed);
      h.position.set(p[0], y + 0.37, p[1]);
      group.add(h);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), hydrantRed);
      cap.position.set(p[0], y + 0.78, p[1]);
      group.add(cap);
    }
  }

  return {
    group,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      disposables.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
