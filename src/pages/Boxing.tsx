/**
 * /boxing: Haymaker, a boxing game where the opponent stands in your room.
 *
 * Prop a phone or laptop up, step back, and the front camera watches you:
 * real punches land, leaning away slips, fists by your face is a guard. The
 * opponent is drawn on top of the mirrored camera picture, and your gloves
 * are drawn on your own fists. Without a camera (or without permission) the
 * same fight plays in a ring with thumbs or keys.
 *
 * The fight is `src/boxing/fight.ts`, the body reading is `src/boxing/pose.ts`,
 * the drawing is `src/boxing/scene.ts`. This page is the menus, the HUD and
 * the wiring.
 *
 * `window.__boxing` is the test rig: `feed(landmarks)` reads a body that is
 * not in front of the camera, `settle(seconds, input)` steps the fight
 * without a frame rate, `snapshot()` is a JPEG of camera plus canvas.
 */
import { reportArcadeScore } from "@/arcade/report";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bout, PLAYER_HP, ROSTER, ROUNDS, type BoutEvent, type Opponent, type PlayerInput } from "@/boxing/fight";
import type { BodyRead, Hand, Landmark, PunchKind } from "@/boxing/pose";
import { BoxingScene } from "@/boxing/scene";
import { RingAudio } from "@/boxing/audio";
import { MotionTracker, PoseTracker, startCamera, stopCamera, type Tracker } from "@/boxing/tracker";

type Screen = "splash" | "setup" | "fight" | "over";
type Mode = "camera" | "thumbs";

const FONT = "'Archivo Black', 'Arial Black', Impact, system-ui, sans-serif";
const BODY = "system-ui, -apple-system, Segoe UI, sans-serif";
const GOLD = "#ffc23a";

const POSE_LINKS: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];

function readBeaten(): number {
  try { return Math.max(0, Math.min(ROSTER.length, Number(localStorage.getItem("boxing.beaten") ?? 0) || 0)); } catch { return 0; }
}
function writeBeaten(n: number): void {
  try { localStorage.setItem("boxing.beaten", String(n)); } catch { /* private window */ }
}

interface Callout { id: number; text: string; color: string; big?: boolean }

interface Hud {
  you: number;
  opp: number;
  oppMax: number;
  round: number;
  clock: number;
  stage: Bout["stage"];
  phase: string;
  side: "L" | "R";
  combo: number;
  restLeft: number;
}

/** Video-normalised point to viewport-normalised, for a video shown with object-fit: cover. */
function coverMap(video: HTMLVideoElement, W: number, H: number) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  return (x: number, y: number) => ({ x: (ox + x * dw) / W, y: (oy + y * dh) / H });
}

