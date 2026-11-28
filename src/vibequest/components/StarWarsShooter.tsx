import { useEffect, useRef, useState, useCallback } from 'react';
import { Character } from '@/vibequest/useCharacters';
import { TouchGamepad, TouchState } from '@/vibequest/components/TouchGamepad';
import vaderSprite from '@/assets/vibequest/boss-vader.webp';

interface StarWarsShooterProps {
  selectedCharacter: Character;
  onBack: () => void;
  onChangeCharacter?: () => void;
  onChangeMode?: () => void;
}

// ---- Constants ----
const CANVAS_W = 900;
const CANVAS_H = 550;
const GROUND_Y = 450;
const GRAVITY = 1800;
const JUMP_V = -720;
const MOVE_SPEED = 340;
const PLAYER_W = 54;
const PLAYER_H = 72;
const BOLT_SPEED = 780;
const BOLT_COOLDOWN = 0.22;
const VADER_W = 340;
const VADER_H = 460;
const VADER_MAX_HP = 20;
const SHOCKWAVE_H = 50;
const SHOCKWAVE_SPEED = 300;
const ATTACK_INTERVAL = 2.4;
const WINDUP_TIME = 0.85;

interface Bolt { x: number; y: number; vx: number; alive: boolean }
/**
 * Imperial reinforcements. Vader stomps, the ceiling opens and they drop in.
 * Numbers are Jack's spec (Nov 28 2026), all in one table so they are easy
 * to tune: Ferdi (the player) has PLAYER_MAX_HP and every player bolt does
 * PLAYER_BOLT_DMG.
 */
type TrooperKind = 'storm' | 'riot' | 'death';
const TROOPER_SPEC: Record<TrooperKind, {
  hp: number; shield: number; speed: number; fastSpeed: number; range: number;
  fireEvery: number; damage: number; w: number; h: number; score: number;
}> = {
  // walks in until in range, stops and fires; walks again if you leave range
  storm: { hp: 100, shield: 0, speed: 90, fastSpeed: 90, range: 260, fireEvery: 1.6, damage: 10, w: 40, h: 74, score: 25 },
  // creeps in behind the shield, bashes up close; runs and melees once the shield is gone
  riot: { hp: 175, shield: 100, speed: 42, fastSpeed: 185, range: 52, fireEvery: 1.3, damage: 30, w: 46, h: 76, score: 50 },
  // a blaster only, but it takes a lot to put down
  death: { hp: 300, shield: 0, speed: 90, fastSpeed: 90, range: 320, fireEvery: 1.25, damage: 20, w: 42, h: 80, score: 80 },
};
const PLAYER_MAX_HP = 100;
const PLAYER_BOLT_DMG = 25;
const SHOCKWAVE_DMG = 34;
const SHIELD_BREAK_HEAL = 25;
const CEILING_Y = 34;
/** Where the ceiling hatches are, as x of their centre. */
const HATCHES = [150, 290, 430, 560];
/** The waves, in order; after the last one it keeps sending the last two mixed. */
const WAVES: TrooperKind[][] = [
  ['storm', 'storm'],
  ['storm', 'riot'],
  ['riot', 'death'],
  ['storm', 'riot', 'death'],
];

interface Trooper {
  kind: TrooperKind;
  x: number; y: number; vy: number;
  hp: number; maxHp: number; shield: number;
  /** drop: falling from the hatch. land: crouched, not fighting yet. active: fighting. */
  state: 'drop' | 'land' | 'active';
  landT: number;
  shootTimer: number; phase: number; dir: number; hitFlash: number;
  /** Riot shield bash: wind-up and swing, 0..1. */
  strike: number; struck: boolean;
  shieldFlash: number;
}
interface EnemyBolt { x: number; y: number; vx: number; alive: boolean; dmg: number; death?: boolean }
interface Shockwave { x: number; y: number; w: number; h: number; hitCooldown: number; age: number; seed: number }

/** One spark, puff, foam fleck or Force mote. Everything that flies and fades. */
interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number;
  /** Gravity in px/s^2 (negative floats up). */
  g: number;
  /** Air drag per second, 0 keeps all speed. */
  drag: number;
  color: string;
  /** Drawn with additive blending, so overlapping sparks bloom. */
  glow: boolean;
  /** Grows as it fades (dust, mist) instead of shrinking (sparks). */
  grow?: boolean;
  /** Pulled toward a point each frame (Force motes into Vader's palm). */
  pull?: { x: number; y: number; k: number };
}

const makePlayer = () => ({
  x: 120, y: GROUND_Y - PLAYER_H, vx: 0, vy: 0, onGround: true, dir: 1, invuln: 0, boltCooldown: 0,
  /** Stride clock; advances with distance walked, not time, so feet never skate. */
  walkPhase: 0,
  /** 0..1 squash from a landing, eased out. */
  land: 0,
  /** Muzzle flash timer. */
  muzzle: 0,
  /** Gun kick, eased out. */
  kick: 0,
  dustTimer: 0,
  /** Ferdi's health. */
  hp: PLAYER_MAX_HP,
  /** Guard broken by a riot shield: knocked back, cannot shoot. */
  stun: 0,
  /** Green flash after a heal. */
  healFlash: 0,
});

const makeVader = () => ({
  hp: VADER_MAX_HP, attackTimer: 1.5, windup: 0, handRaise: 0, hitFlash: 0, recoil: 0, offset: 0, walkDir: -1, walkPhase: 0,
  /** Where the glove is on screen, written by the renderer, read by the Force motes. */
  handX: 0, handY: 0,
  /** Stomp that calls reinforcements: counts down from STOMP_TIME. */
  stomp: 0,
});
const STOMP_TIME = 0.8;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** Cheap deterministic wobble for the wave's surface. */
const ripple = (u: number, t: number, seed: number) =>
  Math.sin(u * 17 - t * 11 + seed) * 0.5 + Math.sin(u * 31 + t * 7 + seed * 2.3) * 0.3 + Math.sin(u * 53 - t * 19) * 0.2;

/**
 * Vader's attack arm, drawn with two-bone IK so the elbow bends like an elbow.
 * Coordinates are the body's local space with the shoulder at the origin and
 * Vader facing -x (toward the player). `curl` is 0 for an open, spread hand
 * and 1 for a clenched Force grip; `tremor` shakes the fingers.
 */
