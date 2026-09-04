/**
 * One wheel, one rider, one speaker. Drawn in code so it needs nothing
 * fetched: a torus for the tyre, a box for the body, a capsule and a sphere
 * for the person, a canvas for the face. Leans with the steering, pitches
 * with the throttle, and falls over when asked to.
 */
import * as THREE from "three";

export interface Rider {
  group: THREE.Group;
  /** Call every frame with distance travelled this frame and the inputs. */
  update(dt: number, dist: number, lean: number, tilt: number, speed: number, fallen: number, music: boolean): void;
  dispose(): void;
}

function faceTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#e0b48c";
  ctx.fillRect(0, 0, 128, 128);
  // Sunglasses. It is the desert.
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(34, 46, 26, 16);
  ctx.fillRect(68, 46, 26, 16);
  ctx.fillRect(58, 50, 12, 4);
  // A grin, and chapped lips.
  ctx.strokeStyle = "#7a3a2a";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 74, 16, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = "#3a2a1a";
  ctx.fillRect(28, 20, 72, 14);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildRider(): Rider {
  const group = new THREE.Group();
  const lean = new THREE.Group();
  group.add(lean);
  const pitch = new THREE.Group();
  lean.add(pitch);

  const black = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.8 });
  const body = new THREE.MeshStandardMaterial({ color: 0x2b8f8a, roughness: 0.5, metalness: 0.3 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.8 });
  const hoodie = new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: 0.9 });
  const shorts = new THREE.MeshStandardMaterial({ color: 0x3a3f5c, roughness: 0.9 });
  const faceTex = faceTexture();
  const face = new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.7 });
  const note = new THREE.MeshBasicMaterial({ color: 0xffe08a });

  // The wheel: a 16-inch tyre is about 0.2 m radius; the game rides bigger.
  const wheelR = 0.3;
  const wheel = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(wheelR - 0.06, 0.06, 8, 20), black);
  tyre.rotation.y = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 12), body);
  hub.rotation.z = Math.PI / 2;
  wheel.add(tyre, hub);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, wheelR * 1.7, 0.02), body);
    spoke.rotation.x = (i / 3) * Math.PI;
    wheel.add(spoke);
  }
  wheel.position.y = wheelR;
  pitch.add(wheel);
  // The body case around the wheel, pedals, and the speaker on the front.
  const shell = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.5), body);
  shell.position.y = wheelR + 0.16;
  pitch.add(shell);
  for (const side of [-1, 1]) {
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.22), black);
    pedal.position.set(side * 0.16, wheelR - 0.02, 0);
    pitch.add(pedal);
  }
  const speaker = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.08), black);
  speaker.position.set(0, wheelR + 0.3, 0.27);
  pitch.add(speaker);
  const noteMesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), note);
  noteMesh.position.set(0.12, wheelR + 0.55, 0.3);
  pitch.add(noteMesh);

  // The rider.
  const person = new THREE.Group();
  person.position.y = wheelR + 0.1;
  pitch.add(person);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), skin);
    leg.position.set(side * 0.17, 0.35, 0);
    person.add(leg);
    const short = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.2, 3, 6), shorts);
    short.position.set(side * 0.16, 0.66, 0);
    person.add(short);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.24), black);
    shoe.position.set(side * 0.17, 0.02, 0.03);
    person.add(shoe);
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 8), hoodie);
  torso.position.y = 1.05;
  person.add(torso);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.42, 3, 6), hoodie);
    arm.position.set(side * 0.3, 1.05, 0.02);
    arm.rotation.z = side * 0.55;
    person.add(arm);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), face);
  head.position.y = 1.5;
  head.rotation.y = -Math.PI / 2;
  person.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), shorts);
  cap.position.y = 1.52;
  person.add(cap);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.14), shorts);
  brim.position.set(0, 1.55, 0.17);
  person.add(brim);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.14), black);
  pack.position.set(0, 1.08, -0.2);
  person.add(pack);

  let phase = 0;
  const geos: THREE.BufferGeometry[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.push(m.geometry);
  });

  return {
    group,
    update(dt, dist, leanIn, tilt, speed, fallen, music) {
      phase += dt;
      wheel.rotation.x += dist / wheelR;
      const targetLean = fallen > 0 ? (leanIn >= 0 ? 1.45 : -1.45) : -leanIn * 0.32 * Math.min(1, Math.abs(speed) / 3 + 0.3);
      lean.rotation.z += (targetLean - lean.rotation.z) * Math.min(1, dt * (fallen > 0 ? 10 : 6));
      const targetPitch = fallen > 0 ? 0 : tilt * 0.14 + speed * 0.012;
      pitch.rotation.x += (targetPitch - pitch.rotation.x) * Math.min(1, dt * 5);
      // Knees soak up the sand; the note bobs to the beat.
      person.position.y = wheelR + 0.1 + Math.sin(phase * 7) * 0.008 * Math.min(1, Math.abs(speed));
      noteMesh.visible = music;
      noteMesh.position.y = wheelR + 0.55 + Math.sin(phase * 4) * 0.04;
      group.position.y += 0;
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of [black, body, skin, hoodie, shorts, face, note]) m.dispose();
      faceTex.dispose();
    },
  };
}
