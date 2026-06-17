/**
 * Agario — a self-contained, single-player take on the classic agar.io.
 *
 * Rules:
 *   - Move your cell toward the mouse (or touch). Bigger = slower.
 *   - Eat the little pellets scattered around the world to grow.
 *   - Eat AI blobs smaller than you to absorb their mass; avoid bigger ones.
 *   - Press Space (or the Split button) to split into two cells and lunge —
 *     great for catching prey, risky if a bigger blob is nearby.
 *   - Cells slowly merge back together after a cooldown.
 *   - Get eaten and it's game over. Best mass is saved to localStorage.
 *
 * Everything runs on a single 2D <canvas> with a requestAnimationFrame loop.
 * No backend, no multiplayer — just a tight, juicy arcade loop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Play, RotateCcw, Trophy, Scissors } from "lucide-react";

const WORLD = 6000;
const PELLET_COUNT = 900;
const BOT_COUNT = 22;
const BEST_KEY = "agario.bestMass";

const NAMES = [
  "Blobby", "Nomster", "Squish", "Gulp", "Munch", "Voltan", "Pip", "Zorp",
  "Bigly", "Tiny", "Chomp", "Wibble", "Goo", "Splat", "Orbit", "Nibbz",
  "Pudge", "Yolk", "Bubz", "Fizz", "Mochi", "Taro", "Boba", "Quark",
];

const COLORS = [
  "#ff5e7e", "#ffb14e", "#ffe14e", "#6bd968", "#4ec3ff", "#7b6bff",
  "#ff6bd5", "#3ee8c8", "#ff8c42", "#9b6bff", "#42e6ff", "#ff4e9e",
];

type Vec = { x: number; y: number };

type Cell = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  mergeAt: number; // timestamp after which it may re-merge
};

type Blob = {
  id: number;
  name: string;
  color: string;
  cells: Cell[];
  isPlayer: boolean;
  // simple AI memory
  target: Vec;
  retargetAt: number;
};

type Pellet = { x: number; y: number; r: number; color: string };

type GameState = "idle" | "playing" | "dead";

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const massToRadius = (m: number) => Math.sqrt(m / Math.PI) * 6;
const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

function spawnPellet(): Pellet {
  return {
    x: rand(0, WORLD),
    y: rand(0, WORLD),
    r: rand(4, 7),
    color: COLORS[(Math.random() * COLORS.length) | 0],
  };
}

function makeBlob(id: number, isPlayer: boolean, startMass: number): Blob {
  return {
    id,
    name: isPlayer ? "You" : NAMES[(Math.random() * NAMES.length) | 0],
    color: COLORS[(Math.random() * COLORS.length) | 0],
    isPlayer,
    target: { x: rand(0, WORLD), y: rand(0, WORLD) },
    retargetAt: 0,
    cells: [
      {
        x: rand(WORLD * 0.2, WORLD * 0.8),
        y: rand(WORLD * 0.2, WORLD * 0.8),
        vx: 0,
        vy: 0,
        mass: startMass,
        mergeAt: 0,
      },
    ],
  };
}

const blobMass = (b: Blob) => b.cells.reduce((s, c) => s + c.mass, 0);

export default function Agario() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<GameState>("idle");
  const [mass, setMass] = useState(20);
  const [rank, setRank] = useState(1);
  const [best, setBest] = useState(() => {
    const v = Number(localStorage.getItem(BEST_KEY) || 0);
    return Number.isFinite(v) ? v : 0;
  });

  // Mutable game world kept in refs so the RAF loop doesn't re-render.
  const blobsRef = useRef<Blob[]>([]);
  const pelletsRef = useRef<Pellet[]>([]);
  const mouseRef = useRef<Vec>({ x: 0, y: 0 }); // screen-space
  const camRef = useRef<Vec>({ x: WORLD / 2, y: WORLD / 2 });
  const zoomRef = useRef(1);
  const stateRef = useRef<GameState>("idle");
  const rafRef = useRef<number>(0);
  const lastRef = useRef<number>(0);
  const wantSplitRef = useRef(false);

  stateRef.current = state;

  const resetWorld = useCallback(() => {
    pelletsRef.current = Array.from({ length: PELLET_COUNT }, spawnPellet);
    const player = makeBlob(0, true, 20);
    const bots = Array.from({ length: BOT_COUNT }, (_, i) =>
      makeBlob(i + 1, false, rand(15, 120)),
    );
    blobsRef.current = [player, ...bots];
    camRef.current = { x: player.cells[0].x, y: player.cells[0].y };
  }, []);

  const startGame = useCallback(() => {
    resetWorld();
    setMass(20);
    setRank(1);
    setState("playing");
  }, [resetWorld]);

  const doSplit = useCallback(() => {
    wantSplitRef.current = true;
  }, []);

  // ---- input ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        wantSplitRef.current = true;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ---- main loop ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const step = (now: number) => {
      rafRef.current = requestAnimationFrame(step);
      const dt = Math.min(0.05, (now - lastRef.current) / 1000 || 0);
      lastRef.current = now;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (stateRef.current === "playing") {
        update(dt, w, h, now);
      }
      render(ctx, w, h);
    };

    rafRef.current = requestAnimationFrame((t) => {
      lastRef.current = t;
      step(t);
    });

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- update
  function update(dt: number, w: number, h: number, now: number) {
    const blobs = blobsRef.current;
    const pellets = pelletsRef.current;
    const player = blobs.find((b) => b.isPlayer);
    if (!player) return;

    // Player aim vector from mouse relative to screen center.
    const aim: Vec = {
      x: mouseRef.current.x - w / 2,
      y: mouseRef.current.y - h / 2,
    };

    // ---- movement per blob ----
    for (const b of blobs) {
      let dir: Vec;
      if (b.isPlayer) {
        dir = aim;
      } else {
        if (now > b.retargetAt) {
          b.retargetAt = now + rand(800, 2200);
          b.target = chooseBotTarget(b, blobs, pellets);
        }
        const c = b.cells[0];
        dir = { x: b.target.x - c.x, y: b.target.y - c.y };
      }
      const len = Math.hypot(dir.x, dir.y) || 1;
      const nx = dir.x / len;
      const ny = dir.y / len;

      for (const c of b.cells) {
        const r = massToRadius(c.mass);
        const speed = (220 / Math.pow(r, 0.45)) * (b.isPlayer ? 1 : 0.92);
        // ease velocity toward desired
        c.vx += (nx * speed - c.vx) * Math.min(1, dt * 8);
        c.vy += (ny * speed - c.vy) * Math.min(1, dt * 8);
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        // walls
        c.x = Math.max(r, Math.min(WORLD - r, c.x));
        c.y = Math.max(r, Math.min(WORLD - r, c.y));
        // slow mass decay for big blobs (classic agar feel)
        if (c.mass > 60) c.mass -= c.mass * 0.004 * dt;
      }

      // keep own cells apart unless ready to merge
      separateCells(b, now);
      mergeCells(b, now);
    }

    // ---- player split request ----
    if (wantSplitRef.current) {
      wantSplitRef.current = false;
      splitBlob(player, aim, now);
    }
    // bots occasionally split when chasing prey
    for (const b of blobs) {
      if (!b.isPlayer && Math.random() < 0.0015 && blobMass(b) > 60) {
        const c = b.cells[0];
        splitBlob(b, { x: b.target.x - c.x, y: b.target.y - c.y }, now);
      }
    }

    // ---- eat pellets ----
    for (const b of blobs) {
      for (const c of b.cells) {
        const r = massToRadius(c.mass);
        for (let i = 0; i < pellets.length; i++) {
          const p = pellets[i];
          if (dist2(c.x, c.y, p.x, p.y) < r * r) {
            c.mass += 1.2;
            pellets[i] = spawnPellet();
          }
        }
      }
    }

    // ---- blob vs blob consumption ----
    for (const a of blobs) {
      for (const ac of a.cells) {
        const ar = massToRadius(ac.mass);
        for (const d of blobs) {
          if (d === a) continue;
          for (let j = d.cells.length - 1; j >= 0; j--) {
            const dc = d.cells[j];
            const dr = massToRadius(dc.mass);
            // need to be meaningfully bigger and overlapping the center
            if (ac.mass > dc.mass * 1.15) {
              const reach = ar - dr * 0.4;
              if (dist2(ac.x, ac.y, dc.x, dc.y) < reach * reach) {
                ac.mass += dc.mass;
                d.cells.splice(j, 1);
              }
            }
          }
        }
      }
    }

    // ---- remove dead bots, respawn to keep world busy ----
    for (let i = blobs.length - 1; i >= 0; i--) {
      const b = blobs[i];
      if (b.isPlayer) continue;
      if (b.cells.length === 0) {
        blobs[i] = makeBlob(b.id, false, rand(15, 90));
      }
    }

    // ---- player death ----
    if (player.cells.length === 0) {
      endGame(player);
      return;
    }

    // ---- camera follows player centroid; zoom out as you grow ----
    const cen = centroid(player);
    const total = blobMass(player);
    const targetZoom = Math.max(0.35, Math.min(1.1, 14 / Math.sqrt(total)));
    zoomRef.current += (targetZoom - zoomRef.current) * Math.min(1, dt * 3);
    camRef.current.x += (cen.x - camRef.current.x) * Math.min(1, dt * 5);
    camRef.current.y += (cen.y - camRef.current.y) * Math.min(1, dt * 5);

    // ---- HUD stats ----
    const sorted = [...blobs].sort((p, q) => blobMass(q) - blobMass(p));
    setRank(sorted.findIndex((b) => b.isPlayer) + 1);
    setMass(Math.round(total));
  }

  function endGame(player: Blob) {
    const finalMass = Math.round(blobMass(player) || mass);
    setState("dead");
    setBest((prev) => {
      const next = Math.max(prev, finalMass, mass);
      localStorage.setItem(BEST_KEY, String(next));
      return next;
    });
  }

  function chooseBotTarget(b: Blob, blobs: Blob[], pellets: Pellet[]): Vec {
    const c = b.cells[0];
    const myMass = blobMass(b);
    let flee: Vec | null = null;
    let prey: Vec | null = null;
    let bestPreyD = Infinity;
    let bestThreatD = Infinity;
    for (const o of blobs) {
      if (o === b) continue;
      const oc = o.cells[0];
      if (!oc) continue;
      const d = dist2(c.x, c.y, oc.x, oc.y);
      const om = blobMass(o);
      if (om > myMass * 1.2 && d < 500 * 500 && d < bestThreatD) {
        bestThreatD = d;
        flee = { x: c.x - (oc.x - c.x), y: c.y - (oc.y - c.y) };
      } else if (myMass > om * 1.25 && d < 700 * 700 && d < bestPreyD) {
        bestPreyD = d;
        prey = { x: oc.x, y: oc.y };
      }
    }
    if (flee) return flee;
    if (prey) return prey;
    // wander toward nearest few pellets
    let nx = c.x;
    let ny = c.y;
    let nd = Infinity;
    for (let i = 0; i < 40; i++) {
      const p = pellets[(Math.random() * pellets.length) | 0];
      const d = dist2(c.x, c.y, p.x, p.y);
      if (d < nd) {
        nd = d;
        nx = p.x;
        ny = p.y;
      }
    }
    return { x: nx, y: ny };
  }

  function centroid(b: Blob): Vec {
    let x = 0;
    let y = 0;
    let m = 0;
    for (const c of b.cells) {
      x += c.x * c.mass;
      y += c.y * c.mass;
      m += c.mass;
    }
    return m ? { x: x / m, y: y / m } : { x: b.cells[0].x, y: b.cells[0].y };
  }

  function separateCells(b: Blob, now: number) {
    const cs = b.cells;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const d = cs[j];
        if (now > a.mergeAt && now > d.mergeAt) continue; // allowed to overlap/merge
        const ra = massToRadius(a.mass);
        const rd = massToRadius(d.mass);
        const dx = d.x - a.x;
        const dy = d.y - a.y;
        const dd = Math.hypot(dx, dy) || 0.01;
        const overlap = ra + rd - dd;
        if (overlap > 0) {
          const ux = dx / dd;
          const uy = dy / dd;
          a.x -= ux * overlap * 0.5;
          a.y -= uy * overlap * 0.5;
          d.x += ux * overlap * 0.5;
          d.y += uy * overlap * 0.5;
        }
      }
    }
  }

  function mergeCells(b: Blob, now: number) {
    const cs = b.cells;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const d = cs[j];
        if (now < a.mergeAt || now < d.mergeAt) continue;
        const ra = massToRadius(a.mass);
        const rd = massToRadius(d.mass);
        if (dist2(a.x, a.y, d.x, d.y) < (ra * 0.6) * (ra * 0.6) || dist2(a.x, a.y, d.x, d.y) < (rd * 0.6) * (rd * 0.6)) {
          a.mass += d.mass;
          cs.splice(j, 1);
          j--;
        }
      }
    }
  }

  function splitBlob(b: Blob, aim: Vec, now: number) {
    const len = Math.hypot(aim.x, aim.y) || 1;
    const ux = aim.x / len;
    const uy = aim.y / len;
    const newCells: Cell[] = [];
    for (const c of b.cells) {
      if (c.mass < 36 || b.cells.length + newCells.length >= 8) continue;
      const half = c.mass / 2;
      c.mass = half;
      c.mergeAt = now + 9000;
      const r = massToRadius(half);
      newCells.push({
        x: c.x + ux * r,
        y: c.y + uy * r,
        vx: ux * 900,
        vy: uy * 900,
        mass: half,
        mergeAt: now + 9000,
      });
    }
    b.cells.push(...newCells);
  }

  // ---------------------------------------------------------------- render
  function render(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const cam = camRef.current;
    const zoom = zoomRef.current;

    // background
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam.x, -cam.y);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1 / zoom;
    const grid = 80;
    const x0 = Math.floor((cam.x - w / 2 / zoom) / grid) * grid;
    const x1 = cam.x + w / 2 / zoom;
    const y0 = Math.floor((cam.y - h / 2 / zoom) / grid) * grid;
    const y1 = cam.y + h / 2 / zoom;
    ctx.beginPath();
    for (let x = x0; x < x1; x += grid) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y < y1; y += grid) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();

    // world border
    ctx.strokeStyle = "rgba(255,120,180,0.4)";
    ctx.lineWidth = 6 / zoom;
    ctx.strokeRect(0, 0, WORLD, WORLD);

    // pellets
    for (const p of pelletsRef.current) {
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // blobs (sorted small->big so big draw on top)
    const drawList: { b: Blob; c: Cell }[] = [];
    for (const b of blobsRef.current) for (const c of b.cells) drawList.push({ b, c });
    drawList.sort((a, b) => a.c.mass - b.c.mass);

    for (const { b, c } of drawList) {
      const r = massToRadius(c.mass);
      ctx.beginPath();
      ctx.fillStyle = b.color;
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.08) / 1;
      ctx.strokeStyle = b.isPlayer ? "#ffffff" : "rgba(0,0,0,0.25)";
      ctx.stroke();
      // name + mass label
      if (r * zoom > 18) {
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = `${Math.max(11, r * 0.35)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(b.name, c.x, c.y);
      }
    }

    ctx.restore();
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b1020] text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* top-left back link */}
      <Link
        to="/"
        className="absolute left-4 top-16 z-20 flex items-center gap-2 rounded-full bg-black/40 px-4 py-2 text-sm backdrop-blur hover:bg-black/60"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>

      {/* HUD */}
      {state === "playing" && (
        <>
          <div className="absolute right-4 top-16 z-20 rounded-xl bg-black/40 px-4 py-3 text-right backdrop-blur">
            <div className="text-xs uppercase tracking-wide text-white/60">Mass</div>
            <div className="text-2xl font-bold tabular-nums">{mass}</div>
            <div className="mt-1 text-xs text-white/60">
              Rank #{rank} · Best {best}
            </div>
          </div>
          <button
            onClick={doSplit}
            className="absolute bottom-6 right-6 z-20 flex items-center gap-2 rounded-full bg-pink-500/90 px-6 py-3 font-semibold shadow-lg hover:bg-pink-400 active:scale-95"
          >
            <Scissors className="h-5 w-5" /> Split (Space)
          </button>
        </>
      )}

      {/* idle / dead overlays */}
      {state !== "playing" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/55 backdrop-blur-sm">
          <h1 className="mb-2 bg-gradient-to-r from-pink-400 via-fuchsia-400 to-cyan-300 bg-clip-text text-6xl font-black text-transparent">
            Agario
          </h1>
          {state === "dead" ? (
            <p className="mb-6 text-lg text-white/80">
              You got eaten! Final mass <span className="font-bold text-white">{mass}</span>
            </p>
          ) : (
            <p className="mb-6 max-w-md text-center text-white/70">
              Eat pellets and smaller blobs to grow. Dodge the big ones. Move with
              your mouse, press <span className="font-semibold text-white">Space</span> to split.
            </p>
          )}
          <div className="mb-6 flex items-center gap-2 text-sm text-white/60">
            <Trophy className="h-4 w-4 text-yellow-300" /> Best mass: {best}
          </div>
          <button
            onClick={startGame}
            className="flex items-center gap-2 rounded-full bg-gradient-to-r from-pink-500 to-cyan-400 px-8 py-4 text-lg font-bold text-black shadow-xl transition hover:scale-105 active:scale-95"
          >
            {state === "dead" ? <RotateCcw className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            {state === "dead" ? "Play again" : "Play"}
          </button>
        </div>
      )}
    </div>
  );
}
