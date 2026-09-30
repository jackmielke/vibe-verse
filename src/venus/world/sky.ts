/**
 * The sky between the decks: a floor of cloud, a ceiling of cloud, and the
 * gap between them where the sun rises. Plus the weather in it — lightning
 * in the lower deck after dark, towers of cloud for scale, and the other
 * cities riding the same wind.
 */
import * as THREE from "three";
import { CEIL_FRAG, DECK_FRAG, NOISE, PUFF_FRAG, PUFF_VERT, SKY_FRAG, WORLD_VERT, type SkyUniforms } from "./shaders";
import { buildNeighbour, type Look, type Palette } from "./city";
import { LOWER_DECK_ALT, UPPER_DECK_ALT } from "../atmosphere";

/** Metres of scene per kilometre of altitude. Compressed, for framing. */
export const KM = 130;

interface Key {
  e: number;
  horizon: number; ceiling: number; top: number; mid: number; low: number; sun: number; sunK: number;
}

/* Keyed on the sun's elevation. The in-between is where the good stuff is. */
const KEYS: Key[] = [
  { e: -0.35, horizon: 0x2a1622, ceiling: 0x140c18, top: 0x3a2228, mid: 0x24141a, low: 0x120a0c, sun: 0x000000, sunK: 0 },
  { e: -0.08, horizon: 0x6a2c2a, ceiling: 0x34182a, top: 0x6a3230, mid: 0x3c1c1c, low: 0x1a0c0c, sun: 0xff4a20, sunK: 0.6 },
  { e: 0.02, horizon: 0xff8450, ceiling: 0xc07a82, top: 0xf6a27a, mid: 0xa0503a, low: 0x44201a, sun: 0xff6a32, sunK: 2.2 },
  { e: 0.16, horizon: 0xffc08a, ceiling: 0xf6d0ac, top: 0xffe0b8, mid: 0xd89a66, low: 0x7a4428, sun: 0xffbe78, sunK: 2.3 },
  // Late afternoon: apricot, the light everybody screenshots.
  { e: 0.3, horizon: 0xffcc94, ceiling: 0xfbdcb2, top: 0xffe6c0, mid: 0xe2a468, low: 0x8e542c, sun: 0xffcf92, sunK: 2.35 },
  { e: 0.5, horizon: 0xf4e2c0, ceiling: 0xfff1da, top: 0xfff2da, mid: 0xe8c490, low: 0xa87a4a, sun: 0xfff2dc, sunK: 2.1 },
  // High noon under the ceiling: nearly white, pearly, flat.
  { e: 1.0, horizon: 0xeee8d8, ceiling: 0xfffaf2, top: 0xfffaf0, mid: 0xeed8b0, low: 0xb09470, sun: 0xfffaf2, sunK: 2.2 },
];

const tmpA = new THREE.Color(), tmpB = new THREE.Color();

function lerpKey(e: number, pick: (k: Key) => number, out: THREE.Color) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].e < e) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = Math.max(0, Math.min(1, (e - a.e) / (b.e - a.e)));
  tmpA.setHex(pick(a));
  tmpB.setHex(pick(b));
  return out.copy(tmpA).lerp(tmpB, f);
}
function lerpNum(e: number, pick: (k: Key) => number) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].e < e) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = Math.max(0, Math.min(1, (e - a.e) / (b.e - a.e)));
  return pick(a) + (pick(b) - pick(a)) * f;
}

export class Sky {
  group = new THREE.Group();
  u: SkyUniforms;
  look: Look;
  deckColor = new THREE.Color();
  private dome: THREE.Mesh;
  private deck: THREE.Mesh;
  private ceil: THREE.Mesh;
  private puffs!: THREE.Mesh;
  private puffMat!: THREE.ShaderMaterial;
  private puffDeck = { value: -800 };
  private neighbours: Array<{ g: THREE.Group; a: number; r: number; y: number; w: number }> = [];
  private nextFlash = 3;
  deckY = -800;
  ceilY = 900;
  heat = 0;

