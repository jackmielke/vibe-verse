/**
 * Channels the Magic Screen already knows.
 *
 * Each is a program in exactly the form the coder writes (a `draw(t, dt)`
 * over `ctx`, `W`, `H`, `input`, `beep`, `rand`), run through the same
 * sandbox. They are what the screen shows before anybody has asked for
 * anything, what "put pong on the screen" finds without a network, and the
 * rig that proves the sandbox works in a place where the coder cannot be
 * reached.
 */

export interface Channel {
  id: string;
  title: string;
  /** Words that find it. */
  words: RegExp;
  code: string;
}

const WELCOME = `
const petals = [];
function setup() { for (let i = 0; i < 40; i++) petals.push({ x: rand() * W, y: rand() * H, s: 2 + rand() * 3, v: 10 + rand() * 20, p: rand() * 6 }); }
function draw(t, dt) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1d1440"); g.addColorStop(0.6, "#5a2f6e"); g.addColorStop(1, "#f08a6c");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // A moon and the ridge.
  ctx.fillStyle = "rgba(255,240,220,0.9)"; ctx.beginPath(); ctx.arc(380, 70, 26, 0, 7); ctx.fill();
  ctx.fillStyle = "#2a1838"; ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 10) ctx.lineTo(x, 200 - Math.sin(x * 0.02) * 20 - Math.sin(x * 0.05 + 1) * 8);
  ctx.lineTo(W, H); ctx.fill();
  for (const p of petals) {
    p.y += p.v * dt; p.x += Math.sin(t + p.p) * 12 * dt + 6 * dt;
    if (p.y > H) { p.y = -5; p.x = rand() * W; }
    ctx.fillStyle = "rgba(255,190,215,0.9)";
    ctx.beginPath(); ctx.ellipse(p.x % W, p.y, p.s, p.s * 0.6, t + p.p, 0, 7); ctx.fill();
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff4e6"; ctx.font = "bold 34px serif";
  ctx.fillText("The Magic Screen", W / 2, 96);
  ctx.font = "15px sans-serif"; ctx.fillStyle = "rgba(255,244,230,0.85)";
  ctx.fillText("Ask Vibey to make anything appear here:", W / 2, 132);
  const ideas = ["a game of snake", "a koi pond", "fireworks", "a clock", "pong", "a starfield"];
  ctx.font = "italic 18px serif"; ctx.fillStyle = "#ffd6a0";
  ctx.fillText("\\u201c" + ideas[Math.floor(t / 3) % ideas.length] + "\\u201d", W / 2, 162);
}
`;

const SNAKE = `
const C = 15, CW = Math.floor(W / C), CH = Math.floor(H / C);
let snake, dir, next, food, score, over, acc, best = 0;
function reset() { snake = [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }]; dir = { x: 1, y: 0 }; next = dir; food = spot(); score = 0; over = 0; acc = 0; }
function spot() { return { x: Math.floor(rand() * CW), y: Math.floor(rand() * CH) }; }
function setup() { reset(); }
function draw(t, dt) {
  if (input.left && dir.x !== 1) next = { x: -1, y: 0 };
  if (input.right && dir.x !== -1) next = { x: 1, y: 0 };
  if (input.up && dir.y !== 1) next = { x: 0, y: -1 };
  if (input.down && dir.y !== -1) next = { x: 0, y: 1 };
  ctx.fillStyle = "#0f2a1e"; ctx.fillRect(0, 0, W, H);
  if (over > 0) { over -= dt; if (over <= 0) reset(); }
  else {
    acc += dt;
    while (acc > 0.11) {
      acc -= 0.11; dir = next;
      const h = { x: (snake[0].x + dir.x + CW) % CW, y: (snake[0].y + dir.y + CH) % CH };
      if (snake.some((s) => s.x === h.x && s.y === h.y)) { over = 2; best = Math.max(best, score); beep(110, 0.4, "sawtooth"); break; }
      snake.unshift(h);
      if (h.x === food.x && h.y === food.y) { score++; food = spot(); beep(660 + score * 20, 0.08, "square", 0.4); } else snake.pop();
    }
  }
  ctx.fillStyle = "#ff5a6a"; ctx.beginPath(); ctx.arc(food.x * C + C / 2, food.y * C + C / 2, C / 2 - 1, 0, 7); ctx.fill();
  snake.forEach((s, i) => { ctx.fillStyle = i ? "#7bf0a8" : "#e9fff2"; ctx.fillRect(s.x * C + 1, s.y * C + 1, C - 2, C - 2); });
  ctx.fillStyle = "#e9fff2"; ctx.font = "bold 16px monospace"; ctx.textAlign = "left";
  ctx.fillText("SNAKE  " + score + "   best " + best, 10, 20);
  if (over > 0) { ctx.textAlign = "center"; ctx.font = "bold 30px monospace"; ctx.fillText("GAME OVER", W / 2, H / 2); }
  else if (t < 5 && score === 0) { ctx.textAlign = "center"; ctx.font = "14px monospace"; ctx.fillText("arrows / stick to steer", W / 2, H - 14); }
}
`;

