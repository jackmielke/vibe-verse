/**
 * The Static Bloom: five players on the Vibe Bowl's stage.
 *
 * They are the city's procedural pilots, the same rig the dance floor and
 * the club use, posed through the dance overlay rather than a dance: a strum
 * is just an arm pose that moves on the eighth notes, so the band plays on
 * the same clock the music is scheduled on and can never drift off it.
 * Instruments are a handful of boxes and cylinders in each player's own
 * space (+Z forward, +X their left), so they move with nothing and cost
 * nothing.
 */
import * as THREE from "three";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";
import { createDancePose, resetDancePose, setArm, setLeg, type DancePose } from "@/components/city/dances";
import type { ShowState } from "./show";

export type Role = "vocals" | "guitar" | "bass" | "keys" | "drums";

export interface BandMember {
  role: Role;
  name: string;
  group: THREE.Group;
  pilot: ProceduralPilot;
}

const PI = Math.PI;

function mat(color: number, emissive = 0, ei = 0.6) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, emissive, emissiveIntensity: emissive ? ei : 0 });
}

function guitar(color: number, neck: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.07), mat(color));
  g.add(body);
  const horn = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.07), mat(color));
  horn.position.set(0.18, 0.15, 0);
  g.add(horn);
  const n = new THREE.Mesh(new THREE.BoxGeometry(neck, 0.05, 0.035), mat(0x2a1a10));
  n.position.set(0.2 + neck / 2, 0.02, 0);
  g.add(n);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.04), mat(0x111111));
  head.position.set(0.2 + neck + 0.06, 0.02, 0);
  g.add(head);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.02), mat(0x111111));
  strap.position.set(0.05, 0.3, -0.06);
  strap.rotation.z = -0.5;
  g.add(strap);
  return g;
}

function props(role: Role): THREE.Group {
  const g = new THREE.Group();
  if (role === "guitar" || role === "bass") {
    const gt = guitar(role === "guitar" ? 0xff3fd1 : 0x38e8ff, role === "guitar" ? 0.55 : 0.72);
    gt.position.set(-0.05, 0.98, 0.2);
    gt.rotation.set(0.1, 0, 0.42);
    g.add(gt);
  } else if (role === "vocals") {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.45, 6), mat(0x222222));
    pole.position.set(0, 0.72, 0.45);
    g.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 12), mat(0x222222));
    base.position.set(0, 0.02, 0.45);
    g.add(base);
    const mic = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat(0xdddddd, 0xffffff, 0.2));
    mic.position.set(0, 1.5, 0.36);
    g.add(mic);
  } else if (role === "keys") {
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 0.36), mat(0x16161e));
    top.position.set(0, 0.95, 0.45);
    g.add(top);
    const keysTex = (() => {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 32;
      const x = c.getContext("2d")!;
      x.fillStyle = "#f4f4f4";
      x.fillRect(0, 0, 256, 32);
      x.fillStyle = "#111";
      for (let i = 0; i < 36; i++) {
        x.fillRect(i * (256 / 36), 0, 1, 32);
        if ([0, 1, 3, 4, 5].includes(i % 7)) x.fillRect(i * (256 / 36) + 4, 0, 4, 19);
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const keys = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.2), new THREE.MeshBasicMaterial({ map: keysTex }));
    keys.rotation.x = -PI / 2 + 0.25;
    keys.position.set(0, 1.0, 0.4);
    keys.rotation.z = PI;
    g.add(keys);
    for (const sx of [-0.45, 0.45]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.95, 0.04), mat(0x333333));
      leg.position.set(sx, 0.47, 0.45);
      leg.rotation.x = sx > 0 ? 0.3 : -0.3;
      g.add(leg);
    }
  } else {
    // A kit, sat facing the crowd.
    const shell = mat(0x7a3cff, 0x7a3cff, 0.25);
    const chrome = mat(0xd8d8d8);
    const brass = new THREE.MeshStandardMaterial({ color: 0xd9b44a, metalness: 0.7, roughness: 0.3 });
    const kick = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.36, 18), shell);
    kick.rotation.x = PI / 2;
    kick.position.set(0, 0.34, 0.72);
    g.add(kick);
    const headTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const x = c.getContext("2d")!;
      x.fillStyle = "#f2efe6";
      x.beginPath();
      x.arc(64, 64, 64, 0, PI * 2);
      x.fill();
      x.fillStyle = "#7a3cff";
      x.font = "900 30px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("STATIC", 64, 52);
      x.fillText("BLOOM", 64, 80);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.33, 24), new THREE.MeshBasicMaterial({ map: headTex }));
    face.position.set(0, 0.34, 0.905);
    g.add(face);
    const drum = (r: number, h: number, x: number, y: number, z: number, tilt = 0.25) => {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), shell);
      d.position.set(x, y, z);
      d.rotation.x = tilt;
      g.add(d);
    };
    drum(0.19, 0.14, -0.05, 0.72, 0.42); // snare
    drum(0.15, 0.16, 0.18, 0.92, 0.62); // rack toms
    drum(0.15, 0.16, -0.22, 0.92, 0.62);
    drum(0.23, 0.36, 0.5, 0.5, 0.35, 0); // floor tom
    const cym = (r: number, x: number, y: number, z: number) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 0.012, 18), brass);
      c.position.set(x, y, z);
      c.rotation.x = 0.2;
      g.add(c);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, y, 5), chrome);
      st.position.set(x, y / 2, z);
      g.add(st);
    };
    cym(0.24, 0.55, 1.28, 0.62);
    cym(0.27, -0.6, 1.22, 0.55);
    cym(0.17, -0.48, 0.96, 0.3); // hi-hat
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.5, 12), mat(0x222222));
    stool.position.set(0, 0.25, -0.1);
    g.add(stool);
  }
  return g;
}