  constructor(private palette: Palette, quality: "high" | "low") {
    const oct = quality === "high" ? 5 : 3;
    this.u = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.3, 0.5, 0.2).normalize() },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uHorizon: { value: new THREE.Color() },
      uCeiling: { value: new THREE.Color() },
      uDeckTop: { value: new THREE.Color() },
      uDeckMid: { value: new THREE.Color() },
      uDeckLow: { value: new THREE.Color() },
      uNight: { value: 0 },
      uHeat: { value: 0 },
      uFlash: { value: 0 },
      uFlashPos: { value: new THREE.Vector2() },
      uFogDensity: { value: 0.00016 },
    };
    const defs = { OCTAVES: oct };
    const mat = (frag: string, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({
        uniforms: this.u as unknown as Record<string, THREE.IUniform>,
        vertexShader: WORLD_VERT,
        fragmentShader: NOISE + frag,
        defines: defs,
        ...extra,
      });

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(40000, 32, 16), mat(SKY_FRAG, { side: THREE.BackSide, depthWrite: false }));
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    const plane = new THREE.PlaneGeometry(90000, 90000, 1, 1);
    plane.rotateX(-Math.PI / 2);
    this.deck = new THREE.Mesh(plane, mat(DECK_FRAG));
    this.group.add(this.deck);

    const plane2 = plane.clone();
    plane2.rotateX(Math.PI);
    this.ceil = new THREE.Mesh(plane2, mat(CEIL_FRAG));
    this.group.add(this.ceil);

    // Towers of cloud, one draw call: every heap is four vertices that the
    // vertex shader turns to face the camera.
    {
      const N = 46;
      const center = new Float32Array(N * 4 * 3);
      const corner = new Float32Array(N * 4 * 2);
      const size = new Float32Array(N * 4 * 2);
      const seed = new Float32Array(N * 4);
      const index: number[] = [];
      let s = 7;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let i = 0; i < N; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 2200 + Math.pow(rnd(), 0.8) * 12000;
        const sc = 300 + rnd() * 700;
        const w = sc * (1.3 + rnd() * 1.2);
        for (let k = 0; k < 4; k++) {
          const v = i * 4 + k;
          center.set([Math.cos(a) * r, sc * 0.3, Math.sin(a) * r], v * 3);
          corner.set(C[k], v * 2);
          size.set([w, sc], v * 2);
          seed[v] = rnd();
        }
        index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(center.slice(), 3));
      g.setAttribute("center", new THREE.BufferAttribute(center, 3));
      g.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
      g.setAttribute("size", new THREE.BufferAttribute(size, 2));
      g.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
      g.setIndex(index);
      this.puffMat = new THREE.ShaderMaterial({
        uniforms: { ...(this.u as unknown as Record<string, THREE.IUniform>), uDeckY: this.puffDeck },
        vertexShader: PUFF_VERT,
        fragmentShader: NOISE + PUFF_FRAG,
        defines: { OCTAVES: 4 },
        transparent: true,
        depthWrite: false,
      });
      this.puffs = new THREE.Mesh(g, this.puffMat);
      this.puffs.frustumCulled = false;
      this.puffs.renderOrder = 1;
      this.group.add(this.puffs);
    }

    const plans: Array<[number, number, number, number, number]> = [
      [0.9, 1500, -40, 20, 101],
      [2.4, 2300, 60, 26, 202],
      [3.8, 3400, -120, 34, 303],
      [5.2, 4600, 40, 18, 404],
      [1.7, 6200, -60, 30, 505],
    ];
    for (const [a, r, y, n, seed] of plans) {
      const g = buildNeighbour(palette, seed, n);
      g.scale.setScalar(0.9);
      this.group.add(g);
      this.neighbours.push({ g, a, r, y, w: 0.004 + (seed % 7) * 0.0006 });
    }

    this.look = {
      sunDir: this.u.uSunDir.value,
      sunCol: this.u.uSunCol.value,
      ceiling: this.u.uCeiling.value,
      horizon: this.u.uHorizon.value,
      night: 0,
    };
  }

  /**
   * @param dayPhase 0..1 round the planet; 0.25 is noon.
   * @param altKm the city's altitude, which moves the floor and ceiling.
   */
  update(dt: number, time: number, dayPhase: number, altKm: number, camera: THREE.Camera) {
    const u = this.u;
    u.uTime.value = time;
    const ang = dayPhase * Math.PI * 2;
    // East to west, with the ecliptic tilted off the zenith so noon is not
    // straight overhead — the patch of glow in the ceiling reads better at 60°.
    const sd = u.uSunDir.value;
    sd.set(Math.cos(ang), Math.sin(ang) * 0.86, 0.42).normalize();
    const e = sd.y;

    lerpKey(e, (k) => k.horizon, u.uHorizon.value);
    lerpKey(e, (k) => k.ceiling, u.uCeiling.value);
    lerpKey(e, (k) => k.top, u.uDeckTop.value);
    lerpKey(e, (k) => k.mid, u.uDeckMid.value);
    lerpKey(e, (k) => k.low, u.uDeckLow.value);
    lerpKey(e, (k) => k.sun, u.uSunCol.value).multiplyScalar(lerpNum(e, (k) => k.sunK));
    const night = 1 - Math.max(0, Math.min(1, (e + 0.12) / 0.3));
    u.uNight.value = night;
    this.look.night = night;

    // Too low: everything goes the colour of an oven.
    const heat = Math.max(0, Math.min(1, (51 - altKm) / 5));
    this.heat += (heat - this.heat) * Math.min(1, dt * 2);
    // The surface is 462 °C. At night, artistically if not spectroscopically,
    // the floor keeps a faint ember of it.
    u.uHeat.value = this.heat + night * 0.18;
    const hot = tmpA.setRGB(1.0, 0.36, 0.1);
    u.uHorizon.value.lerp(hot, this.heat * 0.6);
    u.uCeiling.value.lerp(tmpB.setRGB(0.7, 0.25, 0.1), this.heat * 0.45);
    u.uFogDensity.value = 0.00013 + this.heat * 0.0005 + Math.max(0, 50 - altKm) * 0.0002;

    this.deckY = -(altKm - LOWER_DECK_ALT) * KM;
    this.ceilY = (UPPER_DECK_ALT - altKm) * KM;
    // Follow the camera in xz so the planes never show an edge.
    this.deck.position.set(camera.position.x, this.deckY, camera.position.z);
    this.ceil.position.set(camera.position.x, this.ceilY, camera.position.z);
    this.dome.position.copy(camera.position);

    this.deckColor.copy(u.uDeckTop.value);
    this.puffDeck.value = this.deckY;

    for (const n of this.neighbours) {
      n.a += n.w * dt * 0.02;
      n.g.position.set(Math.cos(n.a) * n.r, n.y + Math.sin(time * 0.1 + n.r) * 6, Math.sin(n.a) * n.r);
      n.g.rotation.y += dt * 0.004;
    }

    // Lightning, after dark, in the deck.
    u.uFlash.value *= Math.exp(-dt * 7);
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.nextFlash = 1.5 + Math.random() * (night > 0.5 ? 5 : 30);
      if (night > 0.3) {
        u.uFlash.value = 1 + Math.random();
        const a = Math.random() * Math.PI * 2, r = 1500 + Math.random() * 6000;
        u.uFlashPos.value.set(camera.position.x + Math.cos(a) * r, camera.position.z + Math.sin(a) * r);
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m === this.dome || m === this.deck || m === this.ceil)) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.puffMat.dispose();
    this.puffs.geometry.dispose();
  }
}

