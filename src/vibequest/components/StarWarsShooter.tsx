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
interface Trooper { x: number; hp: number; shootTimer: number; phase: number; dir: number; hitFlash: number }
interface EnemyBolt { x: number; y: number; vx: number; alive: boolean }
interface Shockwave { x: number; y: number; w: number; h: number; hitCooldown: number }

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
  const [lives, setLives] = useState(3);
  const [vaderHp, setVaderHp] = useState(VADER_MAX_HP);
  const [isTouch, setIsTouch] = useState(false);

  // Mutable game state in a ref so the loop can mutate without React re-renders.
  const stateRef = useRef({
    player: { x: 120, y: GROUND_Y - PLAYER_H, vx: 0, vy: 0, onGround: true, dir: 1, invuln: 0, boltCooldown: 0 },
    bolts: [] as Bolt[],
    shockwaves: [] as Shockwave[],
    troopers: [] as Trooper[],
    enemyBolts: [] as EnemyBolt[],
    trooperTimer: 4,
    vader: { hp: VADER_MAX_HP, attackTimer: 1.5, windup: 0, handRaise: 0, hitFlash: 0, recoil: 0, offset: 0, walkDir: -1, walkPhase: 0 },
    score: 0,
    lives: 3,
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
    s.player = { x: 120, y: GROUND_Y - PLAYER_H, vx: 0, vy: 0, onGround: true, dir: 1, invuln: 0, boltCooldown: 0 };
    s.bolts = [];
    s.shockwaves = [];
    s.troopers = [];
    s.enemyBolts = [];
    s.trooperTimer = 4;
    s.vader = { hp: VADER_MAX_HP, attackTimer: 1.5, windup: 0, handRaise: 0, hitFlash: 0, recoil: 0, offset: 0, walkDir: -1, walkPhase: 0 };
    s.score = 0;
    s.lives = 3;
    s.gameOver = false;
    s.victory = false;
    setScore(0);
    setLives(3);
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
    const TROOPER_W = 40, TROOPER_H = 74;

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
      if (left) { p.vx = -MOVE_SPEED; p.dir = -1; }
      else if (right) { p.vx = MOVE_SPEED; p.dir = 1; }
      else p.vx *= 0.75;

      if (jump && p.onGround) { p.vy = JUMP_V; p.onGround = false; }

      // Shooting
      p.boltCooldown -= dt;
      if (shoot && p.boltCooldown <= 0) {
        p.boltCooldown = BOLT_COOLDOWN;
        s.bolts.push({
          x: p.dir > 0 ? p.x + PLAYER_W : p.x - 12,
          y: p.y + PLAYER_H * 0.4,
          vx: BOLT_SPEED * p.dir,
          alive: true,
        });
      }

      // ---- Physics ----
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 20) p.x = 20;
      if (p.x + PLAYER_W > CANVAS_W - VADER_W * 0.35) p.x = CANVAS_W - VADER_W * 0.35 - PLAYER_W;
      if (p.y + PLAYER_H >= GROUND_Y) {
        p.y = GROUND_Y - PLAYER_H;
        p.vy = 0;
        p.onGround = true;
      }
      if (p.invuln > 0) p.invuln -= dt;

      // ---- Bolts ----
      for (const b of s.bolts) {
        b.x += b.vx * dt;
        if (b.x > CANVAS_W + 40 || b.x < -40) b.alive = false;
        for (const tr of s.troopers) {
          if (b.alive && tr.hp > 0 && b.x > tr.x && b.x < tr.x + TROOPER_W && b.y > GROUND_Y - TROOPER_H && b.y < GROUND_Y) {
            b.alive = false; tr.hp -= 1; tr.hitFlash = 0.2;
            if (tr.hp <= 0) { s.score += 25; setScore(s.score); }
          }
        }
        // Hit Vader
        if (b.alive && b.x > vaderHitLeft && b.x < vaderHitRight && b.y > vaderScreenY + 60 && b.y < vaderScreenY + VADER_H - 80) {
          b.alive = false;
          s.vader.hp -= 1;
          s.vader.hitFlash = 0.3;
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
      if (v.windup <= 0 && v.recoil <= 0) {
        v.offset += v.walkDir * 45 * dt;
        v.walkPhase += dt * 6;
        if (v.offset < -90) { v.offset = -90; v.walkDir = 1; }
        if (v.offset > 0) { v.offset = 0; v.walkDir = -1; }
      }
      // ---- Stormtroopers ----
      s.trooperTimer -= dt;
      if (s.trooperTimer <= 0 && s.troopers.length < 2) {
        s.troopers.push({ x: -TROOPER_W, hp: 2, shootTimer: 1.2, phase: 0, dir: 1, hitFlash: 0 });
        s.trooperTimer = 7;
      }
      for (const tr of s.troopers) {
        if (tr.hitFlash > 0) tr.hitFlash -= dt;
        const dist = p.x - tr.x;
        tr.dir = dist >= 0 ? 1 : -1;
        if (Math.abs(dist) > 220) { tr.x += tr.dir * 90 * dt; tr.phase += dt * 9; }
        else tr.phase *= 0.9;
        tr.shootTimer -= dt;
        if (tr.shootTimer <= 0) {
          tr.shootTimer = 1.8;
          s.enemyBolts.push({ x: tr.x + (tr.dir > 0 ? TROOPER_W : 0), y: GROUND_Y - TROOPER_H * 0.55, vx: 420 * tr.dir, alive: true });
        }
      }
      s.troopers = s.troopers.filter(tr => tr.hp > 0);
      for (const eb of s.enemyBolts) {
        eb.x += eb.vx * dt;
        if (eb.x < -40 || eb.x > CANVAS_W + 40) eb.alive = false;
        if (eb.alive && p.invuln <= 0 && eb.x > p.x && eb.x < p.x + PLAYER_W && eb.y > p.y && eb.y < p.y + PLAYER_H) {
          eb.alive = false; s.lives -= 1; p.invuln = 1.5; setLives(s.lives);
          if (s.lives <= 0 && !s.gameOver) { s.gameOver = true; s.running = false; setIsGameOver(true); }
        }
      }
      s.enemyBolts = s.enemyBolts.filter(eb => eb.alive);
      if (v.windup > 0) {
        v.windup -= dt;
        v.handRaise = Math.min(1, v.handRaise + dt * 4);
        if (v.windup <= 0) {
          // spawn shockwave
          s.shockwaves.push({
            x: vaderScreenX,
            y: GROUND_Y - SHOCKWAVE_H,
            w: 96,
            h: SHOCKWAVE_H,
            hitCooldown: 0,
          });
          v.attackTimer = ATTACK_INTERVAL;
          v.recoil = 1;
        }
      } else {
        v.handRaise = Math.max(0, v.handRaise - dt * 3);
        v.attackTimer -= dt;
        if (v.attackTimer <= 0) v.windup = WINDUP_TIME;
      }

      // ---- Shockwaves ----
      for (const sw of s.shockwaves) {
        sw.x -= SHOCKWAVE_SPEED * dt;
        if (sw.hitCooldown > 0) sw.hitCooldown -= dt;
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
          s.lives -= 1;
          p.invuln = 1.5;
          setLives(s.lives);
          if (s.lives <= 0 && !s.gameOver) {
            s.gameOver = true;
            s.running = false;
            setIsGameOver(true);
          }
        }
      }
      s.shockwaves = s.shockwaves.filter(sw => sw.x + sw.w > -40);

      // ---- Render ----
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
      ctx.fillRect(vaderScreenX - 120, GROUND_Y - 120, VADER_W + 150, 220);

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
        const walking = v.windup <= 0 && v.recoil <= 0;
        const stepBob = walking ? -Math.abs(Math.sin(v.walkPhase)) * 10 : 0;
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
        // Attack arm: hangs, rises overhead on wind-up, slams down on release
        ctx.shadowBlur = 0;
        const shX = -VADER_W * 0.22, shY = -VADER_H * 0.64;
        const restA = Math.PI * 0.62 + (walking ? Math.sin(v.walkPhase) * 0.15 : 0);
        const upA = -Math.PI * 0.62;
        const slamA = Math.PI * 0.85;
        let armA = restA + (upA - restA) * v.handRaise;
        if (v.recoil > 0) armA = slamA + (restA - slamA) * (1 - v.recoil);
        const armL = VADER_H * 0.3;
        ctx.save();
        ctx.translate(shX, shY);
        ctx.rotate(armA);
        ctx.fillStyle = '#0b0b0f';
        ctx.strokeStyle = '#2a2a33';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(0, -14, armL, 28, 14);
        ctx.fill(); ctx.stroke();
        // gloved fist
        ctx.beginPath();
        ctx.arc(armL, 0, 20, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        // charging orb in hand
        if (v.handRaise > 0.02) {
          const orbR = 10 + v.handRaise * 28 + Math.sin(t * 20) * 3;
          const og = ctx.createRadialGradient(armL, 0, 0, armL, 0, orbR);
          og.addColorStop(0, 'rgba(255,220,220,1)');
          og.addColorStop(0.4, 'rgba(255,40,40,0.9)');
          og.addColorStop(1, 'rgba(255,40,40,0)');
          ctx.fillStyle = og;
          ctx.beginPath();
          ctx.arc(armL, 0, orbR, 0, Math.PI * 2);
          ctx.fill();
        }
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

      // Shockwaves drawn as curling red waves (moving left, crest at front)
      for (const sw of s.shockwaves) {
        const x0 = sw.x, x1 = sw.x + sw.w, base = sw.y + sw.h, top = sw.y;
        const bob = Math.sin(t * 10 + sw.x * 0.03) * 3;
        ctx.save();
        ctx.shadowColor = 'rgba(255,50,50,0.9)';
        ctx.shadowBlur = 14;
        const wg = ctx.createLinearGradient(0, top, 0, base);
        wg.addColorStop(0, '#ffb3a3');
        wg.addColorStop(0.5, '#e01b1b');
        wg.addColorStop(1, '#5a0000');
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(x1 + 30, base);
        ctx.quadraticCurveTo(x1, base - sw.h * 0.3, x0 + sw.w * 0.45, top + bob);
        ctx.quadraticCurveTo(x0 + sw.w * 0.1, top - 6 + bob, x0 - 4, top + sw.h * 0.35);
        ctx.quadraticCurveTo(x0 + sw.w * 0.18, top + sw.h * 0.3, x0 + sw.w * 0.2, top + sw.h * 0.55);
        ctx.quadraticCurveTo(x0 + sw.w * 0.05, base - 6, x0 - 10, base);
        ctx.closePath();
        ctx.fill();
        // Inner curl (tube)
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(60,0,0,0.75)';
        ctx.beginPath();
        ctx.ellipse(x0 + sw.w * 0.24, top + sw.h * 0.5, sw.w * 0.08, sw.h * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        // Foam on crest
        ctx.fillStyle = 'rgba(255,230,225,0.95)';
        for (let i = 0; i < 7; i++) {
          const fx = x0 + sw.w * (0.02 + i * 0.07) + Math.sin(t * 14 + i) * 2;
          const fy = top + bob + Math.abs(i - 2) * 3 - 2;
          ctx.beginPath();
          ctx.arc(fx, fy, 3.5 - i * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
        // Spray droplets
        for (let i = 0; i < 5; i++) {
          ctx.globalAlpha = 0.5 + Math.random() * 0.5;
          ctx.beginPath();
          ctx.arc(x0 - Math.random() * 14, top + Math.random() * sw.h * 0.5, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // Foamy wake along the ground
        ctx.fillStyle = 'rgba(255,120,110,0.6)';
        ctx.fillRect(x0, base - 3, sw.w + 50, 3);
        ctx.restore();
      }

      // Stormtroopers
      for (const tr of s.troopers) {
        ctx.save();
        const bx = tr.x, by = GROUND_Y;
        const swing = Math.sin(tr.phase) * 0.5;
        const bob = -Math.abs(Math.sin(tr.phase)) * 3;
        if (tr.hitFlash > 0) ctx.globalAlpha = 0.5;
        ctx.translate(bx + TROOPER_W / 2, by + bob);
        ctx.scale(tr.dir, 1);
        ctx.fillStyle = '#f2f2f2'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
        // legs
        for (const sgn of [1, -1]) {
          ctx.save(); ctx.translate(sgn * 6, -30); ctx.rotate(swing * sgn);
          ctx.beginPath(); ctx.roundRect(-5, 0, 10, 30, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#222'; ctx.fillRect(-5, 26, 12, 4); ctx.fillStyle = '#f2f2f2';
          ctx.restore();
        }
        // torso
        ctx.beginPath(); ctx.roundRect(-14, -58, 28, 30, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#222'; ctx.fillRect(-14, -34, 28, 4);
        // blaster arm
        ctx.fillStyle = '#f2f2f2';
        ctx.beginPath(); ctx.roundRect(4, -52, 20, 8, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1a1a1a'; ctx.fillRect(18, -54, 16, 6);
        // helmet
        ctx.fillStyle = '#f7f7f7';
        ctx.beginPath(); ctx.arc(0, -68, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.ellipse(5, -70, 5, 3, -0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(2, -62, 9, 2);
        ctx.restore();
      }
      for (const eb of s.enemyBolts) {
        ctx.save();
        ctx.shadowColor = '#ff3030'; ctx.shadowBlur = 12;
        ctx.fillStyle = '#ff4a4a'; ctx.fillRect(eb.x - 10, eb.y - 2, 20, 4);
        ctx.fillStyle = '#fff'; ctx.fillRect(eb.x - 4, eb.y - 1, 8, 2);
        ctx.restore();
      }

      // Player
      if (s.playerImg) {
        ctx.save();
        if (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) ctx.globalAlpha = 0.4;
        if (p.dir < 0) {
          ctx.scale(-1, 1);
          ctx.drawImage(s.playerImg, -p.x - PLAYER_W, p.y, PLAYER_W, PLAYER_H);
        } else {
          ctx.drawImage(s.playerImg, p.x, p.y, PLAYER_W, PLAYER_H);
        }
        ctx.restore();
      }

      // Bolts (green blaster)
      for (const b of s.bolts) {
        ctx.save();
        ctx.shadowColor = '#a3ff5c';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#d4ff7a';
        ctx.fillRect(b.x - 10, b.y - 2, 20, 4);
        ctx.fillStyle = '#fff';
        ctx.fillRect(b.x - 4, b.y - 1, 8, 2);
        ctx.restore();
      }

      // HUD: lives + score
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`❤ ${s.lives}`, 16, 26);
      ctx.fillText(`SCORE ${s.score}`, 16, 48);

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
    return () => {
      s.running = false;
      cancelAnimationFrame(s.rafId);
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
                <p className="text-base sm:text-lg text-white/80">Blast Vader and his stormtroopers. Jump the red wave.</p>
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