const KOI = `
const fish = [];
function setup() { for (let i = 0; i < 9; i++) fish.push({ x: rand() * W, y: rand() * H, a: rand() * 6.28, s: 18 + rand() * 14, c: ["#f25c2c", "#fff", "#f2b33a", "#e84a3a"][i % 4], p: rand() * 6 }); }
function draw(t, dt) {
  ctx.fillStyle = "#123c4a"; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) { ctx.strokeStyle = "rgba(160,220,230," + (0.12 - i * 0.015) + ")"; ctx.beginPath(); ctx.arc(W / 2 + Math.sin(t * 0.3 + i) * 80, H / 2, 30 + ((t * 25 + i * 40) % 240), 0, 7); ctx.stroke(); }
  for (const f of fish) {
    f.a += Math.sin(t * 0.5 + f.p) * 0.6 * dt;
    f.x = (f.x + Math.cos(f.a) * 30 * dt + W) % W; f.y = (f.y + Math.sin(f.a) * 30 * dt + H) % H;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.a);
    ctx.fillStyle = f.c; ctx.beginPath(); ctx.ellipse(0, 0, f.s, f.s * 0.38, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-f.s * 0.9, 0); ctx.lineTo(-f.s * 1.5, Math.sin(t * 8 + f.p) * f.s * 0.4 - f.s * 0.3); ctx.lineTo(-f.s * 1.5, Math.sin(t * 8 + f.p) * f.s * 0.4 + f.s * 0.3); ctx.fill();
    if (f.c === "#fff") { ctx.fillStyle = "#e0482b"; ctx.beginPath(); ctx.arc(f.s * 0.2, 0, f.s * 0.25, 0, 7); ctx.fill(); }
    ctx.restore();
  }
  ctx.fillStyle = "rgba(90,160,90,0.8)";
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(60 + i * 90, 40 + (i % 2) * 180, 22, 0.4, 6.0); ctx.lineTo(60 + i * 90, 40 + (i % 2) * 180); ctx.fill(); }
}
`;

const PONG = `
let by, bx, vx, vy, p, ai, sp = 0, sa = 0;
function serve(d) { bx = W / 2; by = H / 2; vx = 170 * d; vy = (rand() - 0.5) * 160; }
function setup() { p = H / 2; ai = H / 2; serve(1); }
function draw(t, dt) {
  if (input.up) p -= 220 * dt; if (input.down) p += 220 * dt;
  if (input.pressed) p = input.y * H;
  p = Math.max(30, Math.min(H - 30, p));
  ai += Math.max(-150 * dt, Math.min(150 * dt, by - ai));
  bx += vx * dt; by += vy * dt;
  if (by < 6 || by > H - 6) { vy = -vy; beep(300, 0.03); }
  if (bx < 26 && Math.abs(by - p) < 32 && vx < 0) { vx = -vx * 1.05; vy += (by - p) * 3; beep(520, 0.05); }
  if (bx > W - 26 && Math.abs(by - ai) < 32 && vx > 0) { vx = -vx * 1.05; vy += (by - ai) * 3; beep(520, 0.05); }
  if (bx < -10) { sa++; serve(1); beep(150, 0.3, "sawtooth"); }
  if (bx > W + 10) { sp++; serve(-1); beep(880, 0.2); }
  ctx.fillStyle = "#0b0b18"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#39406a"; for (let y = 0; y < H; y += 16) ctx.fillRect(W / 2 - 1, y, 2, 8);
  ctx.fillStyle = "#fff"; ctx.fillRect(12, p - 28, 8, 56); ctx.fillRect(W - 20, ai - 28, 8, 56);
  ctx.beginPath(); ctx.arc(bx, by, 5, 0, 7); ctx.fill();
  ctx.font = "bold 32px monospace"; ctx.textAlign = "center"; ctx.fillText(sp + "   " + sa, W / 2, 40);
  if (t < 5) { ctx.font = "13px monospace"; ctx.fillText("up / down to move", W / 2, H - 12); }
}
`;

const FIREWORKS = `
const parts = [];
let next = 0;
function draw(t, dt) {
  ctx.fillStyle = "rgba(8,6,24,0.22)"; ctx.fillRect(0, 0, W, H);
  next -= dt;
  if (next <= 0 || input.pressed || input.a) {
    next = 0.5 + rand() * 0.9;
    const x = input.pressed ? input.x * W : 60 + rand() * (W - 120), y = input.pressed ? input.y * H : 40 + rand() * 120;
    const hue = Math.floor(rand() * 360);
    for (let i = 0; i < 70; i++) { const a = rand() * 6.28, s = 40 + rand() * 110; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, l: 1.4 + rand(), h: hue + rand() * 40 }); }
    beep(90 + rand() * 60, 0.35, "sawtooth", 0.3);
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.l -= dt; if (p.l <= 0) { parts.splice(i, 1); continue; }
    p.vy += 60 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.fillStyle = "hsla(" + p.h + ",100%," + (50 + p.l * 20) + "%," + Math.min(1, p.l) + ")";
    ctx.fillRect(p.x, p.y, 2.2, 2.2);
  }
  ctx.fillStyle = "#140c20"; ctx.fillRect(0, H - 24, W, 24);
}
`;

