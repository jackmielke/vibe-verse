/**
 * viewmodel.tsx — the arms, the gun, and everything that sells their weight.
 *
 * The viewmodel is the only part of the player the player ever sees, and it is
 * doing almost all of the work of communicating state: you know you are
 * sprinting because the gun drops and swings, you know you fired because it
 * jumps and settles, you know a grapple bit because the launcher bucks. Every
 * one of those is a spring on this rig rather than an animation clip, for the
 * same reason as the camera: springs superimpose and clips fight.
 *
 * Layout is deliberately old-fashioned and correct: the gun and both hands are
 * a *single* merged geometry authored in "gun space", so the hands can never
 * detach from the grip, and the whole thing is transformed as one object. Two
 * draw calls (opaque body, emissive details) for the entire viewmodel.
 *
 * Positioning is done by copying the camera transform rather than by parenting
 * to the camera. The post-processing pipeline is allowed to swap the camera
 * out from under us; a child of the camera would go with it.
 *
 * Weapon integration
 * ------------------
 * The weapons system does not need to know anything about this file beyond:
 *
 *     import { viewmodelRig } from "@/sf/player/viewmodel";
 *     viewmodelRig.emit("fire", 1.0);        // per shot
 *     viewmodelRig.emit("reload-start");     // and "reload-end"
 *     viewmodelRig.emit("equip");
 *     viewmodelRig.setItem(myGroup);         // optional custom held item
 *
 * Every event is an impulse into a spring; there is no state machine to keep
 * in sync and no way for the two systems to disagree.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER, WORLD_SEED } from "../config";
import { frame } from "../state/store";
import { clamp, clamp01, damp, makeRng } from "../math/rng";
import { cameraRig } from "./camera";
import { grappleSystem } from "./grapple";
import { input } from "./input";
import { parachute } from "./parachute";
import { playerCtrl } from "./controller";
import { wingsuit } from "./wingsuit";

export type ViewmodelEvent =
  | "fire"
  | "reload-start"
  | "reload-end"
  | "equip"
  | "melee"
  | "inspect"
  | "grapple";

/* ------------------------------------------------------------------ *
 * The rig — pure state, no THREE objects the weapons system must know about
 * ------------------------------------------------------------------ */

class ViewmodelRig {
  /** Master visibility. Photo mode and cutscenes turn it off. */
  visible = true;

  /* recoil springs, in viewmodel local space */
  private kickZ = 0;
  private kickZV = 0;
  private kickPitch = 0;
  private kickPitchV = 0;
  private kickRoll = 0;
  private kickRollV = 0;

  /* scripted one-shots */
  private reloading = false;
  private reloadT = 0;
  private inspectT = -1;
  private equipT = -1;

  /* smoothed inputs */
  private swayYaw = 0;
  private swayPitch = 0;
  private prevYaw = 0;
  private prevPitch = 0;
  private lowered = 0;
  private breathe = 0;

  /** Optional custom held item supplied by the weapons system. */
  item: THREE.Object3D | null = null;

  /** Final local transform, written each frame and read by the component. */
  readonly offset = new THREE.Vector3();
  readonly rotation = new THREE.Euler(0, 0, 0, "YXZ");

  /** Swap the held item. Pass null to go back to the grapple launcher. */
  setItem(obj: THREE.Object3D | null): void {
    this.item = obj;
    this.emit("equip");
  }

