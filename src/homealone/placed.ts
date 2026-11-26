/**
 * What a laid trap looks like, the ghost you see before you lay it, and the
 * few other things that only exist to make a plan readable: the valuables, and
 * the dotted line of where they are likely to walk.
 *
 * One rule, inherited from the fixed traps this replaced: **you must be able
 * to see it from across a dark room.** Every trap sits on a ring of unlit
 * colour on the floor, which costs no light and reads at ten metres. A trap
 * you cannot find again is a trap you cannot lead anybody onto.
 */
import * as THREE from "three";
import { KIT, type KitKind, type Placed } from "./kit";
import * as T from "./textures";

interface Visual {
  group: THREE.Group;
  ring: THREE.Mesh;
  /** The part that moves when it goes off. */
  actor: THREE.Object3D | null;
  kind: KitKind;
  ringing: number;
}

export interface PlacedRig {
  add(p: Placed): void;
  remove(id: number): void;
  /** The burst of bits when one goes off. */
  burst(p: Placed): void;
  /** A hit that was not a trap: a wall, the stairs, a colleague. */
  thump(x: number, y: number, z: number): void;
  ring(id: number): void;
  /** Show (or hide, with a null kind) the outline of what is about to be laid. */
  ghost(kind: KitKind | null, x: number, y: number, z: number, yaw: number, ok: boolean): void;
  /** Put a valuable somewhere, or hide it. */
  loot(id: string, x: number, y: number, z: number, visible: boolean, carried: boolean): void;
  /** The dotted lines of their likely routes; null clears them. */
  routes(points: Array<{ x: number; y: number; z: number }> | null): void;
  clear(): void;
  update(dt: number, t: number, placed: ReadonlyArray<Placed>): void;
  dispose(): void;
}