const CLOCK = `
function draw(t) {
  const d = new Date();
  ctx.fillStyle = "#f4ead8"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#c23a2b"; ctx.beginPath(); ctx.arc(135, 135, 100, 0, 7); ctx.fill();
  ctx.fillStyle = "#f4ead8"; ctx.beginPath(); ctx.arc(135, 135, 92, 0, 7); ctx.fill();
  const hand = (a, len, w, c) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(135, 135); ctx.lineTo(135 + Math.sin(a) * len, 135 - Math.cos(a) * len); ctx.stroke(); };
  for (let i = 0; i < 12; i++) hand(i / 12 * 6.283, 88, 3, "#2a1d16"), hand(i / 12 * 6.283, 78, 5, "#f4ead8");
  const s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
  hand(h / 12 * 6.283, 50, 7, "#2a1d16"); hand(m / 60 * 6.283, 75, 4, "#2a1d16"); hand(s / 60 * 6.283, 82, 2, "#c23a2b");
  ctx.fillStyle = "#2a1d16"; ctx.textAlign = "left"; ctx.font = "bold 46px monospace";
  const p2 = (n) => String(n).padStart(2, "0");
  ctx.fillText(p2(d.getHours()) + ":" + p2(d.getMinutes()), 270, 125);
  ctx.font = "18px serif"; ctx.fillText(d.toDateString(), 272, 158);
  ctx.font = "30px serif"; ctx.fillStyle = "#c23a2b"; ctx.fillText("\\u661f\\u6751", 272, 205);
}
`;

const STARFIELD = `
const stars = [];
function setup() { for (let i = 0; i < 300; i++) stars.push({ x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand() }); }
function draw(t, dt) {
  ctx.fillStyle = "rgba(2,2,12,0.35)"; ctx.fillRect(0, 0, W, H);
  const sp = input.a || input.pressed ? 1.4 : 0.35;
  for (const s of stars) {
    const pz = s.z; s.z -= sp * dt; if (s.z <= 0.02) { s.x = rand() * 2 - 1; s.y = rand() * 2 - 1; s.z = 1; continue; }
    const x = W / 2 + s.x / s.z * W * 0.4, y = H / 2 + s.y / s.z * H * 0.4, x0 = W / 2 + s.x / pz * W * 0.4, y0 = H / 2 + s.y / pz * H * 0.4;
    ctx.strokeStyle = "rgba(200,220,255," + (1 - s.z) + ")"; ctx.lineWidth = (1 - s.z) * 2.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
  }
}
`;

const PLASMA = `
const img = ctx.createImageData(W / 4, H / 4);
function draw(t) {
  const w = W / 4, h = H / 4, d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.sin(x * 0.12 + t) + Math.sin((y * 0.1 + t) * 1.3) + Math.sin((x + y) * 0.07 + t * 0.7) + Math.sin(Math.hypot(x - w / 2, y - h / 2) * 0.15 - t * 2);
    const i = (y * w + x) * 4;
    d[i] = 128 + 127 * Math.sin(v * 1.2); d[i + 1] = 128 + 127 * Math.sin(v * 1.2 + 2); d[i + 2] = 128 + 127 * Math.sin(v * 1.2 + 4); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, w, h, 0, 0, W, H);
}
`;

export const CHANNELS: Channel[] = [
  { id: "welcome", title: "The Magic Screen", words: /\bwelcome|\bhome\b|\bmenu\b/, code: WELCOME },
  { id: "snake", title: "Snake", words: /\bsnake/, code: SNAKE },
  { id: "koi", title: "Koi pond", words: /\bkoi|\bfish|\bpond|\baquarium/, code: KOI },
  { id: "pong", title: "Pong", words: /\bpong|\bpaddle|\btennis/, code: PONG },
  { id: "fireworks", title: "Fireworks", words: /\bfirework|\bhanabi/, code: FIREWORKS },
  { id: "clock", title: "Clock", words: /\bclock|\btime is it|\bwhat time/, code: CLOCK },
  { id: "stars", title: "Starfield", words: /\bstar ?field|\bwarp|\bhyperspace|\bspace\b/, code: STARFIELD },
  { id: "plasma", title: "Plasma", words: /\bplasma|\bpsychedelic|\btrippy|\brainbow/, code: PLASMA },
];

export function findChannel(request: string): Channel | null {
  const t = request.toLowerCase();
  return CHANNELS.find((c) => c.words.test(t)) ?? null;
}