  /**
   * Fire an animation impulse.
   *
   * `strength` scales the impulse: a pistol is ~0.5, a rocket launcher ~2.
   */
  emit(e: ViewmodelEvent, strength = 1): void {
    switch (e) {
      case "fire":
        // Back along the barrel and muzzle-up, with a little asymmetric roll
        // so repeated shots do not look mechanically identical.
        this.kickZV += 3.6 * strength;
        this.kickPitchV += 9.5 * strength;
        this.kickRollV += 3.2 * strength * (this.kickRoll > 0 ? -1 : 1);
        break;
      case "grapple":
        this.kickZV += 2.4 * strength;
        this.kickPitchV += 5.5 * strength;
        break;
      case "melee":
        this.kickZV -= 7 * strength;
        this.kickRollV += 8 * strength;
        break;
      case "reload-start":
        this.reloading = true;
        this.reloadT = 0;
        break;
      case "reload-end":
        this.reloading = false;
        break;
      case "equip":
        this.equipT = 0;
        break;
      case "inspect":
        if (this.inspectT < 0) this.inspectT = 0;
        break;
    }
  }

  /**
   * Advance every spring and compose the final transform.
   *
   * Order matters: the base pose is chosen first (hip / ADS / lowered), then
   * the cyclic motion is layered on, then the impulses, so a shot fired while
   * sprinting still reads as a shot rather than being swamped by the sway.
   */
  update(dt: number, ads: number, sprint: number, bobPhase: number, bobAmp: number): void {
    /* ---- springs ---- */
    const K = 190;
    const C = 19;
    this.kickZV += (-K * this.kickZ - C * this.kickZV) * dt;
    this.kickZ += this.kickZV * dt;
    this.kickPitchV += (-K * this.kickPitch - C * this.kickPitchV) * dt;
    this.kickPitch += this.kickPitchV * dt;
    this.kickRollV += (-K * 0.7 * this.kickRoll - C * 0.8 * this.kickRollV) * dt;
    this.kickRoll += this.kickRollV * dt;

    /* ---- look sway (lag) ---- */
    let dy = frame.yaw - this.prevYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const dp = frame.pitch - this.prevPitch;
    this.prevYaw = frame.yaw;
    this.prevPitch = frame.pitch;
    // Accumulate the flick, then bleed it off. The gun trails the aim, which
    // is the single most important cue that it has mass.
    const swayScale = 1 - ads * 0.82;
    this.swayYaw = damp(this.swayYaw + dy * 0.55 * swayScale, 0, 9, dt);
    this.swayPitch = damp(this.swayPitch + dp * 0.45 * swayScale, 0, 9, dt);
    this.swayYaw = clamp(this.swayYaw, -0.30, 0.30);
    this.swayPitch = clamp(this.swayPitch, -0.26, 0.26);

    /* ---- lowered while sprinting ---- */
    this.lowered = damp(this.lowered, sprint * (1 - ads), 9, dt);

    /* ---- idle breathing ---- */
    this.breathe += dt * (0.9 + sprint * 1.4);

    /* ---- scripted clips ---- */
    if (this.equipT >= 0) {
      this.equipT += dt;
      if (this.equipT > 0.45) this.equipT = -1;
    }
    if (this.inspectT >= 0) {
      this.inspectT += dt;
      if (this.inspectT > 1.9) this.inspectT = -1;
    }
    if (this.reloading) this.reloadT += dt;

    /* ---- compose ---- */
    // Hip pose: right of centre, below the crosshair, an arm's length out.
    const hipX = 0.155;
    const hipY = -0.145;
    const hipZ = -0.36;
    // ADS pose: on the centreline and closer, so the sights line up.
    const adsX = 0.0;
    const adsY = -0.048;
    const adsZ = -0.245;
    const a = ads * ads * (3 - 2 * ads);

    let x = hipX + (adsX - hipX) * a;
    let y = hipY + (adsY - hipY) * a;
    let z = hipZ + (adsZ - hipZ) * a;
    let rx = 0;
    let ry = 0;
    let rz = 0;

    /* walk / sprint cycle */
    const cyc = bobAmp * (1 - a * 0.8);
    if (cyc > 1e-3) {
      // A figure-of-eight: the hands describe a lazy lissajous as you run,
      // twice the vertical frequency of the lateral one.
      x += Math.sin(bobPhase * 0.5) * 0.028 * cyc;
      y += (Math.abs(Math.sin(bobPhase)) - 0.5) * 0.032 * cyc;
      z += Math.sin(bobPhase * 0.5 + 1.1) * 0.012 * cyc;
      rz += Math.sin(bobPhase * 0.5) * 0.055 * cyc;
      rx += Math.sin(bobPhase) * 0.02 * cyc;
    }

    /* breathing — tiny, but its absence reads as a frozen prop */
    const br = (1 - a * 0.55) * 0.0032;
    x += Math.sin(this.breathe * 1.7) * br;
    y += Math.sin(this.breathe * 2.3 + 1.0) * br * 1.4;

    /* sway */
    x += this.swayYaw * 0.16;
    y += this.swayPitch * 0.13;
    ry += this.swayYaw * 0.55;
    rx += -this.swayPitch * 0.45;
    rz += -this.swayYaw * 0.32;

    /* sprint lower: gun drops, rotates out and swings with the stride */
    if (this.lowered > 1e-3) {
      const l = this.lowered;
      x += 0.045 * l;
      y -= 0.105 * l;
      z += 0.06 * l;
      rx += 0.42 * l;
      ry += 0.30 * l;
      rz += 0.34 * l;
    }

    /* reload: the gun tips inboard and drops while the left hand works */
    if (this.reloading) {
      const t = clamp01(this.reloadT / 0.35);
      const s = t * t * (3 - 2 * t);
      y -= 0.075 * s;
      x -= 0.02 * s;
      rz += 0.5 * s;
      rx += 0.22 * s;
    }

    /* equip: rises into frame from below */
    if (this.equipT >= 0) {
      const t = 1 - clamp01(this.equipT / 0.45);
      y -= 0.34 * t * t;
      rx += 0.7 * t * t;
    }

    /* inspect: turn it over and look at it */
    if (this.inspectT >= 0) {
      const t = clamp01(this.inspectT / 1.9);
      const env = Math.sin(t * Math.PI);
      x -= 0.075 * env;
      y += 0.055 * env;
      z += 0.075 * env;
      ry += 0.95 * env;
      rz += 0.55 * env;
      rx += 0.30 * env;
    }

    /* impulses last */
    z += this.kickZ * 0.028;
    rx += this.kickPitch * 0.02;
    rz += this.kickRoll * 0.012;

    this.offset.set(x, y, z);
    this.rotation.set(rx, ry, rz);
    // Publish the weapon's angular offset so the HUD can float the reticle on
    // it. `frame.viewKick` is the camera's kick; this is the gun's, and they
    // are deliberately different — the reticle follows the gun.
    frame.recoil.set(rz, rx);
  }
}

