/**
 * The Wizard himself: KayKit's Mage on a ring of runes, who pops over to
 * stand beside you while you talk and casts when a wish lands.
 *
 * He has a home (a glowing circle somewhere people walk past) and he goes
 * back to it a minute after the conversation ends. While you are talking he
 * stands a step to your right and a step ahead, turned to face you, so he is
 * in the shot whatever the camera is doing.
 */
import * as THREE from "three";

import mageUrl from "@/assets/glb/characters/Mage.glb";
import { softDot } from "@/city/softDot";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";

export interface WizardNpc {
  group: THREE.Group;
  /** World position of his home circle. */
  home: THREE.Vector3;
  near(p: THREE.Vector3, r?: number): boolean;
  summon(player: THREE.Vector3, yaw: number): void;
  dismiss(): void;
  cast(at?: THREE.Vector3): void;
  setTalking(on: boolean): void;
  update(dt: number, now: number, player: THREE.Vector3): void;
  dispose(): void;
}

function sign(text: string, sub: string): THREE.Sprite | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 160;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "rgba(30,16,60,0.78)";
  g.beginPath();
  g.roundRect?.(16, 12, 480, 136, 40);
  g.fill();
  g.textAlign = "center";
  g.fillStyle = "#ffe08a";
  g.font = "700 54px system-ui, sans-serif";
  g.fillText(text, 256, 72);
  g.fillStyle = "#e9ddff";
  g.font = "500 32px system-ui, sans-serif";
  g.fillText(sub, 256, 122);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(3.2, 1, 1);
  return s;
}

