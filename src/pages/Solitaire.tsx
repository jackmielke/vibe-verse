/**
 * SOLITAIRE: Klondike and FreeCell on one table, in five looks.
 *
 * The rules live in `src/solitaire/klondike.ts` and `freecell.ts` (pure,
 * tested in `src/test/solitaire.test.ts`); where each card sits is
 * `layout.ts`. This page owns input, motion, sound, undo and saving.
 *
 * Motion is CSS: every card is an absolutely positioned element keyed by its
 * id, so when the state moves a card React only changes its transform and the
 * browser slides it there. A card in flight is lifted above everything for the
 * length of the slide, so a card going to a foundation never passes underneath
 * the column it came from.
 *
 * Input: drag a card (or a run) anywhere, or tap it and it goes to the best
 * place (a foundation first, then a column). Tap the stock to draw. Keyboard:
 * Z undo, H hint, Space draw, N new deal.
 *
 * `window.__solitaire` is the test hook: state(), tap(pile, index),
 * move(from, index, to), draw(), undo(), hint(), nearWin(), deal(seed).
 */
import { reportArcadeScore } from "@/arcade/report";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Lightbulb, Palette, Plus, Settings, Undo2, Volume2, VolumeX,
} from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { randomSeed, type Card } from "@/solitaire/cards";
import { CardView } from "@/solitaire/CardView";
import { CardAudio } from "@/solitaire/audio";
import { FreeCell } from "@/solitaire/freecell";
import { Klondike, type KlondikeState } from "@/solitaire/klondike";
import { layoutTable, overlap, type GameKind, type Rect } from "@/solitaire/layout";
import type { BaseState, Rules } from "@/solitaire/rules";
import { SOLITAIRE_CSS } from "@/solitaire/styles";
import { THEMES, themeById, type Theme } from "@/solitaire/themes";
import { runCascade } from "@/solitaire/winFx";

const RULES: Record<GameKind, Rules<BaseState>> = {
  klondike: Klondike as unknown as Rules<BaseState>,
  freecell: FreeCell as unknown as Rules<BaseState>,
};

const LS = {
  kind: "solitaire.kind",
  theme: "solitaire.theme",
  draw: "solitaire.draw",
  muted: "solitaire.muted",
  save: (k: GameKind) => `solitaire.save.${k}`,
  stats: (k: GameKind) => `solitaire.stats.${k}`,
};

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
};

interface Stats { played: number; won: number; streak: number; bestStreak: number; bestTime: number; bestMoves: number }
const NO_STATS: Stats = { played: 0, won: 0, streak: 0, bestStreak: 0, bestTime: 0, bestMoves: 0 };
const readStats = (k: GameKind): Stats => {
  try { return { ...NO_STATS, ...JSON.parse(read(LS.stats(k)) ?? "{}") }; } catch { return { ...NO_STATS }; }
};

interface Save { state: BaseState; elapsed: number; won: boolean }
const readSave = (k: GameKind): Save | null => {
  try {
    const s = JSON.parse(read(LS.save(k)) ?? "null") as Save | null;
    if (!s?.state?.piles) return null;
    const n = Object.values(s.state.piles).reduce((a, p) => a + p.length, 0);
    return n === 52 ? s : null;
  } catch {
    return null;
  }
};

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const params = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** Which cards changed pile between two states. */
function pileMap(s: BaseState): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, p] of Object.entries(s.piles)) for (const c of p) m.set(c.id, k);
  return m;
}

interface Press {
  id: number;
  pile: string;
  index: number;
  x0: number;
  y0: number;
  started: boolean;
  canDrag: boolean;
  pointerId: number;
}

interface Drag {
  ids: number[];
  pile: string;
  index: number;
  dx: number;
  dy: number;
  targets: string[];
  hot: string | null;
}

type DealPhase = "stack" | "deal" | "done";