export default function Boxing() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [screen, setScreen] = useState<Screen>("splash");
  const [mode, setMode] = useState<Mode>("camera");
  const [beaten, setBeaten] = useState(readBeaten);
  const [pick, setPick] = useState(() => {
    const q = params.get("vs");
    const i = ROSTER.findIndex((o) => o.id === q);
    return i >= 0 ? i : Math.min(readBeaten(), ROSTER.length - 1);
  });
  const [camNote, setCamNote] = useState("");
  const [trackerKind, setTrackerKind] = useState<"pose" | "motion" | "loading" | null>(null);
  const [bodySeen, setBodySeen] = useState(false);
  const [guardHold, setGuardHold] = useState(0);
  const [hud, setHud] = useState<Hud | null>(null);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [hurtFlash, setHurtFlash] = useState(0);
  const [muted, setMuted] = useState(false);
  const [result, setResult] = useState<{ win: boolean; how: string; stats: Bout["stats"]; opp: Opponent } | null>(null);
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BoxingScene | null>(null);
  const boutRef = useRef<Bout | null>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef(new RingAudio());
  const bodyRef = useRef<BodyRead | null>(null);
  const screenRef = useRef<Screen>("splash");
  screenRef.current = screen;
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const beatenRef = useRef(beaten);
  beatenRef.current = beaten;
  // thumbs and keys
  const manual = useRef({ lean: 0, guard: false, punches: [] as { hand: Hand; kind: PunchKind; power: number }[] });
  const calloutId = useRef(0);
  const guardSince = useRef<number | null>(null);
  const rafRef = useRef(0);
  const frozen = useRef(false);

  const say = useCallback((text: string, color = "#fff", big = false) => {
    const id = ++calloutId.current;
    setCallouts((c) => [...c.slice(-3), { id, text, color, big }]);
    setTimeout(() => setCallouts((c) => c.filter((x) => x.id !== id)), big ? 1600 : 900);
  }, []);

  const toBody = useCallback((b: BodyRead | null): BodyRead | null => {
    const v = videoRef.current, c = canvasRef.current;
    if (!b || !v || !c) return b;
    const m = coverMap(v, c.clientWidth, c.clientHeight);
    const map = (p: { sx: number; sy: number }) => { const q = m(p.sx, p.sy); return { sx: q.x, sy: q.y }; };
    return {
      ...b,
      fists: { L: { ...b.fists.L, ...map(b.fists.L) }, R: { ...b.fists.R, ...map(b.fists.R) } },
      head: map(b.head),
    };
  }, []);

  /* ---------------- the scene: built per mode, torn down on unmount ---------------- */
  const buildScene = useCallback((ar: boolean) => {
    sceneRef.current?.dispose();
    // A canvas keeps the first context it was given, alpha and all, and a
    // disposed renderer leaves it lost. So every scene gets a fresh canvas.
    const host = hostRef.current!;
    canvasRef.current?.remove();
    const c = document.createElement("canvas");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    host.appendChild(c);
    canvasRef.current = c;
    const sc = new BoxingScene(c, ar);
    sc.resize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight);
    sc.setOpponent(ROSTER[pickRef.current]);
    sc.showGloves = screenRef.current !== "splash";
    sceneRef.current = sc;
    return sc;
  }, []);

  const handleEvents = useCallback((events: BoutEvent[]) => {
    const a = audioRef.current;
    const sc = sceneRef.current;
    const bout = boutRef.current;
    for (const e of events) {
      switch (e.type) {
        case "hit":
          a.hit(e.damage / 20, e.counter);
          sc?.burst(e.counter);
          if (e.counter) say(e.combo > 2 ? `COUNTER x${e.combo}` : "COUNTER!", GOLD, true);
          else if (e.kind === "uppercut") say("UPPERCUT!", "#7cf3ff");
          else if (e.combo >= 3) say(`${e.combo} HIT COMBO`, "#fff");
          break;
        case "blocked": a.blocked(); say("BLOCKED", "#aab"); break;
        case "windup": a.whoosh(); break;
        case "dodged": a.dodged(); say("SLIPPED! HIT BACK!", GOLD, true); break;
        case "covered": a.covered(); say("COVERED", "#9cf"); break;
        case "hurt": a.hurt(); sc?.jolt(); setHurtFlash((n) => n + 1); if (navigator.vibrate) navigator.vibrate(60); break;
        case "feint": say("FEINT", "#f9a"); break;
        case "bell": a.bell(); say(`ROUND ${e.round}`, "#fff", true); break;
        case "round-end": a.bell(); say("BELL!", "#fff", true); break;
        case "knockdown": a.roar(1); break;
        case "ko":
        case "decision": {
          if (!bout) break;
          const win = e.winner === "player";
          a.roar(win ? 1 : 0.4);
          a.bell();
          say(e.type === "ko" ? (win ? "K.O.!" : "DOWN YOU GO") : win ? "YOU WIN ON POINTS" : "THEY TAKE IT ON POINTS", win ? GOLD : "#ff6b6b", true);
          if (win && pickRef.current + 1 > beatenRef.current) {
            const n = pickRef.current + 1;
            writeBeaten(n);
            setBeaten(n);
          }
          const how = e.type === "ko" ? "knockout" : "decision";
          const stats = { ...bout.stats };
          // Points for the Vibe Arcade: punches landed, more for a win, more
          // again for a knockout and for a tougher opponent.
          reportArcadeScore("boxing", stats.landed * 5 + (win ? 150 * (pickRef.current + 1) + (e.type === "ko" ? 100 : 0) : 0), win);
          const opp = bout.opponent;
          setTimeout(() => {
            setResult({ win, how, stats, opp });
            setScreen("over");
          }, 2400);
          break;
        }
      }
    }
  }, [say]);

  /* ---------------- the loop ---------------- */
  useEffect(() => {
    let last = performance.now();
    let hudT = 0;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (frozen.current) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const sc = sceneRef.current;
      const tr = trackerRef.current;
      const scr = screenRef.current;

      let body = bodyRef.current;
      if (tr) {
        const b = tr.update(now);
        if (b) { body = b; bodyRef.current = b; }
      }
      const shown = toBody(body);

      // the skeleton, while lining up
      const ov = overlayRef.current;
      if (ov) {
        const ctx = ov.getContext("2d");
        if (ctx) {
          if (ov.width !== ov.clientWidth) { ov.width = ov.clientWidth; ov.height = ov.clientHeight; }
          ctx.clearRect(0, 0, ov.width, ov.height);
          const lm = tr?.landmarks();
          const v = videoRef.current;
          if (scr === "setup" && lm && v) {
            const m = coverMap(v, ov.width, ov.height);
            ctx.lineWidth = 6;
            ctx.lineCap = "round";
            ctx.strokeStyle = body?.guard ? GOLD : "rgba(124,243,255,0.9)";
            for (const [a, b] of POSE_LINKS) {
              const p = m(1 - lm[a].x, lm[a].y), q = m(1 - lm[b].x, lm[b].y);
              ctx.beginPath();
              ctx.moveTo(p.x * ov.width, p.y * ov.height);
              ctx.lineTo(q.x * ov.width, q.y * ov.height);
              ctx.stroke();
            }
            ctx.fillStyle = "#fff";
            for (const i of [0, 15, 16]) {
              const p = m(1 - lm[i].x, lm[i].y);
              ctx.beginPath();
              ctx.arc(p.x * ov.width, p.y * ov.height, i === 0 ? 10 : 14, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      const man = manual.current;
      const camPunches = scr === "fight" && body && tr ? body.punches : [];
      if (tr && body) bodyRef.current = { ...body, punches: [] };
      const input: PlayerInput = {
        guard: man.guard || (!!body?.present && body.guard),
        lean: man.lean !== 0 ? man.lean : body?.present ? body.lean : 0,
        punches: [...camPunches.map((p) => ({ hand: p.hand, kind: p.kind, power: p.power })), ...man.punches],
      };
      man.punches = [];
      for (const p of input.punches) sc?.throwGlove(p.hand);

      // camera mode: guard up for a moment to start
      if (scr === "setup") {
        const seen = !!body?.present;
        setBodySeen((s) => (s === seen ? s : seen));
        if (body?.guard) {
          if (guardSince.current === null) guardSince.current = now;
          const held = (now - guardSince.current) / 1000;
          setGuardHold(Math.min(1, held / 1.2));
          if (held > 1.2) { guardSince.current = null; beginFight(); }
        } else if (guardSince.current !== null) {
          guardSince.current = null;
          setGuardHold(0);
        }
      }

      const bout = boutRef.current;
      if (sc) sc.showOpponent = scr !== "setup";
      if (bout && scr === "fight") handleEvents(bout.step(dt, input));
      sc?.frame(dt, scr === "fight" || scr === "over" ? bout : bout ?? null, shown, input.guard, input.lean);

      hudT += dt;
      if (bout && hudT > 0.08) {
        hudT = 0;
        setHud({
          you: bout.playerHp, opp: bout.opp.hp, oppMax: bout.opponent.hp, round: bout.round, clock: bout.clock,
          stage: bout.stage, phase: bout.opp.phase, side: bout.opp.side, combo: bout.combo,
          restLeft: Math.max(0, 6 - bout.stageT),
        });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // beginFight is stable through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleEvents, toBody]);

  /* ---------------- resize + teardown ---------------- */
  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (c && sceneRef.current) sceneRef.current.resize(c.clientWidth, c.clientHeight);
    };
    window.addEventListener("resize", onResize);
    // a ring to look at behind the splash
    const sc = buildScene(false);
    boutRef.current = new Bout(ROSTER[pickRef.current], { seed: 7 });
    sc.setOpponent(ROSTER[pickRef.current]);
    const audio = audioRef.current;
    return () => {
      window.removeEventListener("resize", onResize);
      trackerRef.current?.dispose();
      trackerRef.current = null;
      stopCamera(streamRef.current);
      sceneRef.current?.dispose();
      sceneRef.current = null;
      audio.dispose();
    };
  }, [buildScene]);

  // the splash shows whoever is picked
  useEffect(() => {
    if (screen !== "splash") return;
    sceneRef.current?.setOpponent(ROSTER[pick]);
    boutRef.current = new Bout(ROSTER[pick], { seed: 7 });
  }, [pick, screen]);

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const m = manual.current;
      const k = e.key.toLowerCase();
      const punch = (hand: Hand, kind: PunchKind) => m.punches.push({ hand, kind, power: 0.75 });
      if (k === "f") punch("L", "jab");
      else if (k === "j") punch("R", "jab");
      else if (k === "d") punch("L", "hook");
      else if (k === "k") punch("R", "hook");
      else if (k === "r") punch("L", "uppercut");
      else if (k === "u") punch("R", "uppercut");
      else if (k === "arrowleft" || k === "a") m.lean = -1;
      else if (k === "arrowright" || k === "l") m.lean = 1;
      else if (k === " " || k === "arrowdown" || k === "s") { m.guard = true; e.preventDefault(); }
      else return;
      audioRef.current.unlock();
    };
    const up = (e: KeyboardEvent) => {
      const m = manual.current;
      const k = e.key.toLowerCase();
      if ((k === "arrowleft" || k === "a") && m.lean < 0) m.lean = 0;
      if ((k === "arrowright" || k === "l") && m.lean > 0) m.lean = 0;
      if (k === " " || k === "arrowdown" || k === "s") m.guard = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  /* ---------------- starting ---------------- */
  const beginFight = useCallback(() => {
    const opp = ROSTER[pickRef.current];
    const sc = sceneRef.current;
    sc?.setOpponent(opp);
    const pace = 1 + Math.max(0, beatenRef.current - ROSTER.length) * 0.1;
    boutRef.current = new Bout(opp, { pace });
    trackerRef.current?.recentre();
    setResult(null);
    if (sc) sc.showGloves = true;
    setScreen("fight");
    say(opp.name.toUpperCase(), GOLD, true);
  }, [say]);

  const enterCamera = useCallback(async () => {
    audioRef.current.unlock();
    setMode("camera");
    setCamNote("");
    setScreen("setup");
    setTrackerKind("loading");
    const v = videoRef.current!;
    try {
      if (!streamRef.current) streamRef.current = await startCamera(v);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setCamNote(name === "NotAllowedError"
        ? "The camera was not allowed, so this fight is in the ring. You can allow it in your browser's site settings and try again."
        : "No camera here, so this fight is in the ring.");
      setTrackerKind(null);
      setMode("thumbs");
      buildScene(false);
      beginFight();
      return;
    }
    buildScene(true);
    if (!trackerRef.current) {
      try {
        trackerRef.current = await PoseTracker.create(v);
        setTrackerKind("pose");
      } catch {
        trackerRef.current = new MotionTracker(v);
        setTrackerKind("motion");
        setCamNote("Body tracking would not load on this browser, so it is watching for movement instead: punch at the screen, and use the buttons to slip and guard.");
      }
    } else {
      setTrackerKind(trackerRef.current.kind);
    }
  }, [beginFight, buildScene]);

  const enterThumbs = useCallback(() => {
    audioRef.current.unlock();
    setMode("thumbs");
    trackerRef.current?.dispose();
    trackerRef.current = null;
    stopCamera(streamRef.current);
    streamRef.current = null;
    bodyRef.current = null;
    setTrackerKind(null);
    buildScene(false);
    beginFight();
  }, [beginFight, buildScene]);

  const backToSplash = useCallback(() => {
    screenRef.current = "splash";
    setScreen("splash");
    setResult(null);
    trackerRef.current?.dispose();
    trackerRef.current = null;
    stopCamera(streamRef.current);
    streamRef.current = null;
    bodyRef.current = null;
    setTrackerKind(null);
    buildScene(false);
  }, [buildScene]);

  /* ---------------- the test rig ---------------- */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__boxing = {
      bout: () => boutRef.current,
      hud: () => ({ screen: screenRef.current, mode: modeRef.current, tracker: trackerRef.current?.kind ?? null, body: bodyRef.current }),
      start: (m: Mode = "thumbs") => (m === "camera" ? enterCamera() : enterThumbs()),
      fight: () => beginFight(),
      pick: (i: number) => setPick(i),
      feed: (lm: Landmark[] | null, t = performance.now()) => {
        const tr = trackerRef.current;
        if (tr && tr instanceof PoseTracker) { const b = tr.feed(lm, t); bodyRef.current = b; return b; }
        return null;
      },
      punch: (hand: Hand = "L", kind: PunchKind = "jab", power = 0.8) => manual.current.punches.push({ hand, kind, power }),
      hold: (lean: number, guard = false) => { manual.current.lean = lean; manual.current.guard = guard; },
      freeze: (on: boolean) => { frozen.current = on; },
      /** Step the fight and the scene by `seconds` of fixed slices, then render once. */
      settle: (seconds: number, input: Partial<PlayerInput> = {}) => {
        const b = boutRef.current, sc = sceneRef.current;
        const steps = Math.ceil(seconds / (1 / 30));
        for (let i = 0; i < steps; i++) {
          const inp: PlayerInput = { guard: input.guard ?? false, lean: input.lean ?? 0, punches: i === 0 ? input.punches ?? [] : [] };
          if (b && screenRef.current === "fight") handleEvents(b.step(1 / 30, inp));
          sc?.frame(1 / 30, b, toBody(bodyRef.current), inp.guard, inp.lean);
        }
        return b ? { phase: b.opp.phase, you: b.playerHp, opp: b.opp.hp, stage: b.stage, round: b.round } : null;
      },
      snapshot: () => sceneRef.current?.snapshot(modeRef.current === "camera" ? videoRef.current : null) ?? null,
    };
    return () => { delete w.__boxing; };
  }, [beginFight, enterCamera, enterThumbs, handleEvents, toBody]);

  /* ---------------- touch: tap the top half to punch ---------------- */
  const touchStart = useRef<Map<number, { x: number; y: number; t: number }>>(new Map());
  const onPointerDown = (e: React.PointerEvent) => {
    if (screen !== "fight") return;
    audioRef.current.unlock();
    touchStart.current.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touchStart.current.get(e.pointerId);
    touchStart.current.delete(e.pointerId);
    if (!s || screen !== "fight") return;
    const hand: Hand = s.x < window.innerWidth / 2 ? "L" : "R";
    const dy = e.clientY - s.y, dx = e.clientX - s.x;
    let kind: PunchKind = "jab";
    if (dy < -40 && Math.abs(dy) > Math.abs(dx)) kind = "uppercut";
    else if (Math.abs(dx) > 50) kind = "hook";
    manual.current.punches.push({ hand, kind, power: 0.7 });
  };

  const holdBtn = (label: string, on: () => void, off: () => void, wide = false) => (
    <button
      onPointerDown={(e) => { e.stopPropagation(); audioRef.current.unlock(); on(); }}
      onPointerUp={(e) => { e.stopPropagation(); off(); }}
      onPointerLeave={off}
      onPointerCancel={off}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        flex: wide ? 1.3 : 1, padding: "16px 8px", borderRadius: 16, border: "2px solid rgba(255,255,255,0.25)",
        background: "rgba(10,10,20,0.55)", color: "#fff", fontFamily: FONT, fontSize: 15, letterSpacing: 1,
        touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
      }}
    >{label}</button>
  );

  const opp = ROSTER[pick];
  const ar = mode === "camera" && screen !== "splash";
  const fighting = screen === "fight";
  const warning = hud && fighting && hud.phase === "windup";

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "#07070d", overflow: "hidden", color: "#fff", fontFamily: BODY, touchAction: "none", userSelect: "none" }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)", opacity: ar ? 1 : 0, background: "#000" }}
      />
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <canvas ref={overlayRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />

      {/* you got hit */}
      <div key={hurtFlash} style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        boxShadow: "inset 0 0 160px 40px rgba(255,30,30,0.85)",
        animation: hurtFlash ? "hm-hurt 0.5s ease-out forwards" : undefined, opacity: 0,
      }} />

      {/* incoming: which side to slip */}
      {warning && (
        <div style={{
          position: "absolute", top: "38%", [hud!.side === "L" ? "left" : "right"]: 10, pointerEvents: "none",
          fontFamily: FONT, fontSize: 18, color: "#ff5b4a", textShadow: "0 2px 10px #000",
          display: "flex", flexDirection: "column", alignItems: "center", animation: "hm-pulse 0.3s infinite alternate",
        }}>
          <div style={{ fontSize: 46 }}>{hud!.side === "L" ? "◀" : "▶"}</div>
          <div>INCOMING</div>
          <div style={{ fontSize: 13, color: "#fff", marginTop: 4 }}>{hud!.side === "L" ? "lean right" : "lean left"} or guard</div>
        </div>
      )}

      {/* HUD */}
      {hud && (fighting || screen === "over") && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "calc(env(safe-area-inset-top) + 62px) 12px 0", pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Bar label="YOU" value={hud.you} max={PLAYER_HP} color="#ffc23a" />
            <div style={{ textAlign: "center", minWidth: 64, fontFamily: FONT }}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>ROUND {hud.round}/{ROUNDS}</div>
              <div style={{ fontSize: 24, lineHeight: 1 }}>{hud.stage === "rest" ? `${Math.ceil(hud.restLeft)}` : Math.ceil(hud.clock)}</div>
            </div>
            <Bar label={opp.name.toUpperCase()} value={hud.opp} max={hud.oppMax} color={"#" + opp.colors.glove.toString(16).padStart(6, "0")} right />
          </div>
          {hud.stage === "rest" && (
            <div style={{ textAlign: "center", marginTop: 30, fontFamily: FONT, fontSize: 22, textShadow: "0 2px 8px #000" }}>
              CATCH YOUR BREATH
              <div style={{ fontFamily: BODY, fontSize: 14, marginTop: 6, opacity: 0.85 }}>Round {hud.round + 1} in {Math.ceil(hud.restLeft)}</div>
            </div>
          )}
        </div>
      )}

      {/* callouts */}
      <div style={{ position: "absolute", top: "22%", left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, pointerEvents: "none" }}>
        {callouts.map((c) => (
          <div key={c.id} style={{
            fontFamily: FONT, fontSize: c.big ? "clamp(30px, 8vw, 64px)" : "clamp(18px, 4.5vw, 30px)", color: c.color,
            textShadow: "0 3px 0 #000, 0 0 18px rgba(0,0,0,0.7)", animation: "hm-pop 0.9s ease-out forwards", letterSpacing: 1,
          }}>{c.text}</div>
        ))}
      </div>

      {/* thumbs: slip and guard buttons; also shown in camera mode as a backup */}
      {fighting && (mode === "thumbs" || trackerKind === "motion" || phone) && (
        <div style={{ position: "absolute", left: 10, right: 10, bottom: "calc(env(safe-area-inset-bottom) + 10px)", display: "flex", gap: 8 }}>
          {holdBtn("◀ SLIP", () => { manual.current.lean = -1; }, () => { if (manual.current.lean < 0) manual.current.lean = 0; })}
          {holdBtn("🛡 GUARD", () => { manual.current.guard = true; }, () => { manual.current.guard = false; }, true)}
          {holdBtn("SLIP ▶", () => { manual.current.lean = 1; }, () => { if (manual.current.lean > 0) manual.current.lean = 0; })}
        </div>
      )}
      {fighting && hud && hud.round === 1 && hud.clock > 50 && (
        <div style={{ position: "absolute", bottom: mode === "thumbs" || phone ? "calc(env(safe-area-inset-bottom) + 84px)" : 18, left: 0, right: 0, textAlign: "center", fontSize: 13, opacity: 0.85, pointerEvents: "none", textShadow: "0 1px 4px #000", padding: "0 16px" }}>
          {mode === "camera" && trackerKind === "pose"
            ? "Throw real punches. Lean away from a glowing glove to slip it, or put both fists by your face."
            : phone
              ? "Tap left or right to punch. Swipe up for an uppercut, sideways for a hook."
              : "F and J jab, D and K hook, R and U uppercut. Arrows slip, Space guards."}
        </div>
      )}

      {fighting && (
        <div style={{ position: "absolute", top: "calc(env(safe-area-inset-top) + 12px)", right: 10, display: "flex", gap: 6 }}>
          <IconBtn onClick={() => { const m = !muted; setMuted(m); audioRef.current.setMuted(m); }}>{muted ? "🔇" : "🔊"}</IconBtn>
          <IconBtn onClick={backToSplash}>✕</IconBtn>
        </div>
      )}

      {/* ---------------- splash ---------------- */}
      {screen === "splash" && (
        <div style={{ position: "absolute", inset: 0, overflowY: "auto", background: "linear-gradient(180deg, rgba(7,7,13,0.55) 0%, rgba(7,7,13,0.2) 35%, rgba(7,7,13,0.92) 70%)" }}>
          <div style={{ maxWidth: 520, margin: "0 auto", padding: "calc(env(safe-area-inset-top) + 18px) 16px 28px", minHeight: "100%", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              {/* the app's own HOME pill sits in this corner */}
              <span />
              <span style={{ fontSize: 12, opacity: 0.7 }}>{beaten}/{ROSTER.length} beaten</span>
            </div>
            <h1 style={{ fontFamily: FONT, fontSize: "clamp(44px, 13vw, 76px)", lineHeight: 0.9, margin: "14px 0 4px", color: GOLD, textShadow: "0 4px 0 #6a3b00" }}>HAYMAKER</h1>
            <div style={{ fontSize: 15, opacity: 0.9, maxWidth: 380 }}>Boxing in your living room. Prop your phone up, step back, and throw real punches.</div>
            <div style={{ flex: 1, minHeight: "30vh" }} />

            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6 }}>
              {ROSTER.map((o, i) => {
                const locked = i > beaten;
                return (
                  <button key={o.id} disabled={locked} onClick={() => setPick(i)} style={{
                    flex: "0 0 auto", padding: "8px 12px", borderRadius: 12, fontSize: 13, fontWeight: 700,
                    border: `2px solid ${i === pick ? GOLD : "rgba(255,255,255,0.2)"}`,
                    background: i === pick ? "rgba(255,194,58,0.15)" : "rgba(255,255,255,0.06)", color: locked ? "rgba(255,255,255,0.35)" : "#fff",
                  }}>{locked ? "🔒 " : i < beaten ? "✓ " : ""}{o.name}</button>
                );
              })}
            </div>
            <div style={{ margin: "10px 0 16px" }}>
              <div style={{ fontFamily: FONT, fontSize: 20 }}>{opp.name} <span style={{ fontFamily: BODY, fontSize: 13, opacity: 0.7, fontWeight: 400 }}>{opp.nick}</span></div>
              <div style={{ fontSize: 14, opacity: 0.85, marginTop: 4 }}>{opp.intro}</div>
            </div>

            <button onClick={() => void enterCamera()} style={bigBtn(GOLD, "#1a1000")}>📷 Fight in my room</button>
            <button onClick={enterThumbs} style={{ ...bigBtn("rgba(255,255,255,0.1)", "#fff"), marginTop: 10, border: "2px solid rgba(255,255,255,0.25)" }}>
              {phone ? "👆 Play with thumbs" : "⌨️ Play with the keyboard"}
            </button>
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12, lineHeight: 1.45 }}>
              The camera picture never leaves your device. It is read in this page to find your head and hands, and nothing is recorded or sent anywhere.
            </div>
          </div>
        </div>
      )}

      {/* ---------------- lining up ---------------- */}
      {screen === "setup" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "16px 16px calc(env(safe-area-inset-bottom) + 18px)", background: "linear-gradient(0deg, rgba(0,0,0,0.85), rgba(0,0,0,0))" }}>
          <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
            {trackerKind === "loading" && <div style={{ fontFamily: FONT, fontSize: 20 }}>Warming up the camera…</div>}
            {trackerKind === "pose" && (
              <>
                <div style={{ fontFamily: FONT, fontSize: 22 }}>{bodySeen ? "GUARD UP TO START" : "STEP BACK"}</div>
                <div style={{ fontSize: 14, opacity: 0.9, marginTop: 6 }}>
                  {bodySeen
                    ? "Both fists up by your face, and hold them there."
                    : "Prop the phone up at chest height and step back until your head, shoulders and both hands are in the picture. About two big steps."}
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.15)", marginTop: 12, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${guardHold * 100}%`, background: GOLD, transition: "width 0.1s" }} />
                </div>
              </>
            )}
            {camNote && <div style={{ fontSize: 13, opacity: 0.9, marginTop: 8 }}>{camNote}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={backToSplash} style={{ ...bigBtn("rgba(255,255,255,0.1)", "#fff"), flex: 1, fontSize: 15 }}>Back</button>
              <button onClick={beginFight} disabled={trackerKind === "loading"} style={{ ...bigBtn(GOLD, "#1a1000"), flex: 2, fontSize: 15, opacity: trackerKind === "loading" ? 0.5 : 1 }}>Start now</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- end card ---------------- */}
      {screen === "over" && result && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(5,5,10,0.72)", padding: 16 }}>
          <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
            <div style={{ fontFamily: FONT, fontSize: "clamp(40px, 12vw, 64px)", color: result.win ? GOLD : "#ff6b6b", lineHeight: 1 }}>{result.win ? "YOU WIN" : "YOU LOSE"}</div>
            <div style={{ opacity: 0.85, marginTop: 6 }}>{result.win ? `You beat ${result.opp.name} by ${result.how}.` : `${result.opp.name} wins by ${result.how}.`}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, margin: "18px 0" }}>
              <Stat n={result.stats.landed} label="landed" />
              <Stat n={result.stats.counters} label="counters" />
              <Stat n={result.stats.best} label="best combo" />
              <Stat n={result.stats.dodged} label="slipped" />
              <Stat n={result.stats.blocked} label="covered" />
              <Stat n={result.stats.thrown ? Math.round((result.stats.landed / result.stats.thrown) * 100) : 0} label="% on target" />
            </div>
            {result.win && pick + 1 < ROSTER.length && (
              <button onClick={() => { setPick(pick + 1); pickRef.current = pick + 1; mode === "camera" ? void enterCamera() : enterThumbs(); }} style={bigBtn(GOLD, "#1a1000")}>
                Next: {ROSTER[pick + 1].name} →
              </button>
            )}
            {result.win && pick + 1 >= ROSTER.length && <div style={{ fontFamily: FONT, color: GOLD, fontSize: 20, marginBottom: 10 }}>🏆 CHAMPION OF THE ROOM</div>}
            <button onClick={() => (mode === "camera" ? void enterCamera() : enterThumbs())} style={{ ...bigBtn("rgba(255,255,255,0.1)", "#fff"), marginTop: 10, border: "2px solid rgba(255,255,255,0.25)" }}>
              {result.win ? "Fight again" : "Rematch"}
            </button>
            <button onClick={backToSplash} style={{ background: "none", border: "none", color: "#fff", opacity: 0.75, marginTop: 14, fontSize: 14 }}>Pick another opponent</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes hm-hurt { 0% { opacity: 1 } 100% { opacity: 0 } }
        @keyframes hm-pop { 0% { transform: scale(0.6); opacity: 0 } 15% { transform: scale(1.12); opacity: 1 } 30% { transform: scale(1) } 80% { opacity: 1 } 100% { opacity: 0; transform: translateY(-14px) } }
        @keyframes hm-pulse { from { opacity: 0.55 } to { opacity: 1 } }
      `}</style>
    </div>
  );
}

function bigBtn(bg: string, fg: string): React.CSSProperties {
  return { width: "100%", padding: "16px 18px", borderRadius: 16, border: "none", background: bg, color: fg, fontFamily: FONT, fontSize: 18, letterSpacing: 0.5, cursor: "pointer" };
}

function IconBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{ width: 40, height: 40, borderRadius: 12, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.45)", color: "#fff", fontSize: 18 }}
    >{children}</button>
  );
}

function Bar({ label, value, max, color, right }: { label: string; value: number; max: number; color: string; right?: boolean }) {
  const f = Math.max(0, Math.min(1, value / max));
  return (
    <div style={{ flex: 1, textAlign: right ? "right" : "left" }}>
      <div style={{ fontFamily: FONT, fontSize: 12, marginBottom: 3, textShadow: "0 1px 3px #000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ height: 14, borderRadius: 7, background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.3)", overflow: "hidden", display: "flex", justifyContent: right ? "flex-end" : "flex-start" }}>
        <div style={{ width: `${f * 100}%`, background: f < 0.25 ? "#ff4a3a" : color, transition: "width 0.15s" }} />
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 12, padding: "10px 4px" }}>
      <div style={{ fontFamily: FONT, fontSize: 24 }}>{n}</div>
      <div style={{ fontSize: 11, opacity: 0.75 }}>{label}</div>
    </div>
  );
}
