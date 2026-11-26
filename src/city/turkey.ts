/**
 * turkey — the Thanksgiving mount on Vibe Island.
 *
 * A giant turkey you ride the way you ride Pegasus: walk up, press F (or tap
 * the prompt), or land on its back. It shares the `PegasusWorld` shape so the
 * mount code, the multiplayer ghosts and the F key need no special case, and
 * it flies the way a turkey would if it were the size of a van: slower than
 * the others, flapping hard to stay up, sinking the moment you stop.
 *
 * Proportions: the body's origin is the rider's hip height minus MOUNT_SEAT,
 * and the feet are 2.5 m below it, which is the height every mount rests at
 * (`floor + 2.5` in `stepMount`).
 */
import * as THREE from "three";
import type { PegasusWorld } from "@/components/city/pegasus";

export function buildTurkey(center: THREE.Vector3, restYaw = Math.PI): PegasusWorld {
  const group = new THREE.Group();
  group.name = "turkey";
  const body = new THREE.Group();
  body.position.copy(center);
  group.add(body);

  const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const brown = std(0x7a4a26, { emissive: 0x2a1408, emissiveIntensity: 0.35 });
  const dark = std(0x4a2a14, { emissive: 0x1a0c04, emissiveIntensity: 0.3 });
  const red = std(0xd8322a, { emissive: 0x5a0c08, emissiveIntensity: 0.5 });
  const orange = std(0xf0a030, { emissive: 0x6a3a08, emissiveIntensity: 0.4 });
  const gold = std(0xf6cf5a, { emissive: 0x6a5010, emissiveIntensity: 0.5 });
  const cream = std(0xf2e2c0, { emissive: 0x3a3020, emissiveIntensity: 0.3 });
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mats: THREE.Material[] = [brown, dark, red, orange, gold, cream, black, white];
  const geos: THREE.BufferGeometry[] = [];
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
    geos.push(g);
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    return x;
  };

  // A plump body, round on top so a rider sits in the dip behind the neck.
  const torso = mesh(new THREE.SphereGeometry(1.5, 20, 14), brown);
  torso.scale.set(1, 0.85, 1.2);
  body.add(torso);
  const breast = mesh(new THREE.SphereGeometry(1.15, 16, 12), dark);
  breast.position.set(0, -0.15, 0.85);
  body.add(breast);

  // Tail fan: a half wheel of feathers in harvest colours, standing up behind.
  const tail = new THREE.Group();
  tail.position.set(0, 0.35, -1.35);
  tail.rotation.x = -0.25;
  body.add(tail);
  const featherGeo = new THREE.CapsuleGeometry(0.32, 1.9, 4, 8);
  geos.push(featherGeo);
  const bands = [brown, orange, red, gold, dark, orange, red, gold, brown, orange, red];
  for (let i = 0; i < bands.length; i++) {
    const a = -Math.PI / 2 + 0.12 + (i / (bands.length - 1)) * (Math.PI - 0.24);
    const f = new THREE.Mesh(featherGeo, bands[i]);
    f.castShadow = true;
    f.scale.set(1, 1, 0.25);
    f.position.set(Math.sin(a) * 1.35, Math.cos(a) * 1.35, 0);
    f.rotation.z = -a;
    tail.add(f);
    // A pale tip on every feather, so the fan reads as feathers from afar.
    const tip = mesh(new THREE.SphereGeometry(0.3, 8, 6), cream);
    tip.scale.set(1, 0.6, 0.3);
    tip.position.set(Math.sin(a) * 2.45, Math.cos(a) * 2.45, 0.02);
    tail.add(tip);
  }

  // Neck and head, forward (+z, the way every mount here faces).
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.6, 1.35);
  body.add(neckPivot);
  const neck = mesh(new THREE.CapsuleGeometry(0.42, 0.9, 4, 10), dark);
  neck.position.set(0, 0.55, 0.15);
  neck.rotation.x = 0.35;
  neckPivot.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 1.25, 0.4);
  neckPivot.add(head);
  const skull = mesh(new THREE.SphereGeometry(0.5, 14, 10), std(0x9fb6d8, { emissive: 0x223044, emissiveIntensity: 0.3 }));
  head.add(skull);
  const beak = mesh(new THREE.ConeGeometry(0.17, 0.5, 8), orange);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, -0.05, 0.6);
  head.add(beak);
  const snood = mesh(new THREE.CapsuleGeometry(0.09, 0.5, 4, 6), red);
  snood.position.set(0.05, -0.2, 0.58);
  head.add(snood);
  const wattle = mesh(new THREE.SphereGeometry(0.2, 8, 6), red);
  wattle.scale.set(0.8, 1.4, 0.8);
  wattle.position.set(0, -0.45, 0.35);
  head.add(wattle);
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.12, 8, 6), white);
    eye.position.set(0.38 * s, 0.12, 0.25);
    head.add(eye);
    const pupil = mesh(new THREE.SphereGeometry(0.06, 6, 4), black);
    pupil.position.set(0.47 * s, 0.13, 0.3);
    head.add(pupil);
  }
  // A little pilgrim hat, because it is that kind of week.
  const hat = new THREE.Group();
  hat.position.set(0, 0.42, -0.02);
  hat.rotation.x = -0.15;
  head.add(hat);
  const hatBlack = std(0x1d1d22);
  mats.push(hatBlack, skull.material as THREE.Material);
  const brim = mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 18), hatBlack);
  hat.add(brim);
  const crown = mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.55, 16), hatBlack);
  crown.position.y = 0.3;
  hat.add(crown);
  const buckle = mesh(new THREE.BoxGeometry(0.22, 0.14, 0.04), gold);
  buckle.position.set(0, 0.12, 0.35);
  hat.add(buckle);

  // Wings, folded along the sides; they open and beat when it flies.
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    // Hung from the shoulder and lying flat against the side when folded;
    // swinging out round z opens it.
    const pivot = new THREE.Group();
    pivot.position.set(1.2 * s, 0.55, 0.05);
    body.add(pivot);
    const w = mesh(new THREE.SphereGeometry(1, 12, 8), dark);
    w.scale.set(0.2, 0.85, 1.25);
    w.position.set(0.05 * s, -0.7, -0.15);
    pivot.add(w);
    wings.push(pivot);
  }

  // Legs, down to the ground 2.5 m below the body's origin.
  const legs: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(0.6 * s, -0.95, 0.15);
    body.add(hip);
    const shin = mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.5, 8), orange);
    shin.position.y = -0.75;
    hip.add(shin);
    for (const a of [-0.5, 0, 0.5]) {
      const toe = mesh(new THREE.CapsuleGeometry(0.07, 0.45, 3, 6), orange);
      toe.rotation.set(Math.PI / 2, a, 0);
      toe.position.set(Math.sin(a) * 0.25, -1.52, Math.cos(a) * 0.25);
      hip.add(toe);
    }
    legs.push(hip);
  }

  const rest = center.clone();
  let pecking = 0;
  let nextPeck = 2;
  let runPhase = 0;
  let lastPos = new THREE.Vector3().copy(center);

  return {
    group,
    body,
    pose: null,
    update(dt, now) {
      const s = now / 1000;
      const pose = this.pose;
      if (pose) {
        body.position.set(pose.x, pose.y, pose.z);
        body.rotation.set(0, pose.yaw, pose.bank, "YXZ");
      } else {
        body.position.copy(rest);
        body.rotation.set(0, restYaw, 0);
      }
      const moved = body.position.distanceTo(lastPos) / Math.max(dt, 1e-3);
      lastPos = body.position.clone();
      // Flying: wings out and beating, legs tucked. Standing: wings folded,
      // a slow breathing bob and the odd peck at the grass.
      const flying = !!pose && moved > 1;
      const beat = pose?.flap ? 13 : 6;
      for (const [i, w] of wings.entries()) {
        const side = i === 0 ? -1 : 1;
        w.rotation.z = side * (flying ? 1.25 + Math.sin(s * beat) * 0.55 : 0.08);
      }
      if (flying) {
        runPhase += dt * Math.min(18, moved * 0.8);
        legs[0].rotation.x = 0.9 + Math.sin(runPhase) * 0.15;
        legs[1].rotation.x = 0.9 - Math.sin(runPhase) * 0.15;
        neckPivot.rotation.x = 0.2;
        // Fanned flat behind in flight, so the rider's camera sees over it.
        tail.rotation.x = -1.25;
      } else {
        legs[0].rotation.x = 0;
        legs[1].rotation.x = 0;
        tail.rotation.x = -0.25 + Math.sin(s * 0.7) * 0.05;
        nextPeck -= dt;
        if (nextPeck <= 0 && pecking <= 0) { pecking = 1.1; nextPeck = 3 + Math.random() * 5; }
        if (pecking > 0) {
          pecking -= dt;
          neckPivot.rotation.x = Math.sin((1.1 - pecking) / 1.1 * Math.PI) * 0.9;
        } else {
          neckPivot.rotation.x = Math.sin(s * 1.6) * 0.06;
        }
        if (!pose) body.position.y += Math.sin(s * 2) * 0.04;
      }
      head.rotation.y = Math.sin(s * 0.9) * 0.25;
      snood.rotation.z = Math.sin(s * 5) * 0.2;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      group.removeFromParent();
    },
  };
}

/** One "gobble-obble-obble", synthesised, so it costs no download. */
export function gobble(ctx: AudioContext, out: AudioNode, volume = 0.5) {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(520, t0);
  osc.frequency.exponentialRampToValueAtTime(330, t0 + 0.7);
  lfo.frequency.setValueAtTime(22, t0);
  lfoGain.gain.setValueAtTime(140, t0);
  lfo.connect(lfoGain).connect(osc.frequency);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1100;
  filter.Q.value = 1.2;
  gain.gain.setValueAtTime(0.0001, t0);
  // Three throaty pulses.
  for (let i = 0; i < 3; i++) {
    const t = t0 + i * 0.22;
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.02, t + 0.18);
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(t0);
  lfo.start(t0);
  osc.stop(t0 + 0.8);
  lfo.stop(t0 + 0.8);
}