export default function Solitaire() {
  useWorldStamp("/solitaire", "Solitaire");
  const q = useMemo(params, []);
  const shot = q.has("shot");

  const [kind, setKind] = useState<GameKind>(() => {
    const k = q.get("game") ?? (window.location.pathname === "/freecell" ? "freecell" : read(LS.kind));
    return k === "freecell" ? "freecell" : "klondike";
  });
  const [themeId, setThemeId] = useState(() => q.get("theme") ?? read(LS.theme) ?? "felt");
  const theme = themeById(themeId);
  const [draw, setDraw] = useState<1 | 3>(() => (read(LS.draw) === "3" ? 3 : 1));
  const [muted, setMuted] = useState(() => read(LS.muted) === "1");
  const rules = RULES[kind];

  const audio = useRef<CardAudio | null>(null);
  if (!audio.current) audio.current = new CardAudio();
  audio.current.muted = muted || shot;

  // ---- game state -------------------------------------------------------
  const initial = useMemo(() => {
    const seedParam = q.get("seed");
    const save = seedParam ? null : readSave(kind);
    if (save && !save.won) return { state: save.state, elapsed: save.elapsed, fresh: false };
    const seed = seedParam ? Number(seedParam) : randomSeed();
    return { state: rules.deal(seed, { draw }), elapsed: 0, fresh: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [game, setGameState] = useState<BaseState>(initial.state);
  const gameRef = useRef(game);
  const history = useRef<BaseState[]>([]);
  const [dealPhase, setDealPhase] = useState<DealPhase>(initial.fresh && !shot ? "stack" : "done");
  const [won, setWon] = useState(false);
  const wonRef = useRef(false);
  const [showWin, setShowWin] = useState(false);
  const [stats, setStats] = useState<Stats>(() => readStats(kind));
  const [, bump] = useReducer((x: number) => x + 1, 0);

  // Timer: accumulates while the tab is visible and a game is under way.
  const elapsedBase = useRef(initial.elapsed);
  const runningSince = useRef<number | null>(null);
  const elapsed = () => elapsedBase.current + (runningSince.current ? performance.now() - runningSince.current : 0);
  const pauseTimer = () => {
    if (runningSince.current) {
      elapsedBase.current += performance.now() - runningSince.current;
      runningSince.current = null;
    }
  };
  const startTimer = () => {
    if (!runningSince.current && !wonRef.current) runningSince.current = performance.now();
  };
  useEffect(() => {
    const id = setInterval(bump, 1000);
    const vis = () => (document.hidden ? pauseTimer() : gameRef.current.moves > 0 && startTimer());
    document.addEventListener("visibilitychange", vis);
    if (initial.state.moves > 0) startTimer();
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- table size -------------------------------------------------------
  const tableRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }));
    ro.observe(el);
    setSize({ W: el.clientWidth, H: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1024 : window.innerWidth));
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 768 : window.innerHeight));
  useEffect(() => {
    const on = () => { setVw(window.innerWidth); setVh(window.innerHeight); };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const narrow = vw < 720 && vh > vw * 0.9;

  const kDraw = (game as KlondikeState).draw ?? 1;
  const layout = useMemo(
    () => layoutTable(kind, game, size.W || 360, size.H || 600, { draw: kDraw }),
    [kind, game, size.W, size.H, kDraw],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // ---- feedback state ---------------------------------------------------
  const lifted = useRef(new Map<number, number>());
  const [shakeId, setShakeId] = useState<number | null>(null);
  const [pulse, setPulse] = useState<{ pile: string; n: number } | null>(null);
  const [hint, setHint] = useState<{ ids: number[]; to: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  const say = (text: string) => setToast({ text, n: Date.now() });
  const [armedNew, setArmedNew] = useState(false);
  const [sheet, setSheet] = useState(false);

  const buzz = (ms: number) => {
    try { navigator.vibrate?.(ms); } catch { /* not supported */ }
  };

  const shake = (id: number) => {
    setShakeId(null);
    requestAnimationFrame(() => setShakeId(id));
    setTimeout(() => setShakeId((s) => (s === id ? null : s)), 360);
    audio.current?.deny();
    buzz(20);
  };

  /** Put a new state on the table with all the feedback that goes with it. */
  const commit = useCallback((next: BaseState, opts: { record?: boolean; quiet?: boolean } = {}) => {
    const prev = gameRef.current;
    if (opts.record !== false) {
      history.current.push(prev);
      if (history.current.length > 600) history.current.shift();
    }
    const before = pileMap(prev);
    const after = pileMap(next);
    const until = performance.now() + 380;
    let home: Card | null = null;
    let homePile = "";
    for (const [id, pile] of after) {
      if (before.get(id) !== pile) {
        lifted.current.set(id, until);
        if (pile[0] === "f" && before.get(id)?.[0] !== "f") {
          const p = next.piles[pile];
          home = p[p.length - 1];
          homePile = pile;
        }
      }
    }
    const flipped = Object.keys(next.piles).some((k) => {
      const a = prev.piles[k], b = next.piles[k];
      return k[0] === "t" && b.length && a.length >= b.length && a[b.length - 1] && !a[b.length - 1].up && b[b.length - 1].up;
    });
    if (!opts.quiet) {
      if (home) {
        audio.current?.home(home.rank);
        setPulse({ pile: homePile, n: Date.now() });
        buzz(12);
      } else if (flipped) {
        audio.current?.flip();
        buzz(8);
      } else {
        audio.current?.place();
        buzz(6);
      }
    }
    setTimeout(bump, 400);
    gameRef.current = next;
    setGameState(next);
    setHint(null);
    if (next.moves > 0) startTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- saving -----------------------------------------------------------
  useEffect(() => {
    if (shot) return;
    const save: Save = { state: game, elapsed: elapsed(), won: wonRef.current };
    write(LS.save(kind), JSON.stringify(save));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, kind, won]);
  useEffect(() => write(LS.theme, theme.id), [theme.id]);
  useEffect(() => write(LS.muted, muted ? "1" : "0"), [muted]);
  useEffect(() => write(LS.kind, kind), [kind]);
  useEffect(() => write(LS.draw, String(draw)), [draw]);

  // ---- dealing ----------------------------------------------------------
  const dealTimer = useRef<number[]>([]);
  const startDealAnimation = useCallback(() => {
    dealTimer.current.forEach(clearTimeout);
    setDealPhase("stack");
    audio.current?.shuffle();
    requestAnimationFrame(() => requestAnimationFrame(() => setDealPhase("deal")));
    dealTimer.current = [window.setTimeout(() => setDealPhase("done"), 52 * 30 + 700)];
  }, []);
  useEffect(() => {
    if (dealPhase === "stack" && initial.fresh) {
      requestAnimationFrame(() => requestAnimationFrame(() => setDealPhase("deal")));
      dealTimer.current = [window.setTimeout(() => setDealPhase("done"), 52 * 30 + 700)];
    }
    return () => dealTimer.current.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFor = (next: BaseState, nextKind: GameKind = kind, animate = true, elapsedMs = 0) => {
    history.current = [];
    wonRef.current = false;
    setWon(false);
    setShowWin(false);
    stopCascade.current?.();
    lifted.current.clear();
    elapsedBase.current = elapsedMs;
    runningSince.current = null;
    if (next.moves > 0 && elapsedMs > 0) startTimer();
    gameRef.current = next;
    setGameState(next);
    setHint(null);
    setStats(readStats(nextKind));
    if (animate) startDealAnimation();
    else setDealPhase("done");
  };

  const countPlayed = () => {
    // A game counts as played once a move has been made and it was not won.
    const g = gameRef.current;
    if (g.moves > 0 && !wonRef.current) {
      const s = readStats(kind);
      s.played += 1;
      s.streak = 0;
      write(LS.stats(kind), JSON.stringify(s));
    }
  };

  const newDeal = (seed = randomSeed(), d: 1 | 3 = draw) => {
    countPlayed();
    resetFor(rules.deal(seed, { draw: d }));
  };

  const restartDeal = () => {
    const g = gameRef.current;
    countPlayed();
    resetFor(rules.deal(g.seed, { draw: (g as KlondikeState).draw ?? draw }));
  };

  const switchKind = (k: GameKind) => {
    if (k === kind) return;
    if (!shot) write(LS.save(kind), JSON.stringify({ state: gameRef.current, elapsed: elapsed(), won: wonRef.current }));
    pauseTimer();
    const save = readSave(k);
    setKind(k);
    if (save && !save.won) resetFor(save.state, k, false, save.elapsed);
    else resetFor(RULES[k].deal(randomSeed(), { draw }), k, true);
  };

  const pressNew = () => {
    const g = gameRef.current;
    if (g.moves === 0 || wonRef.current || armedNew) {
      setArmedNew(false);
      newDeal();
      return;
    }
    setArmedNew(true);
    setTimeout(() => setArmedNew(false), 2600);
  };

  const undo = useCallback(() => {
    if (wonRef.current) return;
    const prev = history.current.pop();
    if (!prev) {
      say("Nothing to undo");
      return;
    }
    commit({ ...prev, moves: gameRef.current.moves + 1 }, { record: false });
  }, [commit]);

  const showHint = useCallback(() => {
    if (wonRef.current) return;
    const h = rules.hint(gameRef.current);
    if (!h) {
      say("No moves left. Undo, or deal again.");
      audio.current?.deny();
      return;
    }
    if (h === "draw") {
      const st = gameRef.current.piles.stock;
      setHint({ ids: st.length ? [st[st.length - 1].id] : [], to: "stock" });
    } else {
      const p = gameRef.current.piles[h.from];
      setHint({ ids: p.slice(h.index).map((c) => c.id), to: h.to });
    }
    audio.current?.pick();
    setTimeout(() => setHint(null), 1800);
  }, [rules]);

  const tapPile = useCallback((pile: string) => {
    if (wonRef.current) return;
    const next = rules.tapPile?.(gameRef.current, pile);
    if (next) commit(next);
  }, [rules, commit]);

  const tapCard = useCallback((pile: string, index: number, id: number) => {
    const g = gameRef.current;
    if (pile === "stock") return tapPile("stock");
    const to = rules.smartTarget(g, pile, index);
    const next = to ? rules.tryMove(g, pile, index, to) : null;
    if (next) commit(next);
    else shake(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, commit, tapPile]);

  // ---- drag -------------------------------------------------------------
  const press = useRef<Press | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const onDown = useCallback((id: number, e: React.PointerEvent) => {
    if (wonRef.current || e.button > 0) return;
    const pos = layoutRef.current.positions.get(id);
    if (!pos) return;
    e.preventDefault();
    const g = gameRef.current;
    press.current = {
      id, pile: pos.pile, index: pos.index, x0: e.clientX, y0: e.clientY, started: false,
      canDrag: rules.canPickUp(g, pos.pile, pos.index), pointerId: e.pointerId,
    };
  }, [rules]);

  const dropRect = (d: Drag): Rect => {
    const L = layoutRef.current;
    const p = L.positions.get(d.ids[0])!;
    return { x: p.x + d.dx, y: p.y + d.dy, w: L.cw, h: L.ch };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const dx = e.clientX - p.x0;
      const dy = e.clientY - p.y0;
      if (!p.started) {
        if (Math.hypot(dx, dy) < 6 || !p.canDrag) return;
        p.started = true;
        const g = gameRef.current;
        const ids = g.piles[p.pile].slice(p.index).map((c) => c.id);
        const targets = rules.pileKeys(g).filter((k) => k !== p.pile && rules.tryMove(g, p.pile, p.index, k));
        audio.current?.pick();
        setHint(null);
        const d: Drag = { ids, pile: p.pile, index: p.index, dx, dy, targets, hot: null };
        dragRef.current = d;
        setDrag(d);
        return;
      }
      const cur = dragRef.current;
      if (!cur) return;
      const d = { ...cur, dx, dy };
      const r = dropRect(d);
      let hot: string | null = null;
      let best = 0;
      for (const k of d.targets) {
        const a = overlap(r, layoutRef.current.pileRects[k]);
        if (a > best) { best = a; hot = k; }
      }
      d.hot = hot;
      dragRef.current = d;
      setDrag(d);
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;
      if (!p.started) {
        if (e.type === "pointerup") tapCard(p.pile, p.index, p.id);
        return;
      }
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const g = gameRef.current;
      if (d.hot) {
        const next = rules.tryMove(g, d.pile, d.index, d.hot);
        if (next) {
          commit(next);
          return;
        }
      }
      // Dropped somewhere it cannot go: slide home, and say no if it was a real try.
      const r = dropRect(d);
      const tried = rules.pileKeys(g).some((k) => k !== d.pile && overlap(r, layoutRef.current.pileRects[k]) > r.w * r.h * 0.3);
      for (const id of d.ids) lifted.current.set(id, performance.now() + 380);
      setTimeout(bump, 400);
      if (tried) shake(d.ids[0]);
      else audio.current?.place();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, commit, tapCard]);

  // ---- keyboard ---------------------------------------------------------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); undo(); }
      else if (k === "h") showHint();
      else if (k === " " || k === "d") { e.preventDefault(); tapPile("stock"); }
      else if (k === "n") pressNew();
      else if (k === "escape") setSheet(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // ---- auto finish & win ------------------------------------------------
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    if (won || drag || dealPhase !== "done") return;
    if (rules.isWon(game)) {
      wonRef.current = true;
      setWon(true);
      setFinishing(false);
      pauseTimer();
      const time = elapsed();
      reportArcadeScore("solitaire", Math.round(time / 1000), true);
      const s = readStats(kind);
      s.played += 1;
      s.won += 1;
      s.streak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.bestTime = s.bestTime ? Math.min(s.bestTime, time) : time;
      s.bestMoves = s.bestMoves ? Math.min(s.bestMoves, game.moves) : game.moves;
      write(LS.stats(kind), JSON.stringify(s));
      setStats(s);
      audio.current?.win();
      buzz(40);
      return;
    }
    if (!rules.canAutoFinish(game)) {
      setFinishing(false);
      return;
    }
    setFinishing(true);
    const t = setTimeout(() => {
      const next = rules.autoStep(gameRef.current);
      if (next) commit(next, { record: false });
    }, finishing ? 95 : 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, won, drag, dealPhase, rules, kind]);

  // The cascade, once the last card has landed.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopCascade = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!won) return;
    const t1 = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const L = layoutRef.current;
      const g = gameRef.current;
      const starts = ["f0", "f1", "f2", "f3"].map((f) => ({ x: L.slots[f].x, y: L.slots[f].y, cards: g.piles[f] }));
      stopCascade.current = runCascade(canvas, theme, starts, L.cw, L.ch, () => setShowWin(true));
    }, 420);
    const t2 = setTimeout(() => setShowWin(true), 4200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [won]);
  useEffect(() => () => {
    stopCascade.current?.();
    audio.current?.close();
  }, []);

  // ---- test hook --------------------------------------------------------
  useEffect(() => {
    const w = window as unknown as { __solitaire?: unknown };
    w.__solitaire = {
      state: () => gameRef.current,
      kind: () => kind,
      won: () => wonRef.current,
      layout: () => layoutRef.current,
      tap: (pile: string, index?: number) => {
        const p = gameRef.current.piles[pile];
        const i = index ?? p.length - 1;
        if (pile === "stock" || !p[i]) return tapPile(pile);
        tapCard(pile, i, p[i].id);
      },
      move: (from: string, index: number, to: string) => {
        const next = rules.tryMove(gameRef.current, from, index, to);
        if (next) commit(next);
        return !!next;
      },
      draw: () => tapPile("stock"),
      undo,
      hint: () => rules.hint(gameRef.current),
      deal: (seed: number) => newDeal(seed),
      theme: (id: string) => setThemeId(id),
      game: (k: GameKind) => switchKind(k),
      nearWin: () => {
        // Every card home except the four kings and queens, laid out in columns.
        const g = rules.deal(1, { draw: 1 });
        const piles: Record<string, Card[]> = {};
        for (const k of Object.keys(g.piles)) piles[k] = [];
        for (let s = 0; s < 4; s++) {
          for (let r = 1; r <= 11; r++) piles[`f${s}`].push({ id: s * 13 + r - 1, suit: s as Card["suit"], rank: r, up: true });
          piles[`t${s}`] = [
            { id: s * 13 + 12, suit: s as Card["suit"], rank: 13, up: true },
            { id: ((s + 1) % 4) * 13 + 11, suit: ((s + 1) % 4) as Card["suit"], rank: 12, up: true },
          ];
        }
        resetFor({ ...g, piles, moves: 90 }, kind, false, 123000);
      },
    };
    return () => { delete w.__solitaire; };
  });

  // ---- render -----------------------------------------------------------
  const now = performance.now();
  const dragIds = new Set(drag?.ids ?? []);
  const hintIds = new Set(hint?.ids ?? []);
  const dealOrder = useMemo(() => {
    const m = new Map<number, number>();
    if (kind === "klondike") {
      let n = 0;
      for (let r = 0; r < 7; r++) for (let c = r; c < 7; c++) {
        const card = game.piles[`t${c}`]?.[r];
        if (card) m.set(card.id, n++);
      }
    } else {
      for (let i = 0; i < 52; i++) {
        const card = game.piles[`t${i % 8}`]?.[Math.floor(i / 8)];
        if (card) m.set(card.id, i);
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.seed, kind, dealPhase === "stack"]);

  const cards: React.ReactNode[] = [];
  const dragIndex = (id: number) => (drag ? drag.ids.indexOf(id) : -1);
  for (const [, pile] of Object.entries(game.piles)) {
    for (const c of pile) {
      const pos = layout.positions.get(c.id);
      if (!pos) continue;
      let { x, y } = pos;
      let z = pos.z;
      let card = c;
      let delay = 0;
      let flipDelay = 0;
      let instant = false;
      const di = dragIndex(c.id);
      if (di >= 0 && drag) {
        x += drag.dx;
        y += drag.dy;
        z = 5000 + di;
      } else if ((lifted.current.get(c.id) ?? 0) > now) {
        z = 3000 + pos.z;
      }
      if (dealPhase === "stack") {
        x = layout.dealFrom.x;
        y = layout.dealFrom.y;
        card = c.up ? { ...c, up: false } : c;
        instant = true;
        z = 100 + (dealOrder.has(c.id) ? 60 - dealOrder.get(c.id)! : 0);
      } else if (dealPhase === "deal") {
        const order = dealOrder.get(c.id);
        if (order !== undefined) {
          delay = order * (kind === "klondike" ? 45 : 22);
          flipDelay = delay + 200;
          z = 3000 + pos.z;
        }
      }
      // Deep in a stacked pile nobody can see a card, and fifty stacked
      // shadows make a black halo, so only the top two are drawn.
      const stacked = !pile.length || pos.pile[0] !== "t";
      const keepVisible = pos.pile === "waste" ? kDraw + 1 : 2;
      const buried = stacked && pos.index < pile.length - keepVisible && di < 0 && dealPhase === "done" && !((lifted.current.get(c.id) ?? 0) > now);
      cards.push(
        <CardView
          key={c.id}
          card={card}
          x={x}
          y={y}
          z={z}
          dragging={di >= 0}
          lifted={z >= 3000 && di < 0 && dealPhase === "done"}
          hint={hintIds.has(c.id)}
          shake={shakeId === c.id}
          delay={delay}
          flipDelay={flipDelay}
          instant={instant}
          buried={buried}
          onDown={onDown}
        />,
      );
    }
  }

  const light = theme.id === "postcard";
  const rootStyle = {
    "--table": theme.table,
    "--ink": theme.ink,
    "--inkSoft": theme.inkSoft,
    "--inkInvert": light ? "#fffefa" : "#14121c",
    "--slot": theme.slot,
    "--face": theme.face,
    "--faceEdge": theme.faceEdge,
    "--red": theme.red,
    "--black": theme.black,
    "--court": theme.court,
    "--back": theme.back,
    "--backEdge": theme.backEdge,
    "--emblem": theme.emblem,
    "--emblemInk": theme.emblemInk,
    "--accent": theme.accent,
    "--font": theme.font,
    "--glow": theme.glow ?? "0 0 0 transparent",
    "--cw": `${layout.cw}px`,
    "--ch": `${layout.ch}px`,
  } as React.CSSProperties;

  const rootCls = [
    "sol-root",
    layout.cw < 64 && "sol-small",
    theme.emblem === "none" && "sol-no-emblem",
    light && "sol-light",
  ].filter(Boolean).join(" ");

  const slotLabel = (k: string) => {
    if (k === "stock") return game.piles.stock.length === 0 && game.piles.waste.length ? "↻" : "";
    if (k[0] === "f") return "A";
    return "";
  };

  const cycleTheme = () => {
    const i = THEMES.findIndex((t) => t.id === theme.id);
    const nextT = THEMES[(i + 1) % THEMES.length];
    setThemeId(nextT.id);
    say(`${nextT.emoji} ${nextT.name}`);
    audio.current?.flip();
  };

  const tools = (
    <>
      <button className={`sol-btn ${narrow ? "sol-tool" : ""} ${armedNew ? "is-armed" : ""}`} onClick={pressNew}>
        <Plus size={narrow ? 22 : 16} />
        {armedNew ? "Sure?" : "New"}
      </button>
      <button className={`sol-btn ${narrow ? "sol-tool" : ""}`} onClick={undo} disabled={won || history.current.length === 0}>
        <Undo2 size={narrow ? 22 : 16} /> Undo
      </button>
      <button className={`sol-btn ${narrow ? "sol-tool" : ""}`} onClick={showHint} disabled={won}>
        <Lightbulb size={narrow ? 22 : 16} /> Hint
      </button>
      <button className={`sol-btn ${narrow ? "sol-tool" : ""}`} onClick={cycleTheme}>
        <Palette size={narrow ? 22 : 16} /> Look
      </button>
      <button className={`sol-btn ${narrow ? "sol-tool" : ""}`} onClick={() => setSheet(true)} aria-label="Settings">
        <Settings size={narrow ? 22 : 16} /> {narrow ? "More" : ""}
      </button>
    </>
  );

  return (
    <div className={rootCls} style={rootStyle}>
      <style>{SOLITAIRE_CSS}</style>
      <div className="sol-bar">
        <div className="sol-seg" role="tablist">
          {(["klondike", "freecell"] as GameKind[]).map((k) => (
            <button key={k} className={kind === k ? "is-on" : ""} onClick={() => switchKind(k)}>
              {k === "klondike" ? "Solitaire" : "FreeCell"}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="sol-stats">
          <div><small>Time</small>{fmtTime(elapsed())}</div>
          <div><small>Moves</small>{game.moves}</div>
          {kind === "klondike" && vw >= 380 && <div><small>Score</small>{game.score}</div>}
        </div>
        {!narrow && <div className="sol-row" style={{ marginLeft: 10 }}>{tools}</div>}
      </div>

      <div className="sol-table" ref={tableRef}>
        {Object.entries(layout.slots).map(([k, s]) => (
          <div
            key={k}
            className={k === "stock" ? "sol-slot is-stock" : "sol-slot"}
            data-pile={k}
            style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
            onPointerUp={() => k === "stock" && !press.current && tapPile("stock")}
          >
            {slotLabel(k)}
          </div>
        ))}
        {hint && layout.pileRects[hint.to] && (
          <div
            className="sol-target is-hot"
            style={{
              transform: `translate(${layout.pileRects[hint.to].x}px, ${layout.pileRects[hint.to].y}px)`,
              width: layout.pileRects[hint.to].w,
              height: layout.pileRects[hint.to].h,
            }}
          />
        )}
        {drag?.targets.map((k) => {
          const r = layout.pileRects[k];
          return (
            <div
              key={k}
              className={drag.hot === k ? "sol-target is-hot" : "sol-target"}
              style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, height: r.h }}
            />
          );
        })}
        {cards}
        {pulse && layout.slots[pulse.pile] && (
          <div
            key={pulse.n}
            className="sol-pop"
            style={{ transform: `translate(${layout.slots[pulse.pile].x}px, ${layout.slots[pulse.pile].y}px)` }}
          >
            {Array.from({ length: 10 }, (_, i) => {
              const a = (i / 10) * Math.PI * 2;
              const r = layout.cw * (0.75 + (i % 3) * 0.15);
              return <i key={i} style={{ "--dx": `${Math.cos(a) * r}px`, "--dy": `${Math.sin(a) * r}px` } as React.CSSProperties} />;
            })}
          </div>
        )}
        {finishing && !won && <div className="sol-chip">Finishing…</div>}
        {toast && <div key={toast.n} className="sol-toast">{toast.text}</div>}
        {won && (
          <canvas
            ref={canvasRef}
            className="sol-cascade"
            onPointerDown={() => {
              stopCascade.current?.();
              setShowWin(true);
            }}
          />
        )}
        {won && showWin && (
          <WinPanel
            time={elapsed()}
            moves={game.moves}
            score={kind === "klondike" ? game.score : null}
            stats={stats}
            theme={theme}
            onAgain={() => newDeal()}
            onClose={() => setShowWin(false)}
          />
        )}
      </div>

      {narrow && <div className="sol-bottom">{tools}</div>}

      {sheet && (
        <div className="sol-modal" onPointerDown={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div className="sol-sheet" style={{ "--accent": theme.accent } as React.CSSProperties}>
            <button className="sol-btn sol-x" onClick={() => setSheet(false)} aria-label="Close">✕</button>
            <h2>Table</h2>
            <h3>Game</h3>
            <div className="sol-row">
              <button className={`sol-btn ${kind === "klondike" ? "is-on" : ""}`} onClick={() => switchKind("klondike")}>Klondike</button>
              <button className={`sol-btn ${kind === "freecell" ? "is-on" : ""}`} onClick={() => switchKind("freecell")}>FreeCell</button>
            </div>
            {kind === "klondike" && (
              <>
                <h3>Draw</h3>
                <div className="sol-row">
                  {([1, 3] as const).map((d) => (
                    <button
                      key={d}
                      className={`sol-btn ${kDraw === d ? "is-on" : ""}`}
                      onClick={() => {
                        setDraw(d);
                        if (kDraw !== d) {
                          newDeal(randomSeed(), d);
                          say(d === 1 ? "Draw 1: new deal" : "Draw 3: new deal");
                        }
                      }}
                    >
                      Draw {d}
                    </button>
                  ))}
                </div>
              </>
            )}
            <h3>Look</h3>
            <div className="sol-themes">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`sol-theme ${t.id === theme.id ? "is-on" : ""}`}
                  style={{ background: t.table }}
                  onClick={() => { setThemeId(t.id); audio.current?.flip(); }}
                >
                  <div className="mini" style={{ left: 12, background: t.back, border: `2px solid ${t.backEdge}` }} />
                  <div className="mini mini-face" style={{ left: 36, background: t.face, color: t.red, border: `1px solid ${t.faceEdge}` }}>A</div>
                  <div className="mini mini-face" style={{ left: 60, background: t.face, color: t.black, border: `1px solid ${t.faceEdge}` }}>♠</div>
                  <span className="label">{t.emoji} {t.name}</span>
                </button>
              ))}
            </div>
            <h3>Sound</h3>
            <div className="sol-row">
              <button className="sol-btn" onClick={() => setMuted((m) => !m)}>
                {muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {muted ? "Off" : "On"}
              </button>
            </div>
            <h3>This deal</h3>
            <div className="sol-row">
              <button className="sol-btn" onClick={() => { restartDeal(); setSheet(false); }}>Start it over</button>
              <button className="sol-btn" onClick={() => { newDeal(); setSheet(false); }}>New deal</button>
            </div>
            <h3>{kind === "klondike" ? "Klondike" : "FreeCell"} record</h3>
            <div className="sol-grid3">
              <div><small>Won</small><b>{stats.won} / {stats.played}</b></div>
              <div><small>Best time</small><b>{stats.bestTime ? fmtTime(stats.bestTime) : "–"}</b></div>
              <div><small>Best streak</small><b>{stats.bestStreak}</b></div>
            </div>
            <p style={{ fontSize: 12.5, opacity: 0.6, marginTop: 16, lineHeight: 1.5 }}>
              Drag cards, or tap one and it jumps to the best spot. Tap the deck to draw.
              Keys: Z undo, H hint, Space draw, N new deal.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function WinPanel({
  time, moves, score, stats, theme, onAgain, onClose,
}: {
  time: number; moves: number; score: number | null; stats: Stats; theme: Theme;
  onAgain: () => void; onClose: () => void;
}) {
  const best = stats.bestTime && Math.abs(stats.bestTime - time) < 1;
  return (
    <div className="sol-modal" style={{ background: "rgba(0,0,0,0.25)" }}>
      <div className="sol-sheet" style={{ textAlign: "center", "--accent": theme.accent } as React.CSSProperties}>
        <div style={{ fontSize: 44, lineHeight: 1 }}>🎉</div>
        <h2 style={{ marginTop: 8 }}>Solved!</h2>
        {best && <div style={{ color: theme.accent, fontWeight: 900, fontSize: 13, letterSpacing: "0.1em" }}>NEW BEST TIME</div>}
        <div className="sol-grid3" style={{ marginTop: 16 }}>
          <div><small>Time</small><div className="sol-big">{fmtTime(time)}</div></div>
          <div><small>Moves</small><div className="sol-big">{moves}</div></div>
          <div><small>{score === null ? "Streak" : "Score"}</small><div className="sol-big">{score ?? stats.streak}</div></div>
        </div>
        <p style={{ opacity: 0.65, fontSize: 13, margin: "14px 0 0" }}>
          {stats.won} won of {stats.played} played · streak {stats.streak}
        </p>
        <div className="sol-row" style={{ justifyContent: "center", marginTop: 18 }}>
          <button className="sol-btn" onClick={onClose}>Admire it</button>
          <button className="sol-btn is-primary" onClick={onAgain}>Deal again</button>
        </div>
      </div>
    </div>
  );
}
