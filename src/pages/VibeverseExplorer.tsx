/**
 * THE VIBEVERSE — the front door, seen from orbit.
 *
 * Fly the survey vessel VIBEY through a procedural galaxy in which three of the
 * stars are real destinations: San Francisco, Seafair and Vibe Island II each
 * have a system named after them and a planet art-directed to look like the
 * world it leads to. Land on one and you are in it — the descent plays, the
 * dust settles, and the route changes under you.
 *
 * The engine is Anshu Chimala's (MIT, github.com/achimala/TheLongSilence),
 * vendored into `src/longsilence` and remixed; see the README there for what
 * changed and why. It was built as its own site — it owned the document, the
 * stylesheet and the frame loop, and it ran until the tab closed — so this page
 * takes over the four jobs `index.html` + `main.js` used to do:
 *
 *   1. it *is* the document: the boot screen, HUD and archive are the same
 *      markup inside a `#ls-root` wrapper the stylesheet is scoped to (the
 *      engine still finds every node by id);
 *   2. it drives the frame loop, and stops it — a route can be left, and the
 *      renderer, the score and the input listeners go with it;
 *   3. it answers the engine when a landing wants to become a navigation;
 *   4. it keeps a way back out, because a world you cannot leave is a trap.
 *
 * The engine and its copy of Three are pulled in only when someone actually
 * flies here, so the hub's entry bundle never carries them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import "@/longsilence/ui/style.css";

type Phase = "loading" | "ready" | "playing" | "gate" | "error";

/**
 * The slice of the engine this page actually touches. `Game` is plain JS with
 * a few hundred fields; describing the handful the boot sequence and the frame
 * loop reach for is more useful than `any` and more honest than pretending to
 * have typed the whole thing.
 */
interface VibeverseGame {
  started: boolean;
  time: number;
  mode: string;
  interiorRig?: { visible: boolean };
  interiorScene?: unknown;
  interiorCam?: unknown;
  engine: {
    time: number;
    dt: number;
    render(interiorScene: unknown, interiorCam: unknown): void;
    adapt(dt: number): void;
  };
  hud: {
    show(): void;
    log(text: string, kind?: string): void;
    narrate(text: string, who?: string): void;
  };
  audio: { resume(): Promise<void> };
  system: { star: { name: string } };
  boot(): Promise<void>;
  update(dt: number): void;
  updateIdle?(dt: number): void;
  dispose(): void;
  /** Set by this page. The engine calls it on touchdown on a world planet. */
  onEnterWorld?: (route: string, spec: { name: string }) => void;
}

declare global {
  interface Window {
    /** Upstream's inspection handle — `tools/*.mjs` pose the game through it. */
    __game?: VibeverseGame;
  }
}

/**
 * Phones are turned away at the door, as upstream does.
 *
 * This is not a quality tier that can be dialled down: the raymarched
 * atmospheres, the cloud decks and the twenty-pass post chain are the game, and
 * a handset cannot afford them. A short honest message beats a slideshow.
 */
function isHandset() {
  const coarse = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const small = Math.min(window.screen.width, window.screen.height) < 820;
  return coarse && small;
}

/** Where the exit sends you: back through the portal you arrived by, else the hub. */
function readReturn(): { href: string; label: string; external: boolean } {
  const p = new URLSearchParams(window.location.search);
  const ref = p.get("ref");
  if (ref) {
    const url = /^https?:\/\//i.test(ref) ? ref : `https://${ref}`;
    try {
      const out = new URL(url);
      out.searchParams.set("portal", "true");
      out.searchParams.set("username", p.get("username") || "Traveler");
      out.searchParams.set("color", p.get("color") || "#8fe4ff");
      out.searchParams.set("speed", p.get("speed") || "1");
      out.searchParams.set("ref", window.location.origin + window.location.pathname);
      return { href: out.toString(), label: "BACK THROUGH THE PORTAL", external: true };
    } catch {
      /* a malformed ref is not worth stranding anyone over */
    }
  }
  // Same door Seafair and the golf course use: the hub, not the shooter picker.
  return { href: "/", label: "BACK TO THE VIBEVERSE", external: false };
}