const ROSTER: Array<{ role: Role; name: string; design: string }> = [
  { role: "vocals", name: "Juno", design: "seraph" },
  { role: "guitar", name: "Rook", design: "voltaic" },
  { role: "bass", name: "Mags", design: "nightcape" },
  { role: "keys", name: "Ivy", design: "aurora" },
  { role: "drums", name: "Tank", design: "grit" },
];

/** The five of them, their instruments, and the pose each strikes on every frame. Placing them is the venue's job. */
export function buildBand(): { members: BandMember[]; update(dt: number, beats: number, st: ShowState, soloing: boolean): void; dispose(): void } {
  const members: BandMember[] = ROSTER.map((r) => {
    const group = new THREE.Group();
    const pilot = buildProceduralPilot(undefined, r.design);
    group.add(pilot.group);
    group.add(props(r.role));
    return { ...r, group, pilot };
  });
  const pose: DancePose = createDancePose();

  const posePlayer = (m: BandMember, b: number, st: ShowState, soloing: boolean) => {
    resetDancePose(pose);
    const e = st.energy;
    const bob = Math.abs(Math.sin(b * PI));
    if (st.inBreak) {
      // Waving to the crowd between songs.
      const w = Math.sin(b * PI * 1.5);
      p_root(pose, 0.02 * bob);
      if (m.role === "drums") {
        setLeg(pose.legL, 1, 1.35, 0.25, 1.45, 1);
        setLeg(pose.legR, -1, 1.35, 0.25, 1.45, 1);
        pose.rootY = -0.42;
        setArm(pose.armR, -1, 0.2, 2.5 + 0.3 * w, 0.3);
        setArm(pose.armL, 1, 0.9, 0.3, 1.2);
      } else {
        setArm(pose.armR, -1, 0.2, 2.4 + 0.35 * w, 0.35);
        setArm(pose.armL, 1, m.role === "vocals" ? 0.3 : 0.9, m.role === "vocals" ? 2.2 - 0.3 * w : 0.35, m.role === "vocals" ? 0.4 : 1.2);
        pose.head.y = 0.2 * w;
      }
      return;
    }
    switch (m.role) {
      case "vocals": {
        const big = st.section === "chorus";
        pose.rootY = 0.03 * bob * e;
        pose.head.x = -0.08 + 0.08 * Math.sin(b * PI);
        pose.torso.y = 0.12 * Math.sin(b * PI * 0.5);
        setArm(pose.armR, -1, 1.25, 0.15, 1.95); // mic hand
        const g = Math.sin(b * PI * 0.5);
        if (big) setArm(pose.armL, 1, 0.5, 2.1 + 0.3 * g, 0.4);
        else setArm(pose.armL, 1, 0.6 + 0.3 * g, 0.5 + 0.25 * g, 0.6);
        setLeg(pose.legL, 1, 0.05, 0.08, 0.15 + 0.1 * bob);
        setLeg(pose.legR, -1, -0.05, 0.08, 0.15 + 0.1 * (1 - bob));
        break;
      }
      case "guitar":
      case "bass": {
        const rate = m.role === "guitar" ? 2 : 1;
        const strum = Math.sin(b * PI * 2 * rate);
        const rock = st.section === "chorus" || (soloing && m.role === "guitar") || st.section === "solo";
        pose.rootY = -0.04 - 0.04 * bob * e;
        pose.rootPitch = rock ? 0.12 : 0.04;
        pose.head.x = 0.12 + 0.18 * bob * e; // headbang, harder on a chorus
        pose.torso.y = m.role === "guitar" ? -0.25 : 0.25;
        setArm(pose.armR, -1, 0.55 + 0.25 * strum, 0.3, 1.35);
        setArm(pose.armL, 1, 1.0, 0.4, 1.15, -0.35);
        setLeg(pose.legL, 1, 0, 0.18, 0.25);
        setLeg(pose.legR, -1, 0, 0.18, 0.25);
        break;
      }
      case "keys": {
        const f = Math.sin(b * PI * 4) * 0.06;
        pose.rootY = 0.02 * bob;
        pose.torso.y = 0.15 * Math.sin(b * PI * 0.5);
        pose.head.x = 0.1 * bob;
        pose.head.y = 0.15 * Math.sin(b * PI * 0.5);
        setArm(pose.armL, 1, 0.95 + f, 0.2, 0.95);
        setArm(pose.armR, -1, 0.95 - f, 0.2, 0.95);
        setLeg(pose.legL, 1, 0, 0.1, 0.15);
        setLeg(pose.legR, -1, 0, 0.1, 0.15);
        break;
      }
      case "drums": {
        const hitL = Math.max(0, Math.sin(b * PI * 2));
        const hitR = Math.max(0, Math.sin(b * PI * 2 + PI));
        pose.rootY = -0.42;
        pose.head.x = 0.1 + 0.15 * bob * e;
        setLeg(pose.legL, 1, 1.35, 0.25, 1.45, 1);
        setLeg(pose.legR, -1, 1.35 + 0.15 * Math.max(0, Math.sin(b * PI)), 0.25, 1.45, 1);
        setArm(pose.armL, 1, 0.8 + 0.4 * hitL, 0.35, 1.2);
        setArm(pose.armR, -1, 0.8 + 0.4 * hitR, 0.35, 1.2);
        break;
      }
    }
  };

  return {
    members,
    update(dt, beats, st, soloing) {
      for (const m of members) {
        posePlayer(m, beats, st, soloing);
        m.pilot.update(dt, { speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false, dance: { pose, weight: 1, lag: 0.03 } });
      }
    },
    dispose() {
      for (const m of members) {
        m.pilot.dispose();
        m.group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && !m.pilot.group.getObjectById(mesh.id)) {
            mesh.geometry.dispose();
            const mm = mesh.material as THREE.Material & { map?: THREE.Texture | null };
            mm.map?.dispose();
            mm.dispose();
          }
        });
      }
    },
  };
}

function p_root(p: DancePose, y: number) {
  p.rootY = y;
}