export function buildPlaced(parent: THREE.Object3D): PlacedRig {
  const owned: Array<{ dispose(): void }> = [];
  const keep = <M extends THREE.Material | THREE.BufferGeometry>(m: M) => {
    owned.push(m);
    return m;
  };
  const BOX = keep(new THREE.BoxGeometry(1, 1, 1));
  const SPH = keep(new THREE.SphereGeometry(0.5, 10, 8));
  const CYL = keep(new THREE.CylinderGeometry(0.5, 0.5, 1, 20));
  const RING = keep(new THREE.RingGeometry(0.86, 1, 40));
  const DISC = keep(new THREE.CircleGeometry(1, 32));
  const TRI = keep(new THREE.BufferGeometry());
  TRI.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-0.22, 0, 0, 0.22, 0, 0, 0, 0, 0.5]), 3),
  );
  TRI.setIndex([0, 2, 1]);
  const OCTA = keep(new THREE.OctahedronGeometry(0.16));

  const mats = new Map<string, THREE.Material>();
  const std = (color: number, rough = 0.7, metal = 0) => {
    const key = `s${color}:${rough}:${metal}`;
    let m = mats.get(key);
    if (!m) {
      m = keep(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
      mats.set(key, m);
    }
    return m;
  };
  const flat = (color: number, opacity = 1) => {
    const key = `f${color}:${opacity}`;
    let m = mats.get(key);
    if (!m) {
      m = keep(
        new THREE.MeshBasicMaterial({
          color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
        }),
      );
      mats.set(key, m);
    }
    return m;
  };

  const put = (
    g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material,
    x: number, y: number, z: number, sx: number, sy: number, sz: number,
  ) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    g.add(o);
    return o;
  };
  /** A flat shape lying on the floor. */
  const floor = (g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, r: number, y = 0.02) => {
    const o = new THREE.Mesh(geo, m);
    o.rotation.x = -Math.PI / 2;
    o.position.y = y;
    o.scale.setScalar(r);
    g.add(o);
    return o;
  };
  /** The arrow that says which way a directional trap throws. Local +Z. */
  const arrow = (g: THREE.Object3D, m: THREE.Material, from: number) => {
    const o = new THREE.Mesh(TRI, m);
    o.position.set(0, 0.03, from);
    g.add(o);
    const o2 = new THREE.Mesh(TRI, m);
    o2.position.set(0, 0.03, from + 0.45);
    g.add(o2);
  };

  const root = new THREE.Group();
  parent.add(root);
  const visuals = new Map<number, Visual>();

  function model(kind: KitKind): { group: THREE.Group; ring: THREE.Mesh; actor: THREE.Object3D | null } {
    const def = KIT[kind];
    const group = new THREE.Group();
    const ring = floor(group, RING, flat(def.colour, 0.75), Math.max(0.5, def.radius || 0.45));
    let actor: THREE.Object3D | null = null;
    switch (kind) {
      case "marbles": {
        const colours = [0x6fd0ff, 0xff6f91, 0xf2c53d, 0x7be08a, 0xd08cff];
        const bits = new THREE.Group();
        for (let i = 0; i < 16; i++) {
          const a = i * 2.4;
          const r = 0.12 + (i / 16) * 0.62;
          put(bits, SPH, std(colours[i % colours.length], 0.15, 0.3), Math.cos(a) * r, 0.035, Math.sin(a) * r, 0.07, 0.07, 0.07);
        }
        group.add(bits);
        actor = bits;
        break;
      }
      case "tripwire": {
        put(group, BOX, std(0x5a4632), -0.7, 0.09, 0, 0.05, 0.18, 0.05);
        put(group, BOX, std(0x5a4632), 0.7, 0.09, 0, 0.05, 0.18, 0.05);
        actor = put(group, BOX, flat(0xe8e8f0), 0, 0.14, 0, 1.4, 0.012, 0.012);
        break;
      }
      case "glue": {
        floor(group, DISC, std(0xe0a82a, 0.08, 0.35), 0.72, 0.025);
        floor(group, DISC, std(0xf6d77a, 0.05, 0.4), 0.3, 0.03).position.x = 0.2;
        break;
      }
      case "clock": {
        const c = new THREE.Group();
        c.position.y = 0.11;
        put(c, CYL, std(0xd9453a, 0.4, 0.3), 0, 0, 0, 0.2, 0.1, 0.2).rotation.x = Math.PI / 2;
        put(c, CYL, std(0xf4f0e6, 0.6), 0, 0, 0.055, 0.16, 0.01, 0.16).rotation.x = Math.PI / 2;
        put(c, SPH, std(0xe8c860, 0.3, 0.7), -0.08, 0.12, 0, 0.09, 0.09, 0.09);
        put(c, SPH, std(0xe8c860, 0.3, 0.7), 0.08, 0.12, 0, 0.09, 0.09, 0.09);
        group.add(c);
        actor = c;
        break;
      }
      case "slick": {
        floor(group, DISC, std(0xcff4ee, 0.04, 0.25), 0.92, 0.022);
        for (let i = 0; i < 7; i++) {
          const a = i * 1.9;
          put(group, SPH, std(0xffffff, 0.05, 0.1), Math.cos(a) * 0.5, 0.05, Math.sin(a) * 0.5, 0.09, 0.07, 0.09);
        }
        break;
      }
      case "spring": {
        put(group, CYL, std(0x9aa0a8, 0.3, 0.8), 0, 0.1, 0.12, 0.2, 0.2, 0.2);
        const board = new THREE.Group();
        board.position.set(0, 0.08, -0.4);
        const plank = put(board, BOX, std(0xd9762c, 0.6), 0, 0, 0.4, 0.62, 0.05, 0.9);
        plank.rotation.x = -0.28;
        plank.position.y = 0.12;
        group.add(board);
        actor = board;
        arrow(group, flat(def.colour, 0.9), 0.75);
        break;
      }
      case "sack": {
        // Hung from the ceiling on a rope; the pivot is at the top.
        const pivot = new THREE.Group();
        pivot.position.y = 2.45;
        put(pivot, BOX, std(0x8d7f6d), 0, -0.62, 0, 0.02, 1.24, 0.02);
        put(pivot, SPH, std(0xb89868, 0.95), 0, -1.45, 0, 0.5, 0.62, 0.5);
        put(pivot, BOX, std(0x7a6442, 0.95), 0, -1.16, 0, 0.16, 0.08, 0.16);
        pivot.rotation.x = -0.55;
        group.add(pivot);
        actor = pivot;
        arrow(group, flat(def.colour, 0.9), 1.1);
        break;
      }
      case "flour": {
        const bag = new THREE.Group();
        put(bag, BOX, std(0xf0e8d8, 0.95), 0, 0.17, 0, 0.26, 0.34, 0.18);
        put(bag, BOX, std(0xc8553c, 0.9), 0, 0.17, 0.092, 0.2, 0.12, 0.01);
        put(bag, BOX, std(0xe6dcc8, 0.95), 0, 0.36, 0, 0.22, 0.05, 0.12);
        group.add(bag);
        actor = bag;
        break;
      }
    }
    return { group, ring, actor };
  }

  /* ---- bursts ----------------------------------------------------- */

  function pool(count: number, size: number) {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = keep(
      new THREE.PointsMaterial({
        map: T.softDot(), size, transparent: true, opacity: 0, depthWrite: false,
      }),
    );
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    return { pos, vel, geo, mat, life: 0, fade: 1.3, gravity: 9.8, count };
  }
  const sparks = pool(80, 0.13);
  const cloud = pool(140, 0.95);

  function emit(p: ReturnType<typeof pool>, x: number, y: number, z: number, colour: number, spread: number, up: number, gravity: number, fade: number) {
    p.mat.color.setHex(colour);
    p.gravity = gravity;
    p.fade = fade;
    for (let i = 0; i < p.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      p.pos[i * 3] = x + Math.cos(a) * r * 0.2;
      p.pos[i * 3 + 1] = y + Math.random() * 0.3;
      p.pos[i * 3 + 2] = z + Math.sin(a) * r * 0.2;
      p.vel[i * 3] = Math.cos(a) * spread * (0.3 + Math.random());
      p.vel[i * 3 + 1] = Math.random() * up;
      p.vel[i * 3 + 2] = Math.sin(a) * spread * (0.3 + Math.random());
    }
    p.geo.attributes.position.needsUpdate = true;
    p.life = 1;
  }

  function stepPool(p: ReturnType<typeof pool>, dt: number, maxOpacity: number) {
    if (p.life <= 0) return;
    p.life = Math.max(0, p.life - dt * p.fade);
    p.mat.opacity = p.life * maxOpacity;
    const drag = p.gravity < 2 ? Math.max(0, 1 - dt * 1.6) : 1;
    for (let i = 0; i < p.count; i++) {
      p.vel[i * 3] *= drag;
      p.vel[i * 3 + 2] *= drag;
      p.vel[i * 3 + 1] -= p.gravity * dt;
      p.pos[i * 3] += p.vel[i * 3] * dt;
      p.pos[i * 3 + 1] += p.vel[i * 3 + 1] * dt;
      p.pos[i * 3 + 2] += p.vel[i * 3 + 2] * dt;
    }
    p.geo.attributes.position.needsUpdate = true;
  }

  /* ---- the ghost ---------------------------------------------------- */

  const ghost = new THREE.Group();
  ghost.visible = false;
  root.add(ghost);
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x7dff9a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
  });
  owned.push(ghostMat);
  const ghostRing = floor(ghost, RING, ghostMat, 1, 0.04);
  const ghostFill = floor(ghost, DISC, keep(new THREE.MeshBasicMaterial({
    color: 0x7dff9a, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide,
  })), 1, 0.035);
  const ghostArrow = new THREE.Group();
  arrow(ghostArrow, ghostMat, 0);
  ghost.add(ghostArrow);
  /** The line a directional trap will throw along, so aiming is not a guess. */
  const ghostLine = put(ghost, BOX, ghostMat, 0, 0.04, 0, 0.05, 0.01, 1);

  /* ---- valuables ---------------------------------------------------- */

  const lootMat = keep(new THREE.MeshBasicMaterial({ color: 0xffd54a }));
  const lootHot = keep(new THREE.MeshBasicMaterial({ color: 0xff5a3c }));
  const loots = new Map<string, { gem: THREE.Mesh; ring: THREE.Mesh }>();
  function lootVisual(id: string) {
    let v = loots.get(id);
    if (!v) {
      const gem = new THREE.Mesh(OCTA, lootMat);
      root.add(gem);
      const ring = new THREE.Mesh(RING, flat(0xffd54a, 0.5));
      ring.rotation.x = -Math.PI / 2;
      ring.scale.setScalar(0.42);
      root.add(ring);
      v = { gem, ring };
      loots.set(id, v);
    }
    return v;
  }

  /* ---- route dots --------------------------------------------------- */

  const routeGeo = keep(new THREE.BufferGeometry());
  const routeMat = keep(
    new THREE.PointsMaterial({
      map: T.softDot(), size: 0.2, color: 0xff7a5a, transparent: true, opacity: 0.85, depthWrite: false,
    }),
  );
  const routePts = new THREE.Points(routeGeo, routeMat);
  routePts.frustumCulled = false;
  routePts.visible = false;
  root.add(routePts);

  const rig: PlacedRig = {
    add(p) {
      const m = model(p.kind);
      m.group.position.set(p.x, p.y, p.z);
      m.group.rotation.y = p.yaw;
      root.add(m.group);
      visuals.set(p.id, { ...m, kind: p.kind, ringing: 0 });
    },
    remove(id) {
      const v = visuals.get(id);
      if (!v) return;
      root.remove(v.group);
      visuals.delete(id);
    },
    burst(p) {
      const def = KIT[p.kind];
      if (p.kind === "flour") emit(cloud, p.x, p.y + 0.5, p.z, 0xf6f2ea, 2.2, 1.6, 0.4, 0.28);
      else emit(sparks, p.x, p.y + (p.kind === "sack" ? 1.0 : 0.25), p.z, def.colour, 2.4, 3.2, 9.8, 1.3);
    },
    thump(x, y, z) {
      emit(sparks, x, y + 0.8, z, 0xfff2c0, 2.8, 2.6, 9.8, 1.6);
    },
    ring(id) {
      const v = visuals.get(id);
      if (v) v.ringing = 3.5;
    },
    ghost(kind, x, y, z, yaw, ok) {
      if (!kind) {
        ghost.visible = false;
        return;
      }
      const def = KIT[kind];
      ghost.visible = true;
      ghost.position.set(x, y, z);
      ghost.rotation.y = yaw;
      const r = Math.max(0.5, def.radius || 0.45);
      ghostRing.scale.setScalar(r);
      ghostFill.scale.setScalar(r);
      ghostMat.color.setHex(ok ? 0x7dff9a : 0xff5a5a);
      (ghostFill.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x7dff9a : 0xff5a5a);
      ghostArrow.visible = def.directional;
      ghostLine.visible = def.directional;
      if (def.directional) {
        ghostArrow.position.z = def.throw;
        ghostLine.scale.z = def.throw;
        ghostLine.position.z = def.throw / 2;
      }
    },
    loot(id, x, y, z, visible, carried) {
      const v = lootVisual(id);
      v.gem.visible = visible;
      v.ring.visible = visible && !carried;
      v.gem.material = carried ? lootHot : lootMat;
      v.gem.position.set(x, y, z);
      v.ring.position.set(x, y - (carried ? 0 : 1.25), z);
    },
    routes(points) {
      if (!points || !points.length) {
        routePts.visible = false;
        return;
      }
      const arr = new Float32Array(points.length * 3);
      points.forEach((p, i) => {
        arr[i * 3] = p.x;
        arr[i * 3 + 1] = p.y + 0.12;
        arr[i * 3 + 2] = p.z;
      });
      routeGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      routePts.visible = true;
    },
    clear() {
      for (const v of visuals.values()) root.remove(v.group);
      visuals.clear();
      ghost.visible = false;
      routePts.visible = false;
      for (const l of loots.values()) {
        l.gem.visible = false;
        l.ring.visible = false;
      }
      sparks.life = 0;
      sparks.mat.opacity = 0;
      cloud.life = 0;
      cloud.mat.opacity = 0;
    },
    update(dt, t, placed) {
      for (const p of placed) {
        const v = visuals.get(p.id);
        if (!v) continue;
        // Armed: the ring breathes. Cooling down: it dims, so you can see it
        // is not ready. Going off: it flares.
        const ringMat = v.ring.material as THREE.MeshBasicMaterial;
        void ringMat;
        const ready = p.cool <= 0 && p.usesLeft > 0;
        const pulse = ready ? 1 + Math.sin(t * 3 + p.id) * 0.05 : 0.8;
        v.ring.scale.setScalar(Math.max(0.5, KIT[p.kind].radius || 0.45) * pulse * (1 + p.firing * 0.6));
        v.ring.visible = ready || p.firing > 0 || Math.sin(t * 14) > 0;
        const f = 1 - p.firing; // 0 → 1 across the animation
        const a = v.actor;
        if (a) {
          switch (p.kind) {
            case "marbles":
              a.scale.setScalar(1 + (p.firing > 0 ? Math.sin(f * Math.PI) * 0.9 : 0));
              break;
            case "tripwire":
              a.visible = p.firing <= 0 || f < 0.2;
              break;
            case "spring":
              a.rotation.x = p.firing > 0 ? -Math.sin(f * Math.PI) * 1.2 : 0;
              break;
            case "sack":
              // Held back on its rope until it goes; then one big swing through.
              a.rotation.x = p.firing > 0 ? -0.55 + Math.sin(f * Math.PI) * 2.0 : -0.55 + Math.sin(t * 1.2 + p.id) * 0.04;
              break;
            case "flour":
              a.visible = p.firing <= 0;
              break;
            case "clock": {
              if (v.ringing > 0) {
                v.ringing -= dt;
                a.rotation.z = Math.sin(t * 60) * 0.25;
                a.position.y = 0.11 + Math.abs(Math.sin(t * 30)) * 0.05;
              } else {
                a.rotation.z = 0;
                a.position.y = 0.11;
              }
              break;
            }
          }
        }
      }
      for (const l of loots.values()) {
        if (!l.gem.visible) continue;
        l.gem.rotation.y = t * 1.6;
        l.gem.position.y += Math.sin(t * 2.2 + l.gem.position.x) * 0.0015;
      }
      routeMat.opacity = 0.55 + Math.sin(t * 3) * 0.3;
      stepPool(sparks, dt, 0.95);
      stepPool(cloud, dt, 0.55);
    },
    dispose() {
      for (const o of owned) o.dispose();
      parent.remove(root);
    },
  };
  return rig;
}