/** The one viewmodel rig. Weapons talk to this. */
export const viewmodelRig = new ViewmodelRig();

/* ------------------------------------------------------------------ *
 * Geometry — the grapple launcher and two gloved hands, in gun space
 * ------------------------------------------------------------------ */

interface Part {
  geo: THREE.BufferGeometry;
  color: [number, number, number];
  /** Emissive parts go into the second mesh. */
  glow?: boolean;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(
  rt: number,
  rb: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rot?: [number, number, number],
  segs = 10,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, segs, 1);
  if (rot) {
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
  g.translate(x, y, z);
  return g;
}

/**
 * The launcher.
 *
 * Shape language: a compact bullpup receiver with a big exposed cable drum on
 * the left, a stubby wide-bore barrel, and a hard-anodised orange accent on
 * the drum and the sight. It reads as a tool, not a rifle, which is what a
 * grapple should be.
 */
function buildViewmodel(): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const rng = makeRng(`${WORLD_SEED}:viewmodel`);
  const METAL: [number, number, number] = [0.055, 0.058, 0.068];
  const POLY: [number, number, number] = [0.085, 0.088, 0.095];
  const GLOVE: [number, number, number] = [0.035, 0.038, 0.045];
  const SLEEVE: [number, number, number] = [0.10, 0.115, 0.135];
  const ACCENT: [number, number, number] = [0.95, 0.34, 0.06];