export function createWizardNpc(home: THREE.Vector3, homeYaw: number): WizardNpc {
  const group = new THREE.Group();
  group.name = "wizard-npc";
  const disposables: Array<{ dispose(): void }> = [];

  // Home: a rune circle that glows, so he can be found from across the plaza.
  const circleMat = new THREE.MeshBasicMaterial({ color: "#a98bff", transparent: true, opacity: 0.75, depthWrite: false });
  const circle = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.75, 48).rotateX(-Math.PI / 2), circleMat);
  const innerMat = new THREE.MeshBasicMaterial({ color: "#ffd86b", transparent: true, opacity: 0.45, depthWrite: false });
  const inner = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 6).rotateX(-Math.PI / 2), innerMat);
  circle.position.copy(home).add(new THREE.Vector3(0, 0.04, 0));
  inner.position.copy(circle.position);
  disposables.push(circleMat, innerMat, circle.geometry, inner.geometry);
  group.add(circle, inner);

  const body = new THREE.Group();
  body.position.copy(home);
  body.rotation.y = homeYaw;
  group.add(body);

  // A placeholder robe until the model arrives (and if it never does).
  const robeMat = new THREE.MeshStandardMaterial({ color: "#5b3fbf", roughness: 0.8 });
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 16), robeMat);
  robe.position.y = 0.8;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 16), robeMat);
  hat.position.y = 2.0;
  disposables.push(robeMat, robe.geometry, hat.geometry);
  const stand = new THREE.Group();
  stand.add(robe, hat);
  body.add(stand);

  // The staff's star, which flares when he casts.
  const starMat = new THREE.MeshBasicMaterial({ color: "#fff1a8" });
  const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), starMat);
  star.position.set(0.55, 2.05, 0.15);
  disposables.push(starMat, star.geometry);
  body.add(star);

  const label = sign("🧙 The Wizard", "walk up to make a wish");
  if (label) {
    label.position.y = 2.95;
    disposables.push(label.material.map!, label.material);
    body.add(label);
  }

  // Sparkle burst, reused for poofs and casts.
  const N = 90;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(N * 3);
  const sparkVel = new Float32Array(N * 3);
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  const sparkMat = new THREE.PointsMaterial({
    color: "#ffe9a0", size: 0.35, map: softDot(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  disposables.push(sparkGeo, sparkMat);
  group.add(sparks);
  let sparkAge = 99;
  const burst = (at: THREE.Vector3, spread = 1) => {
    for (let i = 0; i < N; i++) {
      sparkPos.set([at.x, at.y + 1, at.z], i * 3);
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const v = (1.5 + Math.random() * 3) * spread;
      sparkVel.set([Math.sin(ph) * Math.cos(th) * v, Math.abs(Math.cos(ph)) * v + 1, Math.sin(ph) * Math.sin(th) * v], i * 3);
    }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkAge = 0;
  };

  let rig: CharacterRig | null = null;
  let castAction: THREE.AnimationAction | null = null;
  let disposed = false;
  loadCharacterRig({ url: mageUrl, id: "Mage" }, { height: 1.9 })
    .then((r) => {
      if (disposed) return r.dispose();
      rig = r;
      stand.visible = false;
      body.add(r.object);
      r.setLocomotion(0);
      const clip = r.clips.find((c) => /spellcast_shoot/i.test(c.name)) ?? r.clips.find((c) => /spellcast|cheer/i.test(c.name));
      if (clip && r.mixer) {
        castAction = r.mixer.clipAction(clip);
        castAction.setLoop(THREE.LoopOnce, 1);
        castAction.clampWhenFinished = false;
      }
    })
    .catch(() => {
      /* the robe and hat stay; he is still a wizard */
    });

  let mode: "home" | "beside" = "home";
  let talking = false;
  let idleSince = 0;
  let castT = 99;
  const target = new THREE.Vector3().copy(home);
  let targetYaw = homeYaw;
  const tmp = new THREE.Vector3();

  const placeBeside = (player: THREE.Vector3, yaw: number) => {
    // A step to the player's right and a little ahead, facing them.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    target.set(player.x + rx * 1.7 + fx * 2.2, player.y, player.z + rz * 1.7 + fz * 2.2);
    targetYaw = Math.atan2(player.x - target.x, player.z - target.z);
  };

  return {
    group,
    home,
    near(p, r = 5) {
      return tmp.copy(body.position).setY(p.y).distanceTo(p) < r;
    },
    summon(player, yaw) {
      if (mode === "beside" && body.position.distanceTo(player) < 6) return;
      burst(body.position.clone());
      placeBeside(player, yaw);
      body.position.copy(target);
      body.rotation.y = targetYaw;
      burst(target.clone());
      mode = "beside";
    },
    dismiss() {
      if (mode === "home") return;
      burst(body.position.clone());
      body.position.copy(home);
      body.rotation.y = homeYaw;
      burst(home.clone());
      mode = "home";
    },
    cast(at) {
      castT = 0;
      if (castAction && rig?.mixer) {
        castAction.reset().fadeIn(0.15).play();
      }
      if (at) burst(at, 1.6);
    },
    setTalking(on) {
      talking = on;
      idleSince = 0;
    },
    update(dt, now, player) {
      rig?.update(dt);
      const t = now / 1000;
      circleMat.opacity = 0.55 + Math.sin(t * 2) * 0.2;
      inner.rotation.y = t * 0.6;
      castT += dt;
      const flare = castT < 0.8 ? 1 + (1 - castT / 0.8) * 3 : 1 + Math.sin(t * 3) * 0.15;
      star.scale.setScalar(flare);
      star.rotation.y = t * 2;
      if (castAction && castT > 1.6 && castAction.isRunning()) castAction.fadeOut(0.3);
      if (!rig) stand.position.y = Math.sin(t * 1.5) * 0.05;

      // Turn to face the player when they come close, at home or beside.
      const d = tmp.copy(player).sub(body.position);
      if (d.lengthSq() < 144) targetYaw = Math.atan2(d.x, d.z);
      let dy = targetYaw - body.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      body.rotation.y += dy * Math.min(1, dt * 4);

      if (label) label.visible = mode === "home" && d.lengthSq() < 400;

      if (mode === "beside") {
        if (!talking) idleSince += dt;
        // Wander back home a minute after the conversation, or if you run off.
        if (idleSince > 60 || d.lengthSq() > 60 * 60) {
          burst(body.position.clone());
          body.position.copy(home);
          mode = "home";
          burst(home.clone());
        }
      }

      if (sparkAge < 1.6) {
        sparkAge += dt;
        const pos = sparkGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < N; i++) {
          sparkVel[i * 3 + 1] -= 3 * dt;
          pos.setXYZ(i, pos.getX(i) + sparkVel[i * 3] * dt, pos.getY(i) + sparkVel[i * 3 + 1] * dt, pos.getZ(i) + sparkVel[i * 3 + 2] * dt);
        }
        pos.needsUpdate = true;
        sparkMat.opacity = Math.max(0, 1 - sparkAge / 1.6);
      } else sparkMat.opacity = 0;
    },
    dispose() {
      disposed = true;
      rig?.dispose();
      disposables.forEach((x) => x.dispose());
    },
  };
}