export default function VibeverseExplorer() {
  const navigate = useNavigate();
  const { displayName } = useVibeIdentity();
  /* Read through a ref inside the engine callback: the game is constructed once
     and must not be rebuilt because a name resolved a moment later. */
  const nameRef = useRef(displayName);
  nameRef.current = displayName;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<VibeverseGame | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("initialising");
  const [exit] = useState(readReturn);
  // The boot screen fades rather than cuts: it stays mounted, transparent and
  // click-through, for the length of its own transition.
  const [bootGone, setBootGone] = useState(false);
  // The exit is offered whenever the world is not actually being flown — the
  // boot screen, and any moment the pointer is unlocked (which is what Escape
  // does). During flight it would sit on the canopy, one mis-click from ending
  // the trip.
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    document.body.classList.add("ls-playing");
    return () => document.body.classList.remove("ls-playing");
  }, []);

  useEffect(() => {
    const onLock = () => setLocked(!!document.pointerLockElement);
    document.addEventListener("pointerlockchange", onLock);
    return () => document.removeEventListener("pointerlockchange", onLock);
  }, []);

  // ------------------------------------------------------------------ boot
  useEffect(() => {
    if (isHandset()) {
      setPhase("gate");
      return;
    }
    if (!document.createElement("canvas").getContext("webgl2")) {
      setStatus("WebGL2 unavailable on this device");
      setPhase("error");
      return;
    }

    let cancelled = false;
    let raf = 0;
    let game: VibeverseGame | null = null;

    void (async () => {
      // ~2 MB of engine, shaders and its own build of Three. It has no business
      // in the hub's entry chunk; it loads when someone flies here and not before.
      const { Game } = await import("@/longsilence/game/Game.js");
      if (cancelled || !canvasRef.current) return;

      try {
        game = new Game(canvasRef.current, (p: number, text?: string) => {
          if (cancelled) return;
          setProgress(p);
          if (text) setStatus(text);
        });
        /* The whole point of the place. Landing on San Francisco, Seafair or
           Vibe Island II is not a landing — it is a door — and this is the
           engine's only way to say so. It fires after the touchdown shot has
           played; see Game._maybeHandOff. */
        game.onEnterWorld = (route) => navigateRef.current(route);
        // Kept for the capture and inspection harnesses in the upstream repo,
        // which pose the game through this handle.
        window.__game = game;
        await game.boot();
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setStatus("initialisation failed — see console");
          setPhase("error");
        }
        return;
      }
      if (cancelled) {
        game.dispose();
        return;
      }

      gameRef.current = game;
      setProgress(1);
      setStatus("systems nominal");
      setPhase("ready");

      /* The loop. Upstream clamps dt so a backgrounded tab does not resume with
         a single enormous step, and skips hidden frames entirely. */
      const MAX_DT = 1 / 15;
      let last = performance.now();
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        let dt = (now - last) / 1000;
        last = now;
        if (dt > MAX_DT) dt = MAX_DT;
        if (document.hidden) return;
        try {
          if (game.started) game.update(dt);
          else game.updateIdle?.(dt);
          game.engine.time = game.time;
          game.engine.dt = dt;
          // The cabin is a second pass with its own camera; see Engine.render.
          game.engine.render(
            game.interiorRig && game.interiorRig.visible ? game.interiorScene : null,
            game.interiorCam,
          );
          game.engine.adapt(dt);
        } catch (e) {
          console.error(e);
          cancelAnimationFrame(raf);
          setStatus("runtime error — see console");
          setPhase("error");
        }
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const g = gameRef.current || game;
      gameRef.current = null;
      if (window.__game === g) delete window.__game;
      g?.dispose?.();
    };
  }, []);

  // ------------------------------------------------------------------ wake
  const wake = useCallback(() => {
    const game = gameRef.current;
    if (!game || game.started) return;
    setPhase("playing");
    setTimeout(() => setBootGone(true), 1000);
    game.hud.show();
    game.started = true;
    void game.audio.resume().catch(() => {
      /* autoplay policy — the score starts at the first gesture instead */
    });

    // The opening beats, on upstream's timings — addressed to whoever is flying.
    void (async () => {
      const { introLines } = await import("@/longsilence/game/lore.js");
      const lines = introLines(nameRef.current === "Guest" ? "" : nameRef.current);
      (lines as { text: string; who?: string }[]).forEach((l, i) => {
        setTimeout(() => gameRef.current && game.hud.narrate(l.text, l.who), 1200 + i * 5200);
      });
    })();
    setTimeout(() => {
      if (!gameRef.current) return;
      game.hud.log("SCANNER ONLINE", "ok");
      game.hud.log(`SYSTEM · ${game.system.star.name.toUpperCase()}`);
    }, 900);
  }, []);

  // Enter/Space wakes the ship, the same as the button.
  useEffect(() => {
    if (phase !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, wake]);

  const wayOut =
    exit.external ? (
      <a className="ls-out" href={exit.href}>
        {exit.label}
      </a>
    ) : (
      <Link className="ls-out" to={exit.href}>
        {exit.label}
      </Link>
    );

  if (phase === "gate") {
    return (
      <div id="ls-root">
        <div id="boot" className="gate">
          <div className="boot-inner">
            <h1 className="boot-title">THE VIBEVERSE</h1>
            <div className="boot-sub">
              SURVEY VESSEL &middot; <span className="accent">VIBEY</span>
            </div>
            <p className="boot-gate">
              This one wants a real screen and a real GPU.
              <br />
              Open it on a desktop or laptop.
            </p>
            <div className="boot-legal">requires WebGL2 &middot; headphones recommended</div>
            {wayOut}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="ls-root">
      <canvas id="scene" ref={canvasRef} />

      {/* ====================== BOOT ====================== */}
      {!bootGone && (
        <div id="boot" className={phase === "playing" ? "out" : undefined}>
          <div className="boot-inner">
            <div className="boot-mark">
              <svg viewBox="0 0 120 120" width="110" height="110">
                <circle cx="60" cy="60" r="46" className="bm-ring" />
                <circle cx="60" cy="60" r="34" className="bm-ring bm-ring2" />
                <circle cx="60" cy="60" r="4" className="bm-dot" />
                <path
                  d="M60 4 L60 18 M60 102 L60 116 M4 60 L18 60 M102 60 L116 60"
                  className="bm-tick"
                />
              </svg>
            </div>
            <h1 className="boot-title">THE VIBEVERSE</h1>
            <div className="boot-sub">
              SURVEY VESSEL &middot; <span className="accent">VIBEY</span>
            </div>
            <div className="boot-bar">
              <i style={{ right: `${Math.max(0, (1 - progress) * 100)}%` }} />
            </div>
            <div className="boot-status" style={phase === "error" ? { color: "#ff6b5e" } : undefined}>
              {status}
            </div>
            {phase === "ready" && (
              <button className="boot-start" onClick={wake}>
                WAKE
              </button>
            )}
            <div className="boot-legal">requires WebGL2 &middot; headphones recommended</div>
            {wayOut}
          </div>
        </div>
      )}

      {/* The way back out, once you are flying: only while the pointer is free,
          which is where a player already is when they want to leave. */}
      {phase === "playing" && !locked && <div className="ls-out-dock">{wayOut}</div>}

      {/* ====================== IN-WORLD OVERLAY ======================
          Instruments live on the dashboard. This layer is only for things that
          exist in the crew member's head: what they are looking at, what they
          were just told, and what they can reach. Every node below is written
          by the engine, by id — React renders it once and never touches it. */}
      <div id="hud" className="hidden">
        {/* aiming reticle, pilot only */}
        <div id="reticle" className="hidden">
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="21" className="r-ring" />
            <path d="M60 30 L60 38 M60 82 L60 90 M30 60 L38 60 M82 60 L90 60" className="r-tick" />
            <circle cx="60" cy="60" r="1.4" className="r-dot" />
            <path id="rArc" d="" className="r-arc" />
          </svg>
        </div>

        {/* contact markers projected on the canopy */}
        <div id="markers" />

        {/* message log */}
        <div id="log" />

        {/* The prompt sits directly above the subtitle, in one stack. Both were
            once absolute at fixed percentages, and the subtitle's height depends
            on how many lines the dialogue runs to — so any fixed percentage for
            the prompt is a guess. Stacking them makes the prompt track the
            subtitle's real height instead. */}
        <div id="narrStack">
          <div id="prompt" className="hidden">
            <b id="promptKey">E</b>
            <span id="promptLabel" />
            <em id="promptHint" />
          </div>
          <div id="narr">
            <div id="narrText" />
          </div>
        </div>

        {/* contextual controls */}
        <div id="hints" />

        {/* fold banner */}
        <div id="foldOverlay">
          <div className="fo-t">FOLD</div>
          <div className="fo-s" id="foldSub" />
        </div>

        {/* damage / alert vignette is handled in post; this is the cue text */}
        <div id="alert" className="hidden" />
      </div>

      {/* ====================== ARCHIVE ====================== */}
      <div id="codex" className="panel hidden">
        <div className="p-head">
          <h2>ARCHIVE</h2>
          <button className="p-close" data-close="codex">
            ✕
          </button>
        </div>
        <div className="p-body codex-body">
          <div className="codex-nav" id="codexNav" />
          <div className="codex-main" id="codexMain" />
        </div>
      </div>

      {/* ====================== TOUCH ====================== */}
      <div id="touchUI" className="hidden">
        <div id="stickL" className="stick">
          <i />
        </div>
        <div id="stickR" className="stick">
          <i />
        </div>
        <div id="touchBtns">
          <button className="tb" data-act="use">
            USE
          </button>
          <button className="tb" data-act="boost">
            RUN
          </button>
          <button className="tb" data-act="scan">
            SCAN
          </button>
          <button className="tb" data-act="auto">
            AUTO
          </button>
          <button className="tb" data-act="fold">
            FOLD
          </button>
        </div>
        <div id="touchThr">
          <button className="tt" data-act="thrUp">
            +
          </button>
          <button className="tt" data-act="thrDn">
            −
          </button>
        </div>
      </div>

      <div id="perf" />
    </div>
  );
}