  const parts: Part[] = [];

  /* receiver */
  parts.push({ geo: box(0.085, 0.085, 0.26, 0, 0, -0.02), color: METAL });
  parts.push({ geo: box(0.07, 0.045, 0.09, 0, 0.06, -0.05), color: POLY });
  /* barrel + muzzle shroud */
  parts.push({ geo: cyl(0.026, 0.03, 0.20, 0, -0.005, -0.20, [Math.PI / 2, 0, 0]), color: METAL });
  parts.push({ geo: cyl(0.042, 0.038, 0.055, 0, -0.005, -0.29, [Math.PI / 2, 0, 0]), color: METAL });
  /* cable drum, offset left the way a winch actually sits */
  parts.push({
    geo: cyl(0.062, 0.062, 0.055, -0.062, 0.005, -0.03, [0, 0, Math.PI / 2], 16),
    color: POLY,
  });
  parts.push({
    geo: cyl(0.03, 0.03, 0.062, -0.062, 0.005, -0.03, [0, 0, Math.PI / 2], 12),
    color: ACCENT,
    glow: true,
  });
  /* grip + trigger guard */
  parts.push({ geo: cyl(0.024, 0.028, 0.115, 0.004, -0.085, 0.035, [0.22, 0, 0], 8), color: POLY });
  parts.push({ geo: box(0.016, 0.05, 0.012, 0.004, -0.048, -0.012), color: METAL });
  /* foregrip */
  parts.push({ geo: cyl(0.019, 0.022, 0.085, 0, -0.075, -0.15, [0.1, 0, 0], 8), color: POLY });
  /* holo sight */
  parts.push({ geo: box(0.03, 0.018, 0.05, 0, 0.095, -0.06), color: METAL });
  parts.push({ geo: box(0.022, 0.026, 0.004, 0, 0.104, -0.085), color: ACCENT, glow: true });

  /* right hand on the grip */
  parts.push({ geo: box(0.052, 0.075, 0.055, 0.028, -0.088, 0.03), color: GLOVE });
  parts.push({ geo: cyl(0.03, 0.036, 0.20, 0.048, -0.135, 0.14, [0.5, 0.16, 0], 8), color: SLEEVE });
  /* left hand on the foregrip */
  parts.push({ geo: box(0.05, 0.062, 0.052, -0.012, -0.088, -0.155), color: GLOVE });
  parts.push({ geo: cyl(0.028, 0.036, 0.26, -0.055, -0.145, -0.055, [0.62, -0.42, 0], 8), color: SLEEVE });

  /* a scatter of small greebles so the silhouette is not four clean boxes */
  for (let i = 0; i < 7; i++) {
    const w = 0.006 + rng.next() * 0.012;
    parts.push({
      geo: box(
        w,
        w * (0.6 + rng.next()),
        0.01 + rng.next() * 0.03,
        (rng.next() - 0.5) * 0.07,
        0.045 + rng.next() * 0.02,
        -0.14 + rng.next() * 0.2,
      ),
      color: METAL,
    });
  }

  const body = mergeColoured(parts.filter((p) => !p.glow));
  const glow = mergeColoured(parts.filter((p) => !!p.glow));
  for (const p of parts) p.geo.dispose();
  return { body, glow };
}