function drawVaderArm(
  ctx: CanvasRenderingContext2D,
  hx: number, hy: number,
  L1: number, L2: number,
  curl: number, tremor: number, t: number,
) {
  let d = Math.hypot(hx, hy);
  const maxD = L1 + L2 - 0.5;
  if (d > maxD) { hx *= maxD / d; hy *= maxD / d; d = maxD; }
  if (d < 1) d = 1;
  const a = Math.atan2(hy, hx);
  const cosB = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  // Elbow points down and back, away from the player.
  const upper = a + Math.acos(cosB) * (hx < 0 ? -1 : 1);
  const ex = Math.cos(upper) * L1, ey = Math.sin(upper) * L1;
  const fore = Math.atan2(hy - ey, hx - ex);

  const limb = (x0: number, y0: number, ang: number, len: number, w0: number, w1: number) => {
    ctx.save();
    ctx.translate(x0, y0);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, -w0, 0, w0);
    g.addColorStop(0, '#3a3a46');
    g.addColorStop(0.35, '#15151b');
    g.addColorStop(1, '#050507');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -w0);
    ctx.quadraticCurveTo(len * 0.5, -w0 * 1.08, len, -w1);
    ctx.lineTo(len, w1);
    ctx.quadraticCurveTo(len * 0.5, w0 * 1.02, 0, w0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(110,110,135,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // red rim light from the glow behind him, along the underside
    ctx.strokeStyle = 'rgba(255,50,40,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(len * 0.05, w0 * 0.92);
    ctx.quadraticCurveTo(len * 0.5, w0 * 0.98, len * 0.95, w1 * 0.92);
    ctx.stroke();
    // leather sheen along the top
    ctx.strokeStyle = 'rgba(160,160,190,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(len * 0.1, -w0 * 0.7);
    ctx.quadraticCurveTo(len * 0.5, -w0 * 0.85, len * 0.9, -w1 * 0.7);
    ctx.stroke();
    ctx.restore();
  };

  // shoulder armour
  ctx.fillStyle = '#0a0a0e';
  ctx.beginPath();
  ctx.ellipse(0, 0, 26, 22, upper, 0, Math.PI * 2);
  ctx.fill();
  limb(0, 0, upper, L1, 21, 18);
  limb(ex, ey, fore, L2, 18, 14);
  // elbow joint
  ctx.fillStyle = '#101016';
  ctx.strokeStyle = 'rgba(110,110,135,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ex, ey, 17, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // gauntlet cuff and glove
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(fore);
  ctx.scale(1.35, 1.35);
  ctx.shadowColor = 'rgba(255,40,30,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#1c1c24';
  ctx.beginPath(); ctx.roundRect(-16, -14, 16, 28, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(200,200,220,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-13, -12); ctx.lineTo(-13, 12); ctx.stroke();
  // palm
  ctx.fillStyle = '#0c0c10';
  ctx.beginPath(); ctx.ellipse(8, 0, 13, 12, 0, 0, Math.PI * 2); ctx.fill();
  // four fingers, fanned when open, curled to a claw when gripping
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const spread = (i - 1.5) * (0.32 - curl * 0.18);
    const shake = Math.sin(t * 47 + i * 1.7) * tremor * 0.12;
    const segs = [11 - Math.abs(i - 1.5) * 1.2, 8, 6];
    let x = 16, y = (i - 1.5) * 5.5, ang = spread + shake;
    ctx.strokeStyle = '#0c0c10';
    for (let k = 0; k < 3; k++) {
      const nx = x + Math.cos(ang) * segs[k], ny = y + Math.sin(ang) * segs[k];
      ctx.lineWidth = 6.5 - k * 1.2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      x = nx; y = ny;
      ang += curl * 0.85 * (i < 2 ? 1 : 1) + shake;
    }
    // knuckle glint
    ctx.fillStyle = 'rgba(180,180,210,0.25)';
    ctx.beginPath(); ctx.arc(16, (i - 1.5) * 5.5, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  // thumb
  ctx.strokeStyle = '#0c0c10';
  ctx.lineWidth = 6;
  const ta = -1.1 + curl * 0.9;
  ctx.beginPath();
  ctx.moveTo(6, -9);
  ctx.lineTo(6 + Math.cos(ta) * 10, -9 + Math.sin(ta) * 10);
  ctx.lineTo(6 + Math.cos(ta) * 10 + Math.cos(ta + 0.6 + curl * 0.6) * 8, -9 + Math.sin(ta) * 10 + Math.sin(ta + 0.6 + curl * 0.6) * 8);
  ctx.stroke();
  ctx.restore();
  return { ex, ey, fore };
}

export const StarWarsShooter = ({
  selectedCharacter,
  onBack,
  onChangeCharacter,
  onChangeMode,
}: StarWarsShooterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isVictory, setIsVictory] = useState(false);
  const [score, setScore] = useState(0);
  const [vaderHp, setVaderHp] = useState(VADER_MAX_HP);
  const [isTouch, setIsTouch] = useState(false);

  // Mutable game state in a ref so the loop can mutate without React re-renders.
  const stateRef = useRef({
    player: makePlayer(),
    bolts: [] as Bolt[],
    particles: [] as Particle[],
    shake: 0,
    shockwaves: [] as Shockwave[],
    troopers: [] as Trooper[],
    enemyBolts: [] as EnemyBolt[],
    trooperTimer: 6,
    wave: 0,
    /** How open each ceiling hatch is, 0..1, and how long it stays open. */
    hatchOpen: HATCHES.map(() => 0),
    hatchHold: HATCHES.map(() => 0),
    /** Kinds waiting to drop when the stomp lands. */
    pendingWave: [] as TrooperKind[],
    vader: makeVader(),
    score: 0,
    gameOver: false,
    victory: false,
    starField: Array.from({ length: 90 }, () => ({
      x: Math.random() * CANVAS_W,
      y: Math.random() * (GROUND_Y - 20),
      r: Math.random() * 1.6 + 0.4,
      tw: Math.random() * Math.PI * 2,
    })),
    keys: {} as Record<string, boolean>,
    touch: { left: false, right: false, jump: false, shoot: false } as TouchState,
    playerImg: null as HTMLImageElement | null,
    vaderImg: null as HTMLImageElement | null,
    running: false,
    rafId: 0 as number,
    lastT: 0,
  });

  // Detect touch
  useEffect(() => {
    const check = () =>
      setIsTouch(
        typeof window !== 'undefined' &&
          ('ontouchstart' in window || window.matchMedia('(pointer: coarse)').matches),
      );
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleTouch = useCallback((s: TouchState) => {
    stateRef.current.touch = s;
  }, []);

  // Load sprites
  useEffect(() => {
    let cancelled = false;
    const load = (src: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    Promise.all([load(selectedCharacter.image_url), load(vaderSprite)])
      .then(([p, v]) => {
        if (cancelled) return;
        stateRef.current.playerImg = p;
        stateRef.current.vaderImg = v;
        setIsReady(true);
      })
      .catch(() => setIsReady(true));
    return () => {
      cancelled = true;
    };
  }, [selectedCharacter]);

  // Keyboard
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      stateRef.current.keys[e.code] = true;
      if (['Space', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      stateRef.current.keys[e.code] = false;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  const resetGame = useCallback(() => {
    const s = stateRef.current;
    s.player = makePlayer();
    s.bolts = [];
    s.particles = [];
    s.shake = 0;
    s.shockwaves = [];
    s.troopers = [];
    s.enemyBolts = [];
    s.trooperTimer = 6;
    s.wave = 0;
    s.hatchOpen = HATCHES.map(() => 0);
    s.hatchHold = HATCHES.map(() => 0);
    s.pendingWave = [];
    s.vader = makeVader();
    s.score = 0;
    s.gameOver = false;
    s.victory = false;
    setScore(0);
    setVaderHp(VADER_MAX_HP);
    setIsGameOver(false);
    setIsVictory(false);
  }, []);

  // Main loop
  useEffect(() => {
    if (!isStarted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = stateRef.current;
    s.running = true;
    s.lastT = performance.now();

    const vaderBaseX = CANVAS_W - VADER_W * 0.5; // half sticks out
    const vaderScreenY = GROUND_Y - VADER_H + 40; // small ground overlap
    const vaderHitRight = CANVAS_W;
    /** Every way Ferdi gets hurt goes through here. */
    const hurt = (n: number, invuln: number) => {
      const pl = s.player;
      if (pl.invuln > 0 || s.gameOver) return false;
      pl.hp = Math.max(0, pl.hp - n);
      pl.invuln = invuln;
      if (pl.hp <= 0 && !s.gameOver) { s.gameOver = true; s.running = false; setIsGameOver(true); }
      return true;
    };

    const emit = (pt: Partial<Particle> & { x: number; y: number }) => {
      if (s.particles.length > 700) return;
      const q = { vx: 0, vy: 0, life: 0.5, size: 3, g: 0, drag: 0, color: '#fff', glow: false, ...pt } as Particle;
      q.max = q.life;
      s.particles.push(q);
    };
    const sparks = (x: number, y: number, dirX: number, color: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(0, dirX) + Math.PI + (Math.random() - 0.5) * 2.2;
        const sp = 120 + Math.random() * 320;
        emit({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0.18 + Math.random() * 0.25,
          size: 1.5 + Math.random() * 2, g: 900, drag: 2, color, glow: true });
      }
      emit({ x, y, life: 0.08, size: 5, color: '#ffffff', glow: true, grow: true });
    };
    const dust = (x: number, y: number, n: number, spread: number, up: number) => {
      for (let i = 0; i < n; i++) {
        emit({ x: x + (Math.random() - 0.5) * spread, y: y - Math.random() * 3,
          vx: (Math.random() - 0.5) * 90, vy: -Math.random() * up,
          life: 0.35 + Math.random() * 0.35, size: 2 + Math.random() * 2.5, g: -20, drag: 3,
          color: 'rgba(150,120,130,0.4)', glow: false, grow: true });
      }
    };

    const step = (now: number) => {
      if (!s.running) return;
      const dt = Math.min((now - s.lastT) / 1000, 0.05);
      s.lastT = now;
      const vaderScreenX = vaderBaseX + s.vader.offset;
      const vaderHitLeft = vaderScreenX + 30;

      // ---- Input ----
      const K = s.keys;
      const T = s.touch;
      const left = K['ArrowLeft'] || K['KeyA'] || T.left;
      const right = K['ArrowRight'] || K['KeyD'] || T.right;
      const jump = K['ArrowUp'] || K['KeyW'] || K['Space'] || T.jump;
      const shoot = K['KeyX'] || K['KeyZ'] || K['ControlLeft'] || K['ControlRight'] || T.shoot;

      const p = s.player;
      if (p.stun > 0.25) p.vx *= 0.9; // still sliding from the bash
      else if (left) { p.vx = -MOVE_SPEED; p.dir = -1; }
      else if (right) { p.vx = MOVE_SPEED; p.dir = 1; }
      else p.vx *= 0.75;

      if (jump && p.onGround) {
        p.vy = JUMP_V; p.onGround = false;
        dust(p.x + PLAYER_W / 2, GROUND_Y, 6, 26, 60);
      }

      // Shooting
      p.boltCooldown -= dt;
      if (p.muzzle > 0) p.muzzle -= dt;
      p.kick = Math.max(0, p.kick - dt * 9);
      if (p.stun > 0) p.stun -= dt;
      if (p.healFlash > 0) p.healFlash -= dt;
      if (shoot && p.boltCooldown <= 0 && p.stun <= 0) {
        p.boltCooldown = BOLT_COOLDOWN;
        p.muzzle = 0.07;
        p.kick = 1;
        const mx = p.dir > 0 ? p.x + PLAYER_W + 4 : p.x - 4;
        const my = p.y + PLAYER_H * 0.42;
        s.bolts.push({ x: mx, y: my, vx: BOLT_SPEED * p.dir, alive: true });
        // a few hot flecks leave the muzzle with the bolt
        for (let i = 0; i < 4; i++) {
          emit({ x: mx, y: my, vx: p.dir * (150 + Math.random() * 200), vy: (Math.random() - 0.5) * 140,
            life: 0.1 + Math.random() * 0.1, size: 1.4, g: 300, drag: 4, color: '#d4ff7a', glow: true });
        }
        // and a breath of smoke drifts up off the barrel
        emit({ x: mx, y: my, vx: p.dir * 30, vy: -25, life: 0.5, size: 4, g: -40, drag: 2,
          color: 'rgba(200,220,190,0.25)', glow: false, grow: true });
      }

      // ---- Physics ----
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 20) p.x = 20;
      if (p.x + PLAYER_W > CANVAS_W - VADER_W * 0.35) p.x = CANVAS_W - VADER_W * 0.35 - PLAYER_W;
      if (p.y + PLAYER_H >= GROUND_Y) {
        if (!p.onGround) {
          // landing: squash scales with how hard you came down
          p.land = Math.min(1, p.vy / 900);
          dust(p.x + PLAYER_W / 2, GROUND_Y, 5 + Math.round(p.land * 6), 34, 50);
        }
        p.y = GROUND_Y - PLAYER_H;
        p.vy = 0;
        p.onGround = true;
      }
      p.land = Math.max(0, p.land - dt * 5);
      if (p.invuln > 0) p.invuln -= dt;
      // stride: one full step cycle every ~70 px of ground covered
      if (p.onGround && Math.abs(p.vx) > 30) {
        p.walkPhase += (Math.abs(p.vx) * dt) / 70 * Math.PI * 2;
        p.dustTimer -= dt;
        if (p.dustTimer <= 0) {
          p.dustTimer = 0.16;
          dust(p.x + PLAYER_W / 2 - p.dir * 12, GROUND_Y, 1, 8, 25);
        }
      } else {
        // settle the stride back to a standing pose rather than freezing mid-step
        const k = Math.round(p.walkPhase / Math.PI) * Math.PI;
        p.walkPhase += (k - p.walkPhase) * Math.min(1, dt * 12);
      }

      // ---- Bolts ----
      for (const b of s.bolts) {
        b.x += b.vx * dt;
        if (b.x > CANVAS_W + 40 || b.x < -40) b.alive = false;
        for (const tr of s.troopers) {
          const sp = TROOPER_SPEC[tr.kind];
          if (!b.alive || tr.hp <= 0 || tr.state === 'drop') continue;
          if (b.x > tr.x && b.x < tr.x + sp.w && b.y > tr.y - sp.h && b.y < tr.y) {
            b.alive = false;
            // the riot shield takes anything that comes at its face
            if (tr.shield > 0 && Math.sign(b.vx) === -tr.dir) {
              tr.shield -= PLAYER_BOLT_DMG; tr.shieldFlash = 0.15;
              sparks(b.x, b.y, b.vx, '#9fd8ff', 8);
              if (tr.shield <= 0) {
                tr.shield = 0;
                // shield shattered: Ferdi gets some health back, the trooper gets angry
                p.hp = Math.min(PLAYER_MAX_HP, p.hp + SHIELD_BREAK_HEAL);
                p.healFlash = 0.6;
                s.score += 15; setScore(s.score);
                for (let i = 0; i < 22; i++) {
                  emit({ x: tr.x + sp.w / 2 + tr.dir * 18, y: tr.y - sp.h * (0.2 + Math.random() * 0.6),
                    vx: (Math.random() - 0.5) * 320, vy: -80 - Math.random() * 260, life: 0.6 + Math.random() * 0.4,
                    size: 2 + Math.random() * 2.5, g: 1100, drag: 0.6, color: Math.random() < 0.5 ? '#cfe9ff' : '#8fb8d8', glow: Math.random() < 0.3 });
                }
                s.shake = Math.max(s.shake, 0.15);
              }
            } else {
              tr.hp -= PLAYER_BOLT_DMG; tr.hitFlash = 0.2;
              sparks(b.x, b.y, b.vx, '#d4ff7a', 10);
              if (tr.hp <= 0) {
                s.score += sp.score; setScore(s.score);
                for (let i = 0; i < 14; i++) {
                  emit({ x: tr.x + sp.w / 2, y: tr.y - sp.h * Math.random(), vx: (Math.random() - 0.5) * 260, vy: -100 - Math.random() * 200,
                    life: 0.5 + Math.random() * 0.4, size: 2 + Math.random() * 2, g: 1000, drag: 0.8,
                    color: tr.kind === 'death' ? '#1c1c1c' : tr.kind === 'riot' ? '#4a5568' : '#f2f2f2', glow: false });
                }
              }
            }
          }
        }
        // Hit Vader
        if (b.alive && b.x > vaderHitLeft && b.x < vaderHitRight && b.y > vaderScreenY + 60 && b.y < vaderScreenY + VADER_H - 80) {
          b.alive = false;
          s.vader.hp -= 1;
          s.vader.hitFlash = 0.3;
          sparks(b.x, b.y, b.vx, '#ffd27a', 14);
          s.shake = Math.max(s.shake, 0.12);
          s.score += 10;
          setVaderHp(s.vader.hp);
          setScore(s.score);
          if (s.vader.hp <= 0 && !s.victory) {
            s.victory = true;
            s.running = false;
            setIsVictory(true);
          }
        }
      }
      s.bolts = s.bolts.filter(b => b.alive);

      // ---- Vader logic ----
      const v = s.vader;
      if (v.hitFlash > 0) v.hitFlash -= dt;
      if (v.recoil > 0) v.recoil = Math.max(0, v.recoil - dt * 2.5);
      // Pace back and forth when not attacking
      if (v.windup <= 0 && v.recoil <= 0 && v.stomp <= 0) {
        v.offset += v.walkDir * 45 * dt;
        v.walkPhase += dt * 6;
        if (v.offset < -90) { v.offset = -90; v.walkDir = 1; }
        if (v.offset > 0) { v.offset = 0; v.walkDir = -1; }
      }
      // ---- Reinforcements ----
      // When the arena is clear for a while, Vader stomps, the ceiling
      // hatches open and the next wave drops in.
      if (s.troopers.length === 0 && v.stomp <= 0 && v.windup <= 0) {
        s.trooperTimer -= dt;
        if (s.trooperTimer <= 0) {
          const w = s.wave < WAVES.length
            ? WAVES[s.wave]
            : (['storm', 'riot', 'death'] as TrooperKind[]).sort(() => Math.random() - 0.5).slice(0, 3);
          s.pendingWave = [...w];
          s.wave += 1;
          v.stomp = STOMP_TIME;
          s.trooperTimer = 5;
        }
      }
      if (v.stomp > 0) {
        const before = v.stomp;
        v.stomp -= dt;
        // the foot comes down two thirds of the way through
        if (before > STOMP_TIME * 0.35 && v.stomp <= STOMP_TIME * 0.35) {
          s.shake = Math.max(s.shake, 0.5);
          dust(vaderScreenX + VADER_W * 0.25, GROUND_Y, 18, 120, 140);
          for (let i = 0; i < 18; i++) {
            const a = -Math.PI * (0.1 + Math.random() * 0.8);
            emit({ x: vaderScreenX + VADER_W * 0.25, y: GROUND_Y - 2, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300,
              life: 0.4 + Math.random() * 0.4, size: 1.5 + Math.random() * 2, g: 1200, drag: 1, color: '#6a4a4a', glow: false });
          }
          // grit shaken loose from the ceiling all along the arena
          for (let i = 0; i < 24; i++) {
            emit({ x: Math.random() * (CANVAS_W - 200), y: CEILING_Y + 2, vx: (Math.random() - 0.5) * 20, vy: 30 + Math.random() * 80,
              life: 0.8 + Math.random() * 0.6, size: 1 + Math.random() * 1.5, g: 600, drag: 0.3, color: '#7a6a70', glow: false });
          }
          // open a hatch for each trooper, and drop them through
          const free = HATCHES.map((_, k) => k).sort(() => Math.random() - 0.5);
          s.pendingWave.forEach((kind, n) => {
            const k = free[n % free.length];
            const sp = TROOPER_SPEC[kind];
            s.hatchHold[k] = 1.6;
            s.troopers.push({
              kind, x: HATCHES[k] - sp.w / 2, y: CEILING_Y - 10 - n * 30, vy: 0,
              hp: sp.hp, maxHp: sp.hp, shield: sp.shield, state: 'drop', landT: 0,
              shootTimer: 0.6 + Math.random() * 0.6, phase: 0, dir: 1, hitFlash: 0,
              strike: 0, struck: false, shieldFlash: 0,
            });
          });
          s.pendingWave = [];
        }
      }
      for (let k = 0; k < HATCHES.length; k++) {
        if (s.hatchHold[k] > 0) { s.hatchHold[k] -= dt; s.hatchOpen[k] = Math.min(1, s.hatchOpen[k] + dt * 5); }
        else s.hatchOpen[k] = Math.max(0, s.hatchOpen[k] - dt * 2);
      }
      for (const tr of s.troopers) {
        const sp = TROOPER_SPEC[tr.kind];
        if (tr.hitFlash > 0) tr.hitFlash -= dt;
        if (tr.shieldFlash > 0) tr.shieldFlash -= dt;
        if (tr.state === 'drop') {
          // a hatch only opens once the stomp has landed, so they fall through it
          tr.vy += GRAVITY * 0.8 * dt;
          tr.y += tr.vy * dt;
          if (tr.y >= GROUND_Y) {
            tr.y = GROUND_Y; tr.vy = 0; tr.state = 'land'; tr.landT = 0.6;
            dust(tr.x + sp.w / 2, GROUND_Y, 10, 50, 80);
            s.shake = Math.max(s.shake, 0.08);
          }
          continue;
        }
        if (tr.state === 'land') {
          tr.landT -= dt;
          tr.dir = p.x + PLAYER_W / 2 >= tr.x + sp.w / 2 ? 1 : -1;
          if (tr.landT <= 0) tr.state = 'active';
          continue;
        }
        const dist = p.x + PLAYER_W / 2 - (tr.x + sp.w / 2);
        if (tr.strike <= 0) tr.dir = dist >= 0 ? 1 : -1;
        const shielded = tr.shield > 0;
        const speed = shielded ? sp.speed : sp.fastSpeed;
        const reach = sp.range + (tr.kind === 'riot' ? PLAYER_W / 2 : 0);
        if (Math.abs(dist) > reach && tr.strike <= 0) {
          tr.x += tr.dir * speed * dt;
          tr.phase += dt * (speed > 120 ? 16 : speed < 60 ? 5 : 9);
        } else tr.phase *= 0.9;
        tr.x = Math.max(0, Math.min(CANVAS_W - VADER_W * 0.4 - sp.w, tr.x));
        tr.shootTimer -= dt;
        if (tr.kind === 'riot') {
          // close-range bash: a short wind-up, then the swing
          if (tr.strike > 0) {
            tr.strike += dt / 0.55;
            if (!tr.struck && tr.strike > 0.6) {
              tr.struck = true;
              if (Math.abs(dist) < reach + 14 && p.y + PLAYER_H > GROUND_Y - sp.h) {
                if (hurt(sp.damage, 0.9)) {
                  // the bash breaks your guard: knocked back, gun down for a moment
                  p.vx = tr.dir * 520; p.vy = -260; p.onGround = false; p.stun = 0.7;
                  sparks(p.x + PLAYER_W / 2, p.y + PLAYER_H * 0.5, -tr.dir, '#9fd8ff', 12);
                  s.shake = Math.max(s.shake, 0.25);
                }
              }
            }
            if (tr.strike >= 1) { tr.strike = 0; tr.struck = false; }
          } else if (Math.abs(dist) <= reach + 6 && tr.shootTimer <= 0) {
            tr.shootTimer = shielded ? sp.fireEvery : sp.fireEvery * 0.7;
            tr.strike = 0.001;
          }
        } else if (Math.abs(dist) <= reach + 4 && tr.shootTimer <= 0) {
          tr.shootTimer = sp.fireEvery * (0.85 + Math.random() * 0.3);
          s.enemyBolts.push({ x: tr.x + (tr.dir > 0 ? sp.w : 0), y: GROUND_Y - sp.h * 0.6, vx: (tr.kind === 'death' ? 520 : 430) * tr.dir, alive: true, dmg: sp.damage, death: tr.kind === 'death' });
        }
      }
      s.troopers = s.troopers.filter(tr => tr.hp > 0);
      for (const eb of s.enemyBolts) {
        eb.x += eb.vx * dt;
        if (eb.x < -40 || eb.x > CANVAS_W + 40) eb.alive = false;
        if (eb.alive && eb.x > p.x && eb.x < p.x + PLAYER_W && eb.y > p.y && eb.y < p.y + PLAYER_H) {
          if (p.invuln <= 0) {
            sparks(eb.x, eb.y, eb.vx, '#ff5a5a', 8);
            eb.alive = false;
            hurt(eb.dmg, 0.3);
          }
        }
      }
      s.enemyBolts = s.enemyBolts.filter(eb => eb.alive);
      if (v.windup > 0) {
        v.windup -= dt;
        v.handRaise = Math.min(1, v.handRaise + dt * 2.2);
        // the dark side gathering: motes drawn in from all round toward the glove
        if (v.handX && Math.random() < 0.9) {
          for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 90;
            emit({ x: v.handX + Math.cos(a) * r, y: v.handY + Math.sin(a) * r,
              vx: -Math.sin(a) * 60, vy: Math.cos(a) * 60,
              life: 0.45, size: 1.5 + Math.random() * 2, drag: 1.5,
              color: Math.random() < 0.3 ? '#ffd0d0' : '#ff2a2a', glow: true,
              pull: { x: v.handX, y: v.handY, k: 18 } });
          }
        }
        if (v.windup <= 0) {
          // spawn shockwave
          s.shockwaves.push({
            x: vaderScreenX,
            y: GROUND_Y - SHOCKWAVE_H,
            w: 96,
            h: SHOCKWAVE_H,
            hitCooldown: 0,
            age: 0,
            seed: Math.random() * 10,
          });
          v.attackTimer = ATTACK_INTERVAL;
          v.recoil = 1;
          s.shake = 0.35;
          // the slam: a ring of grit thrown off the ground where the wave is born
          for (let i = 0; i < 26; i++) {
            const a = -Math.PI * (0.05 + Math.random() * 0.9);
            const sp = 120 + Math.random() * 380;
            emit({ x: vaderScreenX + 20, y: GROUND_Y - 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
              life: 0.4 + Math.random() * 0.5, size: 1.5 + Math.random() * 2.5, g: 1200, drag: 1,
              color: Math.random() < 0.5 ? '#5a3a3a' : '#ff5a4a', glow: Math.random() < 0.4 });
          }
          dust(vaderScreenX + 20, GROUND_Y, 12, 90, 120);
        }
      } else {
        v.handRaise = Math.max(0, v.handRaise - dt * 3);
        if (v.stomp <= 0) v.attackTimer -= dt;
        if (v.attackTimer <= 0 && v.stomp <= 0) v.windup = WINDUP_TIME;
      }

      // ---- Shockwaves ----
      for (const sw of s.shockwaves) {
        sw.x -= SHOCKWAVE_SPEED * dt;
        sw.age += dt;
        if (sw.hitCooldown > 0) sw.hitCooldown -= dt;
        const grow = easeOut(clamp01(sw.age / 0.35));
        const WH = sw.h * 1.3 * grow;
        // whitewater pouring off the lip and down the face, carried along with it
        for (let i = 0; i < 3; i++) {
          emit({ x: sw.x - WH * (0.35 + Math.random() * 0.2), y: GROUND_Y - WH * (0.45 + Math.random() * 0.15),
            vx: -SHOCKWAVE_SPEED + (Math.random() - 0.5) * 60, vy: 20 + Math.random() * 60,
            life: 0.25 + Math.random() * 0.2, size: 1.5 + Math.random() * 2.5, g: 700, drag: 0.5,
            color: 'rgba(255,232,226,0.85)', glow: false });
        }
        // spray torn off the crest by its own speed, blowing back over the top
        if (Math.random() < 0.7) {
          emit({ x: sw.x + WH * 0.3 + (Math.random() - 0.5) * 16, y: GROUND_Y - WH,
            vx: -SHOCKWAVE_SPEED + 90 + Math.random() * 160, vy: -70 - Math.random() * 120,
            life: 0.35 + Math.random() * 0.3, size: 1 + Math.random() * 1.6, g: 500, drag: 1.5,
            color: 'rgba(255,190,180,0.9)', glow: true });
        }
        // churned mist rolling at the foot
        if (Math.random() < 0.6) {
          emit({ x: sw.x - WH * 0.2 + Math.random() * WH * 0.4, y: GROUND_Y - Math.random() * 8,
            vx: -SHOCKWAVE_SPEED * 0.9, vy: -15 - Math.random() * 25, life: 0.4 + Math.random() * 0.3,
            size: 3.5 + Math.random() * 3.5, g: -20, drag: 1, color: 'rgba(255,215,210,0.22)', glow: false, grow: true });
        }
        // grit and sparks scraped off the floor at the front
        if (Math.random() < 0.8) {
          emit({ x: sw.x - 4, y: GROUND_Y - 1, vx: -SHOCKWAVE_SPEED * (0.6 + Math.random() * 0.6), vy: -40 - Math.random() * 160,
            life: 0.3 + Math.random() * 0.3, size: 1 + Math.random() * 1.6, g: 1100, drag: 0.5,
            color: Math.random() < 0.5 ? '#ffb070' : '#7a4040', glow: Math.random() < 0.5 });
        }
        // a low mist left lying behind it
        if (Math.random() < 0.5) {
          emit({ x: sw.x + sw.w * (0.4 + Math.random() * 0.8), y: GROUND_Y - Math.random() * 10,
            vx: -40 + Math.random() * 30, vy: -10 - Math.random() * 20, life: 0.7 + Math.random() * 0.5,
            size: 6 + Math.random() * 6, g: -10, drag: 1.5, color: 'rgba(255,70,60,0.18)', glow: false, grow: true });
        }
        // Collide with player
        if (
          sw.hitCooldown <= 0 &&
          p.invuln <= 0 &&
          p.x < sw.x + sw.w &&
          p.x + PLAYER_W > sw.x &&
          p.y < sw.y + sw.h &&
          p.y + PLAYER_H > sw.y
        ) {
          sw.hitCooldown = 0.5;
          hurt(SHOCKWAVE_DMG, 1.2);
        }
      }
      s.shockwaves = s.shockwaves.filter(sw => sw.x + sw.w > -40);

      // ---- Particles ----
      for (const q of s.particles) {
        q.life -= dt;
        if (q.pull) {
          const dx = q.pull.x - q.x, dy = q.pull.y - q.y;
          q.vx += dx * q.pull.k * dt; q.vy += dy * q.pull.k * dt;
          if (dx * dx + dy * dy < 100) q.life = Math.min(q.life, 0.05);
        }
        q.vy += q.g * dt;
        const dr = Math.max(0, 1 - q.drag * dt);
        q.vx *= dr; q.vy *= dr;
        q.x += q.vx * dt; q.y += q.vy * dt;
        // grit bounces once off the floor and skids
        if (q.g > 500 && q.y > GROUND_Y) { q.y = GROUND_Y; q.vy *= -0.3; q.vx *= 0.6; }
      }
      s.particles = s.particles.filter(q => q.life > 0);
      s.shake = Math.max(0, s.shake - dt);

      // ---- Render ----
      ctx.save();
      if (s.shake > 0) {
        const m = s.shake * 22;
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      }
      // Sky/space background
      const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
      bg.addColorStop(0, '#02020a');
      bg.addColorStop(0.7, '#0a0518');
      bg.addColorStop(1, '#1a0410');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // Stars
      const t = now / 1000;
      ctx.fillStyle = '#fff';
      for (const st of s.starField) {
        const a = 0.4 + Math.sin(t * 3 + st.tw) * 0.3;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Distant planet
      ctx.save();
      const pg = ctx.createRadialGradient(140, 100, 5, 140, 100, 55);
      pg.addColorStop(0, '#ff9d5c');
      pg.addColorStop(0.6, '#a83f1f');
      pg.addColorStop(1, 'rgba(80,20,10,0)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(140, 100, 55, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Ground
      const gg = ctx.createLinearGradient(0, GROUND_Y, 0, CANVAS_H);
      gg.addColorStop(0, '#2a1f24');
      gg.addColorStop(1, '#0a0405');
      ctx.fillStyle = gg;
      ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);
      // Ground line highlight
      ctx.fillStyle = 'rgba(255, 60, 60, 0.35)';
      ctx.fillRect(0, GROUND_Y - 1, CANVAS_W, 2);

      // Red ground glow under Vader
      const glowPulse = 1 + Math.sin(t * 3) * 0.15;
      const rg = ctx.createRadialGradient(
        vaderScreenX + VADER_W * 0.3, GROUND_Y, 0,
        vaderScreenX + VADER_W * 0.3, GROUND_Y, VADER_W * 0.7 * glowPulse,
      );
      rg.addColorStop(0, 'rgba(255,40,40,0.5)');
      rg.addColorStop(1, 'rgba(255,40,40,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(vaderScreenX + VADER_W * 0.3, GROUND_Y, VADER_W * 0.7 * glowPulse, 0, Math.PI * 2);
      ctx.fill();

      // The ceiling and its hatches. Reinforcements drop through these.
      {
        const cg = ctx.createLinearGradient(0, 0, 0, CEILING_Y);
        cg.addColorStop(0, '#0d0d12'); cg.addColorStop(1, '#2a2730');
        ctx.fillStyle = cg; ctx.fillRect(0, 0, CANVAS_W, CEILING_Y);
        ctx.fillStyle = 'rgba(255,60,60,0.35)'; ctx.fillRect(0, CEILING_Y - 2, CANVAS_W, 2);
        for (let x = 20; x < CANVAS_W; x += 60) { ctx.fillStyle = '#1a181f'; ctx.fillRect(x, 6, 30, 4); }
        for (let k = 0; k < HATCHES.length; k++) {
          const o = easeInOut(s.hatchOpen[k]);
          const hx = HATCHES[k], hw = 64;
          // light spilling down out of an open hatch
          if (o > 0.02) {
            const lg = ctx.createLinearGradient(0, CEILING_Y, 0, GROUND_Y);
            lg.addColorStop(0, `rgba(255,230,200,${0.28 * o})`); lg.addColorStop(1, 'rgba(255,230,200,0)');
            ctx.fillStyle = lg;
            ctx.beginPath(); ctx.moveTo(hx - hw / 2, CEILING_Y); ctx.lineTo(hx + hw / 2, CEILING_Y);
            ctx.lineTo(hx + hw, GROUND_Y); ctx.lineTo(hx - hw, GROUND_Y); ctx.closePath(); ctx.fill();
            ctx.fillStyle = `rgba(255,240,220,${0.8 * o})`; ctx.fillRect(hx - hw / 2, CEILING_Y - 8, hw, 8);
          }
          // two doors that swing down and apart
          ctx.fillStyle = '#3b3742'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5;
          for (const sgn of [-1, 1]) {
            ctx.save();
            ctx.translate(hx + sgn * hw / 2, CEILING_Y - 2);
            ctx.rotate(-sgn * o * 1.35);
            ctx.beginPath(); ctx.rect(sgn > 0 ? -hw / 2 : 0, 0, hw / 2, 6); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#ff4040'; ctx.fillRect(sgn > 0 ? -6 : 2, 2, 4, 2); ctx.fillStyle = '#3b3742';
            ctx.restore();
          }
        }
      }

      // Vader
      if (s.vaderImg) {
        ctx.save();
        if (v.hitFlash > 0) ctx.globalAlpha = 0.5 + Math.sin(t * 30) * 0.5;
        ctx.shadowColor = 'rgba(255,30,30,0.9)';
        ctx.shadowBlur = 28;
        // Breathing + sway, lean back on wind-up, lunge forward on release
        const breathe = Math.sin(t * 2.2);
        const sx = 1 + breathe * 0.015;
        const sy = 1 - breathe * 0.02 + v.handRaise * 0.04;
        const lean = -v.handRaise * 0.06 + v.recoil * 0.1 + Math.sin(t * 1.3) * 0.015;
        const shake = v.windup > 0 ? (Math.random() - 0.5) * 4 * v.handRaise : 0;
        const pivotX = vaderScreenX + VADER_W / 2;
        const pivotY = vaderScreenY + VADER_H;
        const walking = v.windup <= 0 && v.recoil <= 0 && v.stomp <= 0;
        // the stomp: rise onto one leg, then slam down and sink a little
        const st = v.stomp > 0 ? 1 - v.stomp / STOMP_TIME : -1;
        const stompY = st < 0 ? 0 : st < 0.65 ? -easeOut(st / 0.65) * 22 : 10 * (1 - (st - 0.65) / 0.35);
        const stepBob = (walking ? -Math.abs(Math.sin(v.walkPhase)) * 10 : 0) + stompY;
        const stepTilt = walking ? Math.sin(v.walkPhase) * 0.035 : 0;
        ctx.translate(pivotX + shake - v.recoil * 18, pivotY + v.recoil * 6 + stepBob);
        ctx.rotate(lean + stepTilt);
        ctx.scale(sx, sy);
        // Body twists toward the attack
        ctx.save();
        ctx.translate(0, -VADER_H * 0.5);
        ctx.rotate(-v.handRaise * 0.08 + v.recoil * 0.12);
        ctx.drawImage(s.vaderImg, -VADER_W / 2, -VADER_H * 0.5, VADER_W, VADER_H);
        ctx.restore();
        // Attack arm. Two joints, solved each frame from where the hand should be:
        // hanging and swinging with his stride, then reaching out toward the
        // player and slowly closing into a Force grip, then driven down,
        // palm open, into the floor to send the wave.
        ctx.shadowBlur = 0;
        // The painted arm is erased from boss-vader.webp; this one hangs from the same shoulder.
        const shX = -VADER_W * 0.16, shY = -VADER_H * 0.68;
        const L1 = VADER_H * 0.17, L2 = VADER_H * 0.16, reach = L1 + L2;
        const swing = walking ? Math.sin(v.walkPhase) : 0;
        const rest = { x: -14 + swing * 16, y: reach * 0.9 };
        const grip = { x: -reach * 0.86, y: -reach * 0.28 };
        const slam = { x: -reach * 0.8, y: reach * 0.62 };
        let hx: number, hy: number, curl: number;
        if (v.recoil > 0) {
          // 1 -> 0: the first fifth is the strike itself, then the arm recovers
          const k = v.recoil > 0.8 ? easeOut((1 - v.recoil) / 0.2) : 1;
          const back = v.recoil > 0.8 ? 0 : easeInOut(1 - v.recoil / 0.8);
          const sx2 = grip.x + (slam.x - grip.x) * k, sy2 = grip.y + (slam.y - grip.y) * k;
          hx = sx2 + (rest.x - sx2) * back; hy = sy2 + (rest.y - sy2) * back;
          curl = 0.15 * back;
        } else {
          const r = easeInOut(v.handRaise);
          hx = rest.x + (grip.x - rest.x) * r;
          hy = rest.y + (grip.y - rest.y) * r;
          // the fingers lag the arm, closing in the last stretch of the reach
          curl = 0.2 + clamp01((v.handRaise - 0.35) / 0.65) * 0.7;
        }
        const tremor = v.windup > 0 ? v.handRaise : 0;
        hx += Math.sin(t * 38) * tremor * 2;
        hy += Math.cos(t * 33) * tremor * 2;
        ctx.save();
        ctx.translate(shX, shY);
        const arm = drawVaderArm(ctx, hx, hy, L1, L2, curl, tremor, t);
        // the glove's on-screen position, for the motes to fly to
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(arm.fore);
        ctx.translate(14, 0);
        const m = ctx.getTransform();
        v.handX = m.e; v.handY = m.f;
        // Force glow in the palm, growing with the grip
        if (v.handRaise > 0.02 || v.recoil > 0.8) {
          const power = v.recoil > 0.8 ? 1 : v.handRaise;
          const orbR = 10 + power * 26 + Math.sin(t * 22) * 2;
          ctx.globalCompositeOperation = 'lighter';
          const og = ctx.createRadialGradient(0, 0, 0, 0, 0, orbR);
          og.addColorStop(0, 'rgba(255,220,220,0.75)');
          og.addColorStop(0.3, 'rgba(255,50,40,0.45)');
          og.addColorStop(1, 'rgba(255,0,0,0)');
          ctx.fillStyle = og;
          ctx.beginPath(); ctx.arc(0, 0, orbR, 0, Math.PI * 2); ctx.fill();
          // forked crackle, new every frame, reaching out from the fingers
          ctx.lineCap = 'round';
          const forks = 1 + Math.round(power * 2);
          for (let i = 0; i < forks; i++) {
            let a = (Math.random() - 0.5) * 2.4 + (i % 2 ? Math.PI : 0) * 0.3;
            let px = 10, py = 0;
            ctx.beginPath(); ctx.moveTo(px, py);
            const segs = 5 + Math.floor(Math.random() * 3);
            for (let k2 = 0; k2 < segs; k2++) {
              a += (Math.random() - 0.5) * 1.1;
              const st = (orbR * 1.4) / segs;
              px += Math.cos(a) * st; py += Math.sin(a) * st;
              ctx.lineTo(px, py);
            }
            ctx.globalAlpha = power * (0.5 + Math.random() * 0.5);
            ctx.strokeStyle = 'rgba(255,90,80,0.9)'; ctx.lineWidth = 3; ctx.stroke();
            ctx.strokeStyle = 'rgba(255,235,235,0.95)'; ctx.lineWidth = 1; ctx.stroke();
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
        ctx.restore();
        ctx.restore();
        ctx.restore();
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(vaderScreenX, vaderScreenY, VADER_W, VADER_H);
      }

      // Hand raise orb + telegraph line
      if (v.handRaise > 0.02) {
        ctx.save();
        ctx.globalAlpha = 0.3 + Math.sin(t * 18) * 0.2;
        ctx.fillStyle = '#ff2222';
        ctx.fillRect(0, GROUND_Y - 4, CANVAS_W, 4);
        ctx.restore();
      }

      // Shockwaves: a breaking wave of red energy. The hitbox is still the
      // plain sw.x..sw.x+w box; this is only how it looks. It moves left, so
      // a steep hollow face leads, the lip pitches forward over it, whitewater
      // pours down the front, and a long swell trails off behind.
      for (const sw of s.shockwaves) {
        const grow = easeOut(clamp01(sw.age / 0.35));
        const H = sw.h * 1.3 * grow;
        if (H < 2) continue;
        const front = sw.x, base = GROUND_Y, len = sw.w + 110;
        const crestX = front + H * 0.38, crestY = base - H;
        const breathe = Math.sin(sw.age * 9 + sw.seed) * 0.04;
        const lipX = front - H * (0.5 + breathe), lipY = base - H * (0.52 - breathe * 0.5);
        // the swell behind the crest
        const N = 28;
        const back: { x: number; y: number }[] = [];
        for (let i = 0; i <= N; i++) {
          const u = i / N;
          const x = crestX + u * (front + len - crestX);
          const fall = Math.exp(-Math.pow(u / 0.5, 2)) * (1 - u * 0.15);
          back.push({ x, y: base - H * fall * (1 + ripple(u, t, sw.seed) * 0.05 * u) });
        }
        ctx.save();
        // light thrown on the floor
        const fg = ctx.createRadialGradient(crestX, base, 0, crestX, base, len * 0.75);
        fg.addColorStop(0, 'rgba(255,40,30,0.4)');
        fg.addColorStop(1, 'rgba(255,40,30,0)');
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(crestX, base, len * 0.75, Math.PI, Math.PI * 2); ctx.fill();
        // its reflection in the floor
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = '#ff2a20';
        ctx.beginPath();
        ctx.moveTo(front, base);
        for (const q of back) ctx.lineTo(q.x, base + (base - q.y) * 0.25);
        ctx.lineTo(crestX, base + H * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        // body
        const body = ctx.createLinearGradient(0, crestY, 0, base);
        body.addColorStop(0, '#ff7a64');
        body.addColorStop(0.18, '#f0281e');
        body.addColorStop(0.6, '#9a0a0e');
        body.addColorStop(1, '#3c0006');
        ctx.fillStyle = body;
        ctx.shadowColor = 'rgba(255,40,30,0.85)';
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.moveTo(front, base);
        // the hollow, concave face climbing to the crest
        ctx.bezierCurveTo(front + H * 0.05, base - H * 0.55, crestX - H * 0.3, crestY + H * 0.04, crestX, crestY);
        for (const q of back) ctx.lineTo(q.x, q.y);
        ctx.lineTo(front + len, base);
        ctx.closePath();
        ctx.fill();
        // the lip, thrown forward from the crest and curling down
        ctx.beginPath();
        ctx.moveTo(crestX + H * 0.05, crestY + H * 0.02);
        ctx.bezierCurveTo(crestX - H * 0.35, crestY - H * 0.16, lipX + H * 0.05, crestY + H * 0.02, lipX, lipY);
        ctx.quadraticCurveTo(lipX + H * 0.28, crestY + H * 0.3, crestX - H * 0.08, crestY + H * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;

        // the barrel under the lip, dark and deep
        const tx = front + H * 0.02, ty = base - H * 0.4;
        const tube = ctx.createRadialGradient(tx, ty, 1, tx, ty, H * 0.42);
        tube.addColorStop(0, 'rgba(25,0,2,0.9)');
        tube.addColorStop(0.6, 'rgba(70,0,6,0.5)');
        tube.addColorStop(1, 'rgba(90,0,8,0)');
        ctx.fillStyle = tube;
        ctx.beginPath(); ctx.ellipse(tx, ty, H * 0.36, H * 0.34, 0, 0, Math.PI * 2); ctx.fill();

        ctx.globalCompositeOperation = 'lighter';
        // backlight: the thin water near the crest glows
        const bl = ctx.createRadialGradient(crestX + H * 0.15, crestY + H * 0.2, 0, crestX + H * 0.15, crestY + H * 0.2, H * 0.9);
        bl.addColorStop(0, 'rgba(255,140,110,0.35)');
        bl.addColorStop(1, 'rgba(255,60,40,0)');
        ctx.fillStyle = bl;
        ctx.beginPath(); ctx.arc(crestX + H * 0.15, crestY + H * 0.2, H * 0.9, 0, Math.PI * 2); ctx.fill();
        // rim along the lip and the top of the swell
        ctx.strokeStyle = 'rgba(255,215,205,0.8)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(lipX, lipY);
        ctx.bezierCurveTo(lipX + H * 0.05, crestY + H * 0.02, crestX - H * 0.35, crestY - H * 0.16, crestX + H * 0.05, crestY + H * 0.02);
        for (let i = 1; i < N * 0.55; i++) ctx.lineTo(back[i].x, back[i].y + 1);
        ctx.stroke();
        // swell lines sliding back along the slope
        ctx.strokeStyle = 'rgba(255,150,130,0.25)';
        ctx.lineWidth = 1.4;
        for (let k = 0; k < 4; k++) {
          const ph = ((sw.age * 0.9 + k / 4) % 1);
          const i0 = Math.floor(ph * N * 0.8) + 1;
          if (i0 + 4 > N) continue;
          ctx.globalAlpha = Math.sin(ph * Math.PI);
          ctx.beginPath();
          ctx.moveTo(back[i0].x, back[i0].y + 6);
          for (let i = i0 + 1; i < i0 + 5; i++) ctx.lineTo(back[i].x, back[i].y + 6 + (i - i0) * 1.5);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // whitewater: a churning foam mane along the lip and boiling at the foot
        for (let k = 0; k < 9; k++) {
          const f = k / 8;
          const fx = lipX + (crestX - lipX) * f * 0.9 + Math.sin(t * 14 + k * 2.1 + sw.seed) * 1.5;
          const fy = lipY + (crestY - lipY) * Math.sin(f * Math.PI / 2) - 1 + Math.cos(t * 17 + k) * 1.2;
          ctx.fillStyle = `rgba(255,${228 - k * 6},${222 - k * 8},${0.85 - f * 0.4})`;
          ctx.beginPath(); ctx.arc(fx, fy, 3.2 - f * 1.4 + Math.sin(k * 1.9 + t * 9) * 0.8, 0, Math.PI * 2); ctx.fill();
        }
        for (let k = 0; k < 7; k++) {
          const fx = front - H * 0.15 + k * H * 0.08 + Math.sin(t * 11 + k * 1.3 + sw.seed) * 3;
          const fy = base - 3 - Math.abs(Math.sin(t * 8 + k * 2.2)) * H * 0.18;
          ctx.fillStyle = 'rgba(255,225,218,0.55)';
          ctx.beginPath(); ctx.arc(fx, fy, 2.5 + Math.abs(Math.sin(k * 3.1 + t * 6)) * 3, 0, Math.PI * 2); ctx.fill();
        }
        // scorched streak left on the floor
        const wake = ctx.createLinearGradient(front, 0, front + len + 80, 0);
        wake.addColorStop(0, 'rgba(255,140,120,0.7)');
        wake.addColorStop(1, 'rgba(255,60,40,0)');
        ctx.fillStyle = wake;
        ctx.fillRect(front, base - 1.5, len + 80, 3);
        ctx.restore();
      }

      // Imperial troopers: three kinds, one figure drawn in code each
      for (const tr of s.troopers) {
        const sp = TROOPER_SPEC[tr.kind];
        ctx.save();
        const running = tr.kind === 'riot' && tr.shield <= 0;
        const swing = Math.sin(tr.phase) * (running ? 0.85 : 0.5);
        const bob = tr.state === 'active' ? -Math.abs(Math.sin(tr.phase)) * (running ? 5 : 3) : 0;
        // landing: crouch on touchdown, then stand up into the fight
        const crouch = tr.state === 'land' ? easeOut(clamp01(tr.landT / 0.6)) : 0;
        const falling = tr.state === 'drop';
        if (tr.hitFlash > 0) ctx.globalAlpha = 0.55;
        // contact shadow, shrinking with height while they fall
        const air = clamp01((GROUND_Y - tr.y) / 400);
        ctx.fillStyle = `rgba(0,0,0,${0.4 * (1 - air)})`;
        ctx.beginPath(); ctx.ellipse(tr.x + sp.w / 2, GROUND_Y + 2, sp.w * 0.45 * (1 - air * 0.6), 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.translate(tr.x + sp.w / 2, tr.y + bob);
        ctx.scale(tr.dir * (1 + crouch * 0.12), 1 - crouch * 0.22);
        const lean = running ? 0.18 : tr.strike > 0 ? (tr.strike < 0.6 ? -0.15 : 0.22) : 0;
        ctx.rotate(lean);
        const armour = tr.kind === 'death' ? '#18191c' : tr.kind === 'riot' ? '#e9ecef' : '#f2f2f2';
        const trim = tr.kind === 'death' ? '#3a3d44' : '#1a1a1a';
        const scale = sp.h / 74;
        ctx.scale(scale, scale);
        ctx.fillStyle = armour; ctx.strokeStyle = tr.kind === 'death' ? '#000' : '#111'; ctx.lineWidth = 2;
        // legs: tucked while falling, apart in a crouch, striding otherwise
        for (const sgn of [1, -1]) {
          ctx.save(); ctx.translate(sgn * 6, -30);
          ctx.rotate(falling ? sgn * 0.25 : crouch > 0 ? sgn * 0.35 * crouch : swing * sgn);
          ctx.beginPath(); ctx.roundRect(-5, 0, 10, 30, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = trim; ctx.fillRect(-5, 26, 12, 4); ctx.fillStyle = armour;
          ctx.restore();
        }
        // torso
        ctx.beginPath(); ctx.roundRect(-14, -58, 28, 30, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = trim; ctx.fillRect(-14, -34, 28, 4);
        if (tr.kind === 'riot') {
          // blue riot stripes on the chest and shoulders
          ctx.fillStyle = '#3b6ea8'; ctx.fillRect(-14, -52, 28, 4); ctx.fillRect(-16, -58, 8, 5);
        }
        if (tr.kind === 'death') {
          ctx.fillStyle = '#2b2e35'; ctx.fillRect(-10, -54, 20, 3); ctx.fillRect(-10, -47, 20, 3);
        }
        // arms
        if (falling) {
          ctx.fillStyle = armour;
          for (const sgn of [1, -1]) { ctx.beginPath(); ctx.roundRect(sgn > 0 ? 8 : -16, -66, 8, 16, 3); ctx.fill(); ctx.stroke(); }
        } else if (tr.kind === 'riot') {
          // baton arm swings over on a bash
          const sw2 = tr.strike > 0 ? (tr.strike < 0.6 ? -1.6 * (tr.strike / 0.6) : -1.6 + 2.6 * ((tr.strike - 0.6) / 0.4)) : -0.3;
          ctx.save(); ctx.translate(-6, -54); ctx.rotate(sw2);
          ctx.fillStyle = armour; ctx.beginPath(); ctx.roundRect(-4, 0, 8, 20, 3); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#222'; ctx.fillRect(-2, 18, 4, 18);
          ctx.restore();
        } else {
          ctx.fillStyle = armour;
          ctx.beginPath(); ctx.roundRect(4, -52, 20, 8, 3); ctx.fill(); ctx.stroke();
          ctx.fillStyle = tr.kind === 'death' ? '#0a0a0a' : '#1a1a1a'; ctx.fillRect(18, -54, tr.kind === 'death' ? 22 : 16, 6);
        }
        // helmet
        ctx.fillStyle = tr.kind === 'death' ? '#202227' : '#f7f7f7';
        ctx.beginPath(); ctx.arc(0, -68, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (tr.kind === 'death') {
          // visor and the green lights down the side of the helmet
          ctx.fillStyle = '#05060a'; ctx.beginPath(); ctx.ellipse(5, -70, 6, 3.4, -0.2, 0, Math.PI * 2); ctx.fill();
          ctx.save(); ctx.shadowColor = '#5dff8a'; ctx.shadowBlur = 8; ctx.fillStyle = '#7dffa0';
          ctx.fillRect(9, -66, 2, 2); ctx.fillRect(9, -62, 2, 2); ctx.fillRect(7, -58, 2, 2);
          ctx.restore();
        } else {
          ctx.fillStyle = '#111';
          ctx.beginPath(); ctx.ellipse(5, -70, 5, 3, -0.2, 0, Math.PI * 2); ctx.fill();
          ctx.fillRect(2, -62, 9, 2);
          if (tr.kind === 'riot') { ctx.fillStyle = 'rgba(160,200,255,0.5)'; ctx.fillRect(-2, -78, 16, 6); }
        }
        // the riot shield, held out front; it cracks as it takes hits
        if (tr.kind === 'riot' && tr.shield > 0) {
          const push = tr.strike > 0.6 ? 10 * Math.sin(((tr.strike - 0.6) / 0.4) * Math.PI) : 0;
          ctx.save(); ctx.translate(16 + push, -40);
          ctx.fillStyle = tr.shieldFlash > 0 ? 'rgba(210,235,255,0.75)' : 'rgba(150,190,230,0.42)';
          ctx.strokeStyle = '#2a3a4a'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.roundRect(-4, -36, 10, 74, 3); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#1d2a38'; ctx.fillRect(-4, -8, 10, 6);
          const cracks = Math.floor((1 - tr.shield / sp.shield) * 4);
          ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
          for (let c = 0; c < cracks; c++) {
            ctx.beginPath(); ctx.moveTo(-3, -28 + c * 18); ctx.lineTo(3, -22 + c * 18); ctx.lineTo(0, -16 + c * 18); ctx.stroke();
          }
          ctx.restore();
        }
        ctx.restore();
        // health (and shield) over their heads once they are on the ground
        if (!falling) {
          const bw = 40, bx = tr.x + sp.w / 2 - bw / 2, byy = tr.y - sp.h - 18;
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 1, byy - 1, bw + 2, 6);
          ctx.fillStyle = tr.kind === 'death' ? '#7dffa0' : '#ef4444';
          ctx.fillRect(bx, byy, bw * Math.max(0, tr.hp) / tr.maxHp, 4);
          if (sp.shield > 0 && tr.shield > 0) {
            ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 1, byy - 7, bw + 2, 5);
            ctx.fillStyle = '#8fd0ff'; ctx.fillRect(bx, byy - 6, bw * tr.shield / sp.shield, 3);
          }
        }
      }
      for (const eb of s.enemyBolts) {
        ctx.save();
        ctx.shadowColor = '#ff3030'; ctx.shadowBlur = eb.death ? 18 : 12;
        ctx.fillStyle = '#ff4a4a'; ctx.fillRect(eb.x - (eb.death ? 14 : 10), eb.y - (eb.death ? 3 : 2), eb.death ? 28 : 20, eb.death ? 6 : 4);
        ctx.fillStyle = '#fff'; ctx.fillRect(eb.x - 4, eb.y - 1, 8, 2);
        ctx.restore();
      }

      // Player: one still sprite, animated by how it is held. Feet stay on
      // the ground; the body bobs twice a stride, leans into the run, squashes
      // on landing, stretches in the air, and kicks back when it fires.
      if (s.playerImg) {
        ctx.save();
        if (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) ctx.globalAlpha = 0.4;
        const moving = p.onGround && Math.abs(p.vx) > 30;
        const stride = Math.sin(p.walkPhase);
        const bob = moving ? Math.abs(stride) * 5 : 0;
        const breathe = !moving && p.onGround ? Math.sin(t * 3) * 0.02 : 0;
        let sx4 = 1 + breathe * 0.5, sy4 = 1 + breathe;
        if (!p.onGround) {
          const st = clamp01(Math.abs(p.vy) / 900) * 0.12;
          sx4 -= st * 0.6; sy4 += st;
        }
        const sq = easeOut(p.land) * 0.22;
        sx4 += sq; sy4 -= sq;
        if (moving) { sy4 += Math.abs(stride) * 0.04 - 0.02; }
        const lean = (p.vx / MOVE_SPEED) * 0.12 + (moving ? stride * 0.06 : 0) + (!p.onGround ? p.vy / 9000 * p.dir : 0);
        const kickX = -p.dir * easeOut(p.kick) * 6;
        const kickA = -p.dir * easeOut(p.kick) * 0.08;
        // contact shadow
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const air = clamp01((GROUND_Y - (p.y + PLAYER_H)) / 200);
        ctx.beginPath();
        ctx.ellipse(p.x + PLAYER_W / 2, GROUND_Y + 2, PLAYER_W * 0.42 * (1 - air * 0.5), 5 * (1 - air * 0.5), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(p.x + PLAYER_W / 2 + kickX, p.y + PLAYER_H - bob);
        ctx.rotate(lean + kickA);
        ctx.scale(p.dir * sx4, sy4);
        ctx.drawImage(s.playerImg, -PLAYER_W / 2, -PLAYER_H, PLAYER_W, PLAYER_H);
        ctx.restore();
      }

      // Muzzle flash: a star of light at the barrel for a few frames
      if (p.muzzle > 0) {
        const mx = p.dir > 0 ? p.x + PLAYER_W + 4 : p.x - 4;
        const my = p.y + PLAYER_H * 0.42;
        const k = p.muzzle / 0.07;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 26 * k + 6);
        mg.addColorStop(0, 'rgba(255,255,240,1)');
        mg.addColorStop(0.3, 'rgba(190,255,120,0.8)');
        mg.addColorStop(1, 'rgba(120,255,60,0)');
        ctx.fillStyle = mg;
        ctx.beginPath(); ctx.arc(mx, my, 26 * k + 6, 0, Math.PI * 2); ctx.fill();
        ctx.translate(mx, my);
        ctx.rotate(t * 40);
        ctx.fillStyle = 'rgba(240,255,200,0.9)';
        for (let i = 0; i < 4; i++) {
          ctx.rotate(Math.PI / 2);
          ctx.beginPath();
          ctx.moveTo(0, -2); ctx.lineTo(18 * k + 4, 0); ctx.lineTo(0, 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Bolts (green blaster)
      // a long glowing bolt with a hot white core and a tail that fades
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const b of s.bolts) {
        const dir = Math.sign(b.vx);
        const tail = b.x - dir * 46;
        const grad = ctx.createLinearGradient(tail, 0, b.x, 0);
        grad.addColorStop(0, 'rgba(120,255,60,0)');
        grad.addColorStop(1, 'rgba(140,255,80,0.55)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(tail, b.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(210,255,140,0.9)';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(b.x - dir * 26, b.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(b.x - dir * 20, b.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();

      // particles last, over everything in the scene
      for (const q of s.particles) {
        const k = q.life / q.max;
        const r = q.grow ? q.size * (1 + (1 - k) * 2.2) : q.size * (0.4 + k * 0.6);
        ctx.globalAlpha = q.grow ? k * 0.9 : Math.min(1, k * 1.6);
        ctx.globalCompositeOperation = q.glow ? 'lighter' : 'source-over';
        ctx.fillStyle = q.color;
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore(); // end of screen shake

      // HUD: Ferdi's health + score. Sits right of the global home button.
      {
        const hx = 96, hy = 20, hw = 200, hh = 12;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(hx - 4, hy - 4, hw + 8, hh + 8);
        ctx.fillStyle = '#1a2a10'; ctx.fillRect(hx, hy, hw, hh);
        const k = p.hp / PLAYER_MAX_HP;
        ctx.fillStyle = p.healFlash > 0 ? '#d9ffb0' : k > 0.5 ? '#7ddc3a' : k > 0.25 ? '#facc15' : '#ef4444';
        ctx.fillRect(hx, hy, hw * k, hh);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(hx, hy, hw, hh);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`${selectedCharacter.name.toUpperCase()}  ${Math.ceil(p.hp)} HP`, hx, hy - 6);
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(`SCORE ${s.score}`, hx, hy + hh + 20);
        if (p.stun > 0) { ctx.fillStyle = '#9fd8ff'; ctx.fillText('GUARD BROKEN', hx + 110, hy + hh + 20); }
        if (p.healFlash > 0) { ctx.fillStyle = '#b6ff7a'; ctx.fillText(`+${SHIELD_BREAK_HEAL} HP`, hx + 110, hy + hh + 20); }
      }

      // Vader HP bar top-right
      const hbW = 260, hbH = 12, hbX = CANVAS_W - hbW - 20, hbY = 20;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(hbX - 4, hbY - 4, hbW + 8, hbH + 8);
      ctx.fillStyle = '#330000';
      ctx.fillRect(hbX, hbY, hbW, hbH);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(hbX, hbY, hbW * Math.max(0, s.vader.hp) / VADER_MAX_HP, hbH);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hbX, hbY, hbW, hbH);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('DARTH VADER', hbX + hbW, hbY - 6);
      ctx.textAlign = 'left';

      s.rafId = requestAnimationFrame(step);
    };

    s.rafId = requestAnimationFrame(step);
    // For scripts: read the fight, and call a given wave in now.
    (window as unknown as { __vaderDuel?: unknown }).__vaderDuel = {
      state: () => ({
        hp: s.player.hp, stun: s.player.stun, wave: s.wave, vaderHp: s.vader.hp, stomp: s.vader.stomp,
        hatches: [...s.hatchOpen],
        troopers: s.troopers.map(tr => ({ kind: tr.kind, state: tr.state, hp: tr.hp, shield: tr.shield, x: Math.round(tr.x), y: Math.round(tr.y) })),
      }),
      wave: (n: number) => { s.wave = n; s.troopers = []; s.trooperTimer = 0; },
      heal: () => { s.player.hp = PLAYER_MAX_HP; },
      place: (x: number) => { s.player.x = x; },
    };
    return () => {
      s.running = false;
      cancelAnimationFrame(s.rafId);
      delete (window as unknown as { __vaderDuel?: unknown }).__vaderDuel;
    };
  }, [isStarted]);

  const handleStart = () => {
    resetGame();
    setIsStarted(true);
  };
  const handleRestart = () => {
    resetGame();
    setIsStarted(false);
    setTimeout(() => setIsStarted(true), 30);
  };
  const handleBack = () => {
    stateRef.current.running = false;
    onBack();
  };

  const showMenu = !isStarted || isGameOver || isVictory;

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="border-2 sm:border-4 border-red-700 rounded-lg touch-none"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: `min(100vw, calc((100vh - 180px) * ${CANVAS_W} / ${CANVAS_H}))`,
          maxHeight: 'calc(100vh - 180px)',
        }}
      />

      {isTouch && !showMenu && <TouchGamepad onChange={handleTouch} />}

      {showMenu && (
        <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4 bg-gradient-to-br from-slate-950 via-black to-red-950/60">
          <div className="bg-black/80 backdrop-blur-xl rounded-3xl p-5 sm:p-8 text-center space-y-4 sm:space-y-6 max-w-lg w-full my-auto border border-red-900/60">
            {isVictory && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-yellow-300">⚔️ VICTORY ⚔️</h1>
                <p className="text-xl sm:text-2xl text-white">Vader is defeated!</p>
                <p className="text-lg text-white/80">Score: {score}</p>
              </>
            )}
            {isGameOver && !isVictory && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-red-500">GAME OVER</h1>
                <p className="text-xl sm:text-2xl text-white">The Sith prevails…</p>
                <p className="text-lg text-white/80">Score: {score}</p>
              </>
            )}
            {!isGameOver && !isVictory && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-wide">VADER DUEL</h1>
                <p className="text-base sm:text-lg text-white/80">Blast Vader. Jump the red wave. When he stomps, troopers drop from the ceiling.</p>
                <div className="text-left text-white/60 text-xs space-y-0.5">
                  <p>⚪ Stormtrooper: 100 HP, walks into range and fires</p>
                  <p>🛡️ Riot Trooper: 175 HP behind a shield. Shoot it from the front to break it and win back 25 HP, then watch out, it charges</p>
                  <p>⚫ Death Trooper: 300 HP, hits harder</p>
                </div>
                {isTouch ? (
                  <div className="text-left text-white/70 text-sm space-y-1">
                    <p>◀ ▶ D-pad to move</p>
                    <p>🟢 JUMP to leap over shockwaves</p>
                    <p>💥 Red button to fire blaster</p>
                  </div>
                ) : (
                  <div className="text-left text-white/70 text-sm space-y-1">
                    <p>🎮 Arrow keys / A D to move</p>
                    <p>⬆️ Space / W / Up to jump</p>
                    <p>💥 X / Z / Ctrl to fire blaster</p>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-4 justify-center flex-wrap">
              <button
                onClick={isGameOver || isVictory ? handleRestart : handleStart}
                disabled={!isReady}
                className="px-6 sm:px-8 py-3 sm:py-4 bg-red-700 hover:bg-red-600 disabled:bg-gray-600 text-white font-bold rounded-xl text-lg sm:text-xl transition-colors"
              >
                {!isReady ? 'Loading…' : isGameOver || isVictory ? 'Try Again' : 'START DUEL'}
              </button>
              <button
                onClick={handleBack}
                className="px-6 sm:px-8 py-3 sm:py-4 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded-xl text-lg sm:text-xl transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {!showMenu && (
        <div className="absolute top-2 right-2 sm:top-4 sm:right-4 flex gap-1.5 sm:gap-2 z-40">
          {onChangeCharacter && (
            <button onClick={() => { stateRef.current.running = false; onChangeCharacter(); }}
              className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" title="Change Character">🎮</button>
          )}
          {onChangeMode && (
            <button onClick={() => { stateRef.current.running = false; onChangeMode(); }}
              className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" title="Change Mode">🎯</button>
          )}
          <button onClick={handleRestart} className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" title="Restart">🔄</button>
          <button onClick={handleBack} className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" title="Back">🏠</button>
        </div>
      )}
    </div>
  );
};
