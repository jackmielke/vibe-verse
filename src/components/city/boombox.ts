/**
 * VIBE FM boombox — the physical radio you walk up to.
 *
 * A chunky retro deck on a wooden crate: twin speakers, amber LCD,
 * knobs, a bent antenna. When music is playing the speaker cones pump,
 * an amber light pulses, and little ♪ notes drift up off the handle.
 *
 * The mesh is pure decoration — the audio engine lives in the global
 * VibeRadio component; City opens its deck UI via the "vibefm:open"
 * window event when the player interacts with this thing.
 */
import * as THREE from "three";

export interface Boombox {
  group: THREE.Group;
  /** Call every frame. `playing` animates cones/notes/light. */
  update(dt: number, now: number, playing: boolean): void;
}

function noteTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  x.clearRect(0, 0, 64, 64);
  x.font = "bold 48px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.shadowColor = "#ffd166";
  x.shadowBlur = 10;
  x.fillStyle = "#ffe9b3";
  x.fillText("♪", 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lcdTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const x = c.getContext("2d")!;
  x.fillStyle = "#161009";
  x.fillRect(0, 0, 256, 96);
  x.strokeStyle = "rgba(255,205,130,0.5)";
  x.lineWidth = 4;
  x.strokeRect(3, 3, 250, 90);
  x.font = "bold 44px 'Sora', system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.shadowColor = "#ffb347";
  x.shadowBlur = 14;
  x.fillStyle = "#ffd166";
  x.fillText("VIBE FM", 128, 36);
  x.shadowBlur = 0;
  x.font = "20px 'Manrope', sans-serif";
  x.fillStyle = "#e8b56a";
  x.fillText("walk up · tune in", 128, 72);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeBoombox(): Boombox {
  const group = new THREE.Group();

  // Wooden crate stand.
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 0.78, 0.85),
    new THREE.MeshStandardMaterial({ color: "#8a6a45", roughness: 0.92 }),
  );
  crate.position.y = 0.39;
  group.add(crate);
  // Crate lid trim so it doesn't read as a featureless block.
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(1.45, 0.07, 0.95),
    new THREE.MeshStandardMaterial({ color: "#6f5334", roughness: 0.9 }),
  );
  lid.position.y = 0.815;
  group.add(lid);

  // Boombox body.
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 0.88, 0.52),
    new THREE.MeshStandardMaterial({ color: "#242a33", roughness: 0.5, metalness: 0.35 }),
  );
  body.position.y = 1.29;
  group.add(body);

  // Handle.
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.08, 0.1),
    new THREE.MeshStandardMaterial({ color: "#39424e", roughness: 0.45, metalness: 0.5 }),
  );
  handle.position.y = 1.86;
  group.add(handle);
  for (const s of [-0.46, 0.46]) {
    const strut = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.16, 0.1),
      handle.material,
    );
    strut.position.set(s, 1.78, 0);
    group.add(strut);
  }

  // Antenna, leaning off the right shoulder.
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.025, 1.05, 6),
    new THREE.MeshStandardMaterial({ color: "#9fb2c4", roughness: 0.35, metalness: 0.8 }),
  );
  antenna.position.set(0.72, 2.15, -0.06);
  antenna.rotation.z = -0.42;
  group.add(antenna);
  const antTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 8, 8),
    new THREE.MeshStandardMaterial({ color: "#ffd166", emissive: "#ffb347", emissiveIntensity: 0.8 }),
  );
  antTip.position.set(0.94, 2.62, -0.06);
  group.add(antTip);

  // Twin speakers on the front face (+z).
  const cones: THREE.Mesh[] = [];
  for (const sx of [-0.55, 0.55]) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.27, 0.035, 10, 28),
      new THREE.MeshStandardMaterial({ color: "#ffb347", roughness: 0.4, metalness: 0.4 }),
    );
    rim.position.set(sx, 1.29, 0.265);
    group.add(rim);
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.13, 0.1, 20),
      new THREE.MeshStandardMaterial({ color: "#12151a", roughness: 0.85 }),
    );
    cone.rotation.x = Math.PI / 2;
    cone.position.set(sx, 1.29, 0.24);
    group.add(cone);
    cones.push(cone);
  }

  // Amber LCD between the speakers.
  const lcd = new THREE.Mesh(
    new THREE.PlaneGeometry(0.52, 0.2),
    new THREE.MeshBasicMaterial({ map: lcdTexture(), transparent: false }),
  );
  lcd.position.set(0, 1.42, 0.267);
  group.add(lcd);

  // Two chunky knobs under the LCD.
  for (const kx of [-0.12, 0.12]) {
    const knob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12),
      new THREE.MeshStandardMaterial({ color: "#c8ccd2", roughness: 0.35, metalness: 0.6 }),
    );
    knob.rotation.x = Math.PI / 2;
    knob.position.set(kx, 1.13, 0.27);
    group.add(knob);
  }

  // Pulsing amber glow when the music's on.
  const light = new THREE.PointLight(0xffb347, 0, 9, 1.9);
  light.position.set(0, 1.5, 0.6);
  group.add(light);

  // Floating ♪ notes — three sprites cycling up off the deck.
  const noteTex = noteTexture();
  const notes: Array<{ s: THREE.Sprite; phase: number }> = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.SpriteMaterial({
      map: noteTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(0.34);
    s.position.set(0, 1.9, 0);
    group.add(s);
    notes.push({ s, phase: i / 3 });
  }

  const update = (dt: number, now: number, playing: boolean) => {
    if (playing) {
      // Beat-ish speaker pump.
      const pump = 1 + Math.max(0, Math.sin(now * 0.012)) * 0.16;
      for (const c of cones) c.scale.set(pump, 1, pump);
      light.intensity = 4 + Math.sin(now * 0.012) * 2.2;
      for (const n of notes) {
        const k = ((now * 0.00035 + n.phase) % 1 + 1) % 1;
        n.s.position.set(
          Math.sin((k + n.phase) * Math.PI * 4) * 0.35,
          1.95 + k * 1.6,
          0.15,
        );
        (n.s.material as THREE.SpriteMaterial).opacity =
          k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
      }
    } else {
      for (const c of cones) c.scale.set(1, 1, 1);
      light.intensity = 0;
      for (const n of notes) (n.s.material as THREE.SpriteMaterial).opacity = 0;
    }
  };

  return { group, update };
}