/** Merge parts, baking each part's colour into a vertex-colour attribute. */
function mergeColoured(parts: Part[]): THREE.BufferGeometry {
  let vc = 0;
  let ic = 0;
  for (const p of parts) {
    vc += p.geo.getAttribute("position").count;
    ic += p.geo.getIndex()!.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const col = new Float32Array(vc * 3);
  const idx = new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.geo.getAttribute("position") as THREE.BufferAttribute;
    const pn = p.geo.getAttribute("normal") as THREE.BufferAttribute;
    const pu = p.geo.getAttribute("uv") as THREE.BufferAttribute;
    pos.set(pp.array as Float32Array, vo * 3);
    nor.set(pn.array as Float32Array, vo * 3);
    uv.set(pu.array as Float32Array, vo * 2);
    for (let i = 0; i < pp.count; i++) {
      col[(vo + i) * 3] = p.color[0];
      col[(vo + i) * 3 + 1] = p.color[1];
      col[(vo + i) * 3 + 2] = p.color[2];
    }
    const pi = p.geo.getIndex()!;
    for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
    io += pi.count;
    vo += pp.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  return geo;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _euler = new THREE.Euler(0, 0, 0, "YXZ");

export interface ViewModelProps {
  visible?: boolean;
}

export default function ViewModel({ visible = true }: ViewModelProps) {
  const camera = useThree((s) => s.camera);
  const geo = useMemo(buildViewmodel, []);

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.46,
        metalness: 0.72,
        envMapIntensity: 1.1,
      }),
    [],
  );
  const glowMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.3,
        metalness: 0.2,
        emissive: new THREE.Color(0xff6a1e),
        emissiveIntensity: 1.8,
        toneMapped: true,
      }),
    [],
  );

  const rootRef = useRef<THREE.Group>(null);
  const pivotRef = useRef<THREE.Group>(null);
  const gunRef = useRef<THREE.Group>(null);
  /** Last custom item we parented, so we can detach it when it changes. */
  const attachedItem = useRef<THREE.Object3D | null>(null);

  /* Fire a kick whenever the hook bites — the launcher takes the load. */
  useEffect(() => grappleSystem.onImpact(() => viewmodelRig.emit("grapple", 1)), []);

  useEffect(
    () => () => {
      geo.body.dispose();
      geo.glow.dispose();
      bodyMat.dispose();
      glowMat.dispose();
    },
    [geo, bodyMat, glowMat],
  );

  useFrame((_, delta) => {
    const root = rootRef.current;
    const pivot = pivotRef.current;
    if (!root || !pivot) return;
    const dt = Math.min(delta, 1 / 15);

    if (input.pressed("inspect")) viewmodelRig.emit("inspect");

    // Hidden in flight (your arms are the wings), under canopy, in a vehicle,
    // and while dead.
    const hide =
      !visible ||
      !viewmodelRig.visible ||
      wingsuit.active ||
      parachute.active ||
      frame.movement === "vehicle" ||
      frame.movement === "dead";
    root.visible = !hide;
    if (hide) return;

    root.position.copy(camera.position);
    root.quaternion.copy(camera.quaternion);

    // Custom held item handover. The weapons system hands us an Object3D it
    // still owns — we only parent it, and we never dispose it.
    if (attachedItem.current !== viewmodelRig.item) {
      if (attachedItem.current) pivot.remove(attachedItem.current);
      attachedItem.current = viewmodelRig.item;
      if (attachedItem.current) pivot.add(attachedItem.current);
    }
    if (gunRef.current) gunRef.current.visible = !viewmodelRig.item;

    viewmodelRig.update(
      dt,
      playerCtrl.adsBlend,
      playerCtrl.sprintBlend,
      cameraRig.bobPhase,
      clamp01(
        Math.hypot(frame.velocity.x, frame.velocity.z) / PLAYER.sprintSpeed,
      ) * (frame.grounded ? 1 : 0.25),
    );

    pivot.position.copy(viewmodelRig.offset);
    _euler.copy(viewmodelRig.rotation);
    pivot.quaternion.setFromEuler(_euler);
  });

  return (
    <group ref={rootRef} frustumCulled={false} renderOrder={10}>
      <group ref={pivotRef} frustumCulled={false}>
        <group ref={gunRef} frustumCulled={false}>
          <mesh geometry={geo.body} material={bodyMat} frustumCulled={false} castShadow={false} />
          <mesh geometry={geo.glow} material={glowMat} frustumCulled={false} castShadow={false} />
        </group>
      </group>
    </group>
  );
}
