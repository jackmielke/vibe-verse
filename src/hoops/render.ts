/**
 * VIBE HOOPS — the broadcast.
 *
 * Owns the three.js scene: the arena from `arena.ts`, a body per player from
 * `bodies.ts`, the ball, and the cameras. The rules never know any of this
 * exists; every frame the page hands over the `Game` and its events, and this
 * decides what a television director would show:
 *
 *  - **intro**: a sweep down from the jumbotron to the floor while the beams
 *    go round and the pyro goes off at the tip.
 *  - **tv**: the sideline camera, high, following the ball. On a phone held
 *    upright it moves behind the baseline so the court runs up the screen.
 *  - **dunk**: a low camera at the rim, while the rules run in slow motion.
 *  - **replay**: after a dunk, a three or a buzzer beater, the last two
 *    seconds again from the baseline at half speed, letterboxed, and on the
 *    jumbotron too.
 *  - **final**: a slow orbit under falling confetti.
 *
 * The jumbotron's screen is a live camera of its own (a close-up on the
 * ball), rendered into a texture a few times a second.
 *
 * `snapshot()` returns the frame as a data URL straight after drawing it,
 * because `page.screenshot()` does not composite this canvas in the sandbox.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { CharSpec } from "@/lib/characters";
import { buildArena, type Arena } from "./arena";
import { buildBody, placeholderBody, type Body } from "./bodies";
import {
  ACTS, BALL_R, HALF_L, HOOP_X, RIM_H, attackDir, clockLabel, type Game, type GameEvent, type TeamId,
} from "./game";

export type Cinema = "attract" | "game";

const PLAYER_COLORS = ["#22d3ee", "#f472b6", "#facc15", "#a3e635", "#fb923c", "#c084fc"];
export const playerColor = (k: number) => PLAYER_COLORS[k % PLAYER_COLORS.length];

interface Rec {
  t: number;
  p: Float32Array;
  b: [number, number, number];
  held: number;
}
const PSTRIDE = 7;

export interface Shout {
  text: string;
  sub: string;
  t: number;
}

export class HoopsView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 400);
  private feedCam = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 200);
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  arena: Arena | null = null;
  private bodies: Body[] = [];
  private holders: THREE.Group[] = [];
  private rings: THREE.Mesh[] = [];
  private markers: THREE.Mesh[] = [];
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private trail: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private env: THREE.Texture | null = null;
  private clubKey = "";
  private w = 1;
  private h = 1;
  private quality: "high" | "low";
  private hype = 0;
  private time = 0;
  private dribblePhase = 0;
  private lastDribble = 0;
  private history: Rec[] = [];
  private attractShot = -1;
  private replay: { from: number; to: number; at: number; speed: number; side: number; kind: string } | null = null;
  private dunkCam: { until: number; side: number; sx: number; sy: number } | null = null;
  private shake = 0;
  private camPos = new THREE.Vector3(0, 8, 18);
  private camLook = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private feedTick = 0;
  /** Controller index → player index, and which team the people mostly play for. */
  mine: number[] = [];
  homeTeam: TeamId = 0;
  shout: Shout = { text: "", sub: "", t: 0 };
  onDribble?: () => void;
  ready = false;
  private loadToken = 0;
  private yaw: number[] = [];

  constructor(canvas: HTMLCanvasElement, quality: "high" | "low") {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === "high", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === "high" ? 1.75 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x05040a);
    this.scene.fog = new THREE.FogExp2(0x0a0716, 0.012);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();

    // The ball: orange leather and black seams, drawn.
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "#e0661c";
    g.fillRect(0, 0, 256, 128);
    for (let k = 0; k < 900; k++) {
      g.fillStyle = `rgba(${120 + Math.random() * 60},${40 + Math.random() * 20},10,0.25)`;
      g.fillRect(Math.random() * 256, Math.random() * 128, 1.5, 1.5);
    }
    g.strokeStyle = "#1a0d05";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, 64);
    g.lineTo(256, 64);
    for (const x of [64, 192]) {
      g.moveTo(x, 0);
      g.lineTo(x, 128);
    }
    g.stroke();
    g.beginPath();
    for (let x = 0; x <= 256; x += 4) g.lineTo(x, 64 + Math.sin((x / 256) * Math.PI * 4) * 38);
    g.stroke();
    const bt = new THREE.CanvasTexture(c);
    bt.colorSpace = THREE.SRGBColorSpace;
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ map: bt, roughness: 0.65 }));
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    if (quality === "high") {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    this.composer?.setSize(this.w, this.h);
    this.bloom?.setSize(this.w / 2, this.h / 2);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
  }

  get portrait() {
    return this.h > this.w * 1.05;
  }

  /** Build (or rebuild) the arena for these clubs, and a body for everybody on the floor. */
  async load(g: Game, me: CharSpec | null) {
    const token = ++this.loadToken;
    const key = `${g.clubs[0].id}-${g.clubs[1].id}`;
    if (key !== this.clubKey) {
      if (this.arena) {
        this.scene.remove(this.arena.group);
        this.arena.dispose();
      }
      this.arena = buildArena(g.clubs, this.quality);
      this.scene.add(this.arena.group);
      this.arena.group.traverse((o) => {
        if (o.name === "court") {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          m.envMap = this.env;
          m.envMapIntensity = 0.9;
          m.needsUpdate = true;
        }
      });
      this.clubKey = key;
    }
    for (const h of this.holders) this.scene.remove(h);
    for (const b of this.bodies) b.dispose();
    this.bodies = [];
    this.holders = [];
    this.rings = [];
    this.markers = [];
    this.yaw = [];
    const ringGeo = new THREE.RingGeometry(0.46, 0.58, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const markGeo = new THREE.ConeGeometry(0.16, 0.32, 4);
    markGeo.rotateX(Math.PI);
    g.players.forEach((p) => {
      const holder = new THREE.Group();
      this.scene.add(holder);
      this.holders.push(holder);
      const color = g.clubs[p.team].color;
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
      ring.position.y = 0.015;
      this.scene.add(ring);
      this.rings.push(ring);
      const k = p.ctrl;
      const mark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: k >= 0 ? playerColor(k) : "#ffffff", depthTest: false, toneMapped: false }));
      mark.renderOrder = 10;
      mark.visible = k >= 0;
      this.scene.add(mark);
      this.markers.push(mark);
      const ph = placeholderBody(color);
      holder.add(ph.root);
      this.bodies.push(ph);
      this.yaw.push(0);
    });
    // The real bodies, as they arrive.
    await Promise.all(
      g.players.map(async (p, i) => {
        try {
          const b = await buildBody(p.who, this.renderer, me);
          if (token !== this.loadToken) return b.dispose();
          const holder = this.holders[i];
          holder.remove(this.bodies[i].root);
          this.bodies[i].dispose();
          holder.add(b.root);
          this.bodies[i] = b;
        } catch {
          /* the placeholder stays */
        }
      }),
    );
    if (token === this.loadToken) this.ready = true;
  }

  /** Turn a thumb-stick (screen right, screen down) into the court's x/y, for whatever camera is live. */
  stickToCourt(sx: number, sy: number): [number, number] {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    // three (x, z) is court (x, y); screen up is the camera's forward.
    const x = r.x * sx - f.x * sy;
    const z = r.z * sx - f.z * sy;
    return [x, z];
  }

  /** Where a player's head is on screen, in CSS pixels, for the page's meters. */
  project(i: number): { x: number; y: number; on: boolean } {
    const h = this.holders[i];
    if (!h) return { x: 0, y: 0, on: false };
    const v = new THREE.Vector3(h.position.x, h.position.y + 2.3, h.position.z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h, on: v.z < 1 };
  }

  get replaying() {
    return !!this.replay;
  }

  /** Show something big on the jumbotron and the page. */
  say(text: string, sub = "") {
    this.shout = { text, sub, t: 0 };
  }

  private record(g: Game) {
    const p = new Float32Array(g.players.length * PSTRIDE);
    g.players.forEach((q, k) => {
      const o = k * PSTRIDE;
      p[o] = q.x;
      p[o + 1] = q.y;
      p[o + 2] = q.z;
      p[o + 3] = q.face;
      p[o + 4] = Math.hypot(q.vx, q.vy);
      p[o + 5] = ACTS.indexOf(q.act);
      p[o + 6] = q.actT;
    });
    this.history.push({ t: g.t, p, b: [g.ball.x, g.ball.y, g.ball.z], held: g.ball.owner });
    while (this.history.length && this.history[0].t < g.t - 4) this.history.shift();
  }

  private sample(t: number): Rec | null {
    const h = this.history;
    if (!h.length) return null;
    if (t <= h[0].t) return h[0];
    for (let k = 1; k < h.length; k++) {
      if (h[k].t >= t) {
        const a = h[k - 1];
        const b = h[k];
        const u = (t - a.t) / (b.t - a.t || 1);
        const p = new Float32Array(a.p.length);
        for (let i = 0; i < p.length; i++) {
          const j = i % PSTRIDE;
          p[i] = j === 5 ? (u < 0.5 ? a.p[i] : b.p[i]) : a.p[i] + (b.p[i] - a.p[i]) * u;
        }
        return { t, p, b: [a.b[0] + (b.b[0] - a.b[0]) * u, a.b[1] + (b.b[1] - a.b[1]) * u, a.b[2] + (b.b[2] - a.b[2]) * u], held: u < 0.5 ? a.held : b.held };
      }
    }
    return h[h.length - 1];
  }

  /** React to what just happened: shouts, replays, the dunk camera, the crowd. */
  events(g: Game, ev: GameEvent[]) {
    for (const e of ev) {
      switch (e.type) {
        case "score": {
          const p = g.players[e.i];
          const side = Math.sign(attackDir(e.team));
          this.arena?.swish(side, e.big);
          this.hype = Math.max(this.hype, e.big ? 1 : 0.6);
          const name = p.who.id === "me" ? "YOU" : p.who.name.toUpperCase();
          if (e.buzzer) this.say("BUZZER BEATER!", name);
          else if (e.kind === "dunk") this.say(["SLAM!", "BOOM!", "JAM!", "THUNDER!"][Math.floor(g.t * 7) % 4], `${name} THROWS IT DOWN`);
          else if (e.pts === 3) this.say(e.swish ? "SPLASH!" : "FROM DOWNTOWN!", `${name} FOR THREE`);
          else if (e.perfect) this.say("NOTHING BUT NET", name);
          else this.say(`+${e.pts}`, name);
          if (e.kind === "dunk" || e.buzzer) this.arena?.pyro();
          if (e.big) {
            // Replay the last couple of seconds once the shouting starts.
            const len = e.kind === "dunk" ? 1.9 : 2.3;
            this.replay = { from: g.t - len, to: g.t + 0.35, at: -1.1, speed: 0.5, side, kind: e.kind };
          }
          break;
        }
        case "dunk":
          this.dunkCam = { until: g.t + 1.4, side: Math.sign(attackDir(g.players[e.i].team)), sx: g.players[e.i].x, sy: g.players[e.i].y };
          this.hype = Math.max(this.hype, 0.8);
          if (e.alley) this.say("ALLEY-OOP!", g.players[e.i].who.name.toUpperCase());
          break;
        case "block":
          this.say("REJECTED!", g.players[e.i].who.name.toUpperCase());
          this.hype = Math.max(this.hype, 0.85);
          this.shake = 0.35;
          break;
        case "steal":
          this.say("PICKED!", g.players[e.i].who.name.toUpperCase());
          this.hype = Math.max(this.hype, 0.5);
          break;
        case "turnover":
          this.say(e.why === "shotclock" ? "SHOT CLOCK!" : "OUT OF BOUNDS");
          break;
        case "tip":
          this.arena?.pyro();
          this.hype = 0.9;
          break;
        case "sudden":
          this.say("SUDDEN DEATH", "NEXT BUCKET WINS");
          this.hype = 1;
          break;
        case "final": {
          const club = g.clubs[e.winner];
          this.say(`${club.short} WIN`, `${g.score[0]} - ${g.score[1]}`);
          this.arena?.pyro();
          this.arena?.confetti(true);
          this.hype = 1;
          break;
        }
        case "shot":
          if (e.pts === 3) this.hype = Math.max(this.hype, 0.45);
          break;
      }
    }
  }

  /** Draw a frame. `dt` is real time; the game has already been stepped. */
  frame(g: Game, dt: number, cinema: Cinema, draw = true) {
    if (!this.arena) return;
    dt = Math.max(0, dt);
    this.time += dt;
    this.shout.t += dt;
    if (this.shout.t > 3.2) this.shout.text = "";
    this.record(g);
    if (g.phase === "intro") this.hype = 1;
    else if (g.phase !== "over") this.hype = Math.max(g.sudden ? 0.5 : 0.12, this.hype - dt * 0.28);
    if (g.phase !== "over" && g.phase !== "score") this.arena.confetti(false);

    // A replay runs during the score break, from the history.
    let rec: Rec | null = null;
    if (this.replay) {
      const r = this.replay;
      r.at += dt;
      if (g.phase !== "score" || r.at > (r.to - r.from) / r.speed) this.replay = null;
      else if (r.at >= 0) rec = this.sample(r.from + r.at * r.speed);
    }

    this.posePlayers(g, dt * (rec ? (this.replay?.speed ?? 1) : 1), rec);
    this.poseBall(g, dt, rec);
    this.arena.update(dt, this.time, this.hype);
    this.arena.scoreboard({
      clubs: g.clubs,
      score: g.score,
      clock: clockLabel(g),
      shot: g.shotClock,
      shout: this.shout.text,
      sub: this.shout.sub,
      shoutT: this.shout.t,
      replay: !!rec,
    });
    this.direct(g, dt, cinema, rec);

    // The jumbotron's live feed: a close-up on the ball, a few times a second.
    if (!draw) return;
    this.feedTick -= dt;
    if (this.feedTick <= 0) {
      this.feedTick = this.quality === "high" ? 1 / 15 : 1 / 6;
      const bx = this.ball.position;
      this.feedCam.position.set(bx.x - 3.2, 2.4, bx.z + 3.4);
      this.feedCam.lookAt(bx.x, 1.6, bx.z);
      this.feedCam.aspect = 7.2 / 3.8;
      this.feedCam.updateProjectionMatrix();
      const jumbo = this.arena.jumbo;
      jumbo.visible = false;
      this.renderer.setRenderTarget(this.arena.feed);
      this.renderer.render(this.scene, this.feedCam);
      this.renderer.setRenderTarget(null);
      jumbo.visible = true;
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  snapshot(): string {
    if (this.composer) this.composer.render(0);
    else this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/jpeg", 0.85);
  }

  private posePlayers(g: Game, dt: number, rec: Rec | null) {
    const over = g.phase === "over";
    const winner = over ? (g.score[0] > g.score[1] ? 0 : 1) : -1;
    const scorer = g.phase === "score" && g.lastScore && g.phaseT < 2.6 ? g.lastScore.i : -1;
    g.players.forEach((p, i) => {
      const holder = this.holders[i];
      const body = this.bodies[i];
      if (!holder || !body) return;
      let x = p.x;
      let y = p.y;
      let z = p.z;
      let face = p.face;
      let speed = Math.hypot(p.vx, p.vy);
      let act = p.act;
      let actT = p.actT;
      let has = g.ball.owner === i;
      if (rec) {
        const o = i * PSTRIDE;
        x = rec.p[o];
        y = rec.p[o + 1];
        z = rec.p[o + 2];
        face = rec.p[o + 3];
        speed = rec.p[o + 4];
        act = ACTS[Math.round(rec.p[o + 5])] ?? "none";
        actT = rec.p[o + 6];
        has = rec.held === i;
      }
      holder.position.set(x, z, y);
      // Smooth the facing a little: the rules turn on a sixtieth.
      const target = Math.PI / 2 - face;
      let d = target - this.yaw[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw[i] += d * Math.min(1, dt * 16);
      holder.rotation.y = this.yaw[i];
      const mood = over ? (p.team === winner ? "win" : "lose") : scorer === i || (scorer >= 0 && g.players[scorer].team === p.team && g.phaseT < 1.4 && !rec) ? "win" : "play";
      body.pose(dt, { speed, z, act, actT, has, mood });
      const ring = this.rings[i];
      ring.position.set(x, 0.015, y);
      const mine = p.ctrl >= 0;
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = mine ? 0.95 : 0.45;
      ring.scale.setScalar(mine ? 1.15 + Math.sin(this.time * 6) * 0.05 : 1);
      const mark = this.markers[i];
      mark.visible = mine && !rec && g.phase === "play" && !(this.dunkCam && g.t < this.dunkCam.until);
      mark.position.set(x, z + body.height + 0.55 + Math.sin(this.time * 4) * 0.06, y);
      mark.rotation.y = this.time * 2;
    });
  }

  private poseBall(g: Game, dt: number, rec: Rec | null) {
    const b = g.ball;
    let x = b.x;
    let y = b.y;
    let z = b.z;
    let held = b.owner;
    if (rec) {
      [x, y, z] = rec.b;
      held = rec.held;
    }
    const p = held >= 0 ? g.players[held] : null;
    const upAct = p && (p.act === "shoot" || p.act === "dunk" || p.act === "layup" || p.act === "hang");
    if (p && !rec && !upAct && p.z < 0.05 && g.phase === "play") {
      // The dribble: down to the floor and back up into the hand.
      const speed = Math.hypot(p.vx, p.vy);
      this.dribblePhase += dt * (2.2 + speed * 0.25);
      const s = Math.abs(Math.sin(this.dribblePhase * Math.PI));
      z = BALL_R + s * (0.95 - BALL_R);
      if (s < 0.08 && this.time - this.lastDribble > 0.2) {
        this.lastDribble = this.time;
        this.onDribble?.();
      }
    } else if (p && !rec && upAct) {
      const body = this.bodies[held];
      z = p.z + (body?.handY ?? 2.2) + 0.05;
    } else if (p && !rec && g.phase !== "play") {
      z = 1.0;
    }
    const prev = this.ball.position.clone();
    this.ball.position.set(x, z, y);
    // Roll with the travel.
    const mv = this.ball.position.clone().sub(prev);
    const l = mv.length();
    if (l > 1e-4 && l < 3) {
      const axis = new THREE.Vector3(mv.z, 0, -mv.x).normalize();
      if (axis.lengthSq() > 0) this.ball.rotateOnWorldAxis(axis, l / BALL_R);
    }
    this.ballShadow.position.set(x, 0.012, y);
    const hgt = Math.max(0, z - BALL_R);
    this.ballShadow.scale.setScalar(1 + hgt * 0.25);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.08, 0.45 - hgt * 0.06);
    // A trail on the way to the rim.
    const flying = rec ? held < 0 && z > 1.5 : b.state === "shot" || (b.state === "pass" && b.lob);
    if (flying) this.trailPts.push(this.ball.position.clone());
    else if (this.trailPts.length) this.trailPts.shift();
    while (this.trailPts.length > 24) this.trailPts.shift();
    const pos = this.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let k = 0; k < 24; k++) {
      const v = this.trailPts[Math.min(k, this.trailPts.length - 1)] ?? this.ball.position;
      pos.setXYZ(k, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    const fire = b.shot?.perfect;
    (this.trail.material as THREE.LineBasicMaterial).color.setHex(fire ? 0xffa040 : 0xffffff);
    (this.trail.material as THREE.LineBasicMaterial).opacity = this.trailPts.length > 1 ? (fire ? 0.9 : 0.35) : 0;
  }

  private direct(g: Game, dt: number, cinema: Cinema, rec: Rec | null) {
    const cam = this.camera;
    const portrait = this.portrait;
    const aspect = this.w / this.h;
    const want = new THREE.Vector3();
    const look = new THREE.Vector3();
    let snap = false;
    let fovH = portrait ? 66 : 62;
    const t = this.time;

    // What to follow: the ball, a little ahead of where it is going.
    const bp = this.ball.position;
    const lead = g.ball.state === "held" ? 0 : 0.25;
    this.focus.lerp(new THREE.Vector3(bp.x + g.ball.vx * lead, 0, bp.z + g.ball.vy * lead), Math.min(1, dt * 3));
    const fx = THREE.MathUtils.clamp(this.focus.x, -HALF_L + 2, HALF_L - 2);
    const fz = this.focus.z;

    if (cinema === "attract") {
      // Two shots, cut between every eleven seconds: the wide one that shows
      // off the bowl and the jumbotron, then a low orbit on the game.
      const shot = Math.floor(t / 11) % 2;
      if (shot !== this.attractShot) {
        this.attractShot = shot;
        snap = true;
      }
      const a = t * 0.08;
      if (shot === 0) {
        want.set(Math.sin(a) * 25, 11.5, Math.cos(a) * 19);
        look.set(0, 5.2, 0);
        fovH = 74;
      } else {
        want.set(Math.sin(a + 1.6) * 17, 4.2 + Math.sin(t * 0.13), Math.cos(a + 1.6) * 13);
        look.set(fx * 0.5, 1.3, fz * 0.4);
        fovH = 64;
      }
    } else if (g.phase === "intro") {
      const u = Math.min(1, g.phaseT / g.phaseLen);
      const e = u * u * (3 - 2 * u);
      const a = -2.4 + e * 2.4;
      // Starts high over the lower bowl (any further out and it is inside the suites).
      const r = 22 - e * 5;
      want.set(Math.sin(a) * r, 15 - e * 8, Math.cos(a) * r);
      look.lerpVectors(new THREE.Vector3(0, 13, 0), new THREE.Vector3(0, 1, 0), Math.min(1, e * 1.3));
      fovH = 70;
      snap = true;
    } else if (rec && this.replay) {
      // Replay: from the baseline, low, the rim in frame.
      const s = this.replay.side;
      const k = this.replay.kind === "dunk";
      const bx = rec.b[0];
      const bz = rec.b[1];
      want.set(s * (HALF_L + (k ? 1.2 : 3.5)), k ? 1.4 : 2.6, (bz > 0 ? -1 : 1) * (k ? 3.6 : 5.5));
      look.set((bx + s * HOOP_X) / 2 + s * 1.5, k ? RIM_H - 0.6 : 2.2, bz * 0.5);
      fovH = portrait ? 62 : 54;
      snap = this.replay.at < 0.05;
    } else if (g.phase === "over") {
      const a = t * 0.12;
      want.set(Math.sin(a) * 13, 4.5, Math.cos(a) * 11);
      look.set(0, 1.6, 0);
      fovH = 68;
    } else if (this.dunkCam && g.t < this.dunkCam.until) {
      const d = this.dunkCam;
      const rimX = d.side * HOOP_X;
      // In front of the rim, off to the side the dunker came from.
      const ang = Math.atan2(d.sy, d.sx - rimX);
      const off = ang + (d.sy >= 0 ? -0.9 : 0.9);
      want.set(rimX + Math.cos(off) * 5.2, 1.1, Math.sin(off) * 5.2);
      look.set(rimX - d.side * 0.6, RIM_H - 0.4, 0);
      fovH = portrait ? 70 : 58;
    } else if (portrait) {
      // Upright phone: behind the people's own basket, the court running up the screen.
      const s = attackDir(this.homeTeam);
      // Kept under 10 m: the jumbotron's lower ring hangs at about 12 over centre court.
      want.set(fx - s * 13, 9.6, fz * 0.35);
      look.set(fx + s * 3.6, 0, fz * 0.35);
      fovH = 74;
    } else {
      // The TV camera, high on the near sideline.
      want.set(fx * 0.82, 7.2, 16.8);
      look.set(fx * 0.95, 0.7, fz * 0.3 - 0.4);
    }
    if (this.dunkCam && g.t >= this.dunkCam.until) this.dunkCam = null;

    const k = snap ? 1 : Math.min(1, dt * (rec ? 6 : this.dunkCam ? 5 : 3.2));
    this.camPos.lerp(want, k);
    this.camLook.lerp(look, k);
    cam.position.copy(this.camPos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.6;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.6;
    }
    cam.lookAt(this.camLook);
    // Field of view: keep the horizontal angle whatever the shape of the screen.
    const vfov = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovH) / 2) / aspect) * 180) / Math.PI;
    const fov = THREE.MathUtils.clamp(vfov, 30, portrait ? 92 : 75);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (snap ? 1 : Math.min(1, dt * 4));
      cam.updateProjectionMatrix();
    }
  }

  dispose() {
    this.loadToken++;
    for (const b of this.bodies) b.dispose();
    this.arena?.dispose();
    this.env?.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
