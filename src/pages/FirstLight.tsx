/**
 * First Light — a lake at dawn, and the quietest thing in the vibeverse.
 *
 * The React layer is deliberately thin, the way San Palmas and Seafair are:
 * it mounts a canvas, runs the boot sequence, owns the pointer lock and the
 * menus, and gets out of the way. Everything that moves lives in
 * `src/firstlight/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { FirstLightEngine, EngineStats } from "@/firstlight/engine";

export default function FirstLight() {
  useWorldStamp("/first-light", "First Light");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<FirstLightEngine | null>(null);

  const [progress, setProgress] = useState({ stage: "Waking up", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [showStats, setShowStats] = useState(false);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const shotMode = params?.has("shot") ?? false;
  /* `?q=low|medium|high|ultra` forces a tier. The capture harness uses it to
     render something in software GL this decade, and it is the escape hatch for
     anybody whose machine the auto-detect reads wrong. */
  const forcedTier = params?.get("q") as "low" | "medium" | "high" | "ultra" | null;
  /* `?dawn=0..1` freezes the sun at a point in the arc. The world is a
     four-minute sunrise, so without this the only moment anybody ever reviews
     is whichever one the capture happened to land on. */
  const forcedDawn = params?.has("dawn") ? Number(params.get("dawn")) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { boot } = await import("@/firstlight/engine");
        const engine = await boot({
          canvas,
          shot: shotMode,
          tier: forcedTier ?? undefined,
          onProgress: (stage, fraction) => {
            if (!cancelled) setProgress({ stage, fraction });
          },
        });
        if (cancelled) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        if (forcedDawn !== null && Number.isFinite(forcedDawn)) engine.setDawn(forcedDawn);
        engine.onStats((s) => !cancelled && setStats({ ...s }));
        engine.start();
        setReady(true);
        if (shotMode) {
          setEntered(true);
          (window as unknown as Record<string, unknown>).__firstlight = engine;
          (window as unknown as Record<string, unknown>).__firstlightReady = true;
        }
      } catch (err) {
        console.error("[First Light] boot failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [shotMode, forcedTier, forcedDawn]);

  /* Resize, pointer lock, and input. All bound to the window rather than the
     canvas so that releasing the pointer mid-drag cannot strand a key down. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onResize = () => engineRef.current?.resize();
    const onLockChange = () => {
      const isLocked = document.pointerLockElement === canvas;
      setLocked(isLocked);
      engineRef.current?.setPaused(!isLocked && !shotMode);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      engineRef.current?.player.onMouseMove(e.movementX, e.movementY);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "F3") {
        e.preventDefault();
        setShowStats((v) => !v);
        return;
      }
      engineRef.current?.player.setKey(e.code, true);
    };
    const onKeyUp = (e: KeyboardEvent) => engineRef.current?.player.setKey(e.code, false);
    /* A tab that loses focus keeps whatever keys were held, and you come back
       to a player walking into the lake on their own. */
    const onBlur = () => {
      for (const c of ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"]) {
        engineRef.current?.player.setKey(c, false);
      }
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("pointerlockchange", onLockChange);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [shotMode]);

  const enter = useCallback(() => {
    setEntered(true);
    canvasRef.current?.requestPointerLock?.();
  }, []);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#0b0f14]">
      <canvas ref={canvasRef} className="block h-full w-full" onClick={() => entered && enter()} />

      {/* Back to the hub — shown whenever the player is not actively walking,
          per the house rule that every world has a visible way out. */}
      {!locked && (
        <Link
          to="/"
          className="absolute left-4 top-4 z-30 rounded-full border border-white/15 bg-black/40 px-4 py-2 text-sm text-white/85 backdrop-blur transition hover:border-white/35 hover:text-white"
        >
          ← The vibeverse
        </Link>
      )}

      {showStats && stats && (
        <div className="pointer-events-none absolute right-4 top-4 z-30 rounded-lg border border-white/10 bg-black/55 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/75 backdrop-blur">
          <div>{stats.fps} fps · {Math.round(stats.scale * 100)}% scale</div>
          <div>{stats.tier} · {stats.draws} draws</div>
          <div>{stats.triangles.toLocaleString()} tris</div>
        </div>
      )}

      {/* Loading + title. One veil: a separate loading screen and title card
          means two fades and a flash of the scene between them. */}
      {!entered && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-[#0b1017] via-[#121a22] to-[#1d2027] px-6 text-center">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.32em] text-white/40">
            The vibeverse
          </p>
          <h1 className="mb-4 text-5xl font-light tracking-tight text-white/95 sm:text-6xl">
            First Light
          </h1>
          <p className="mb-10 max-w-md text-[15px] leading-relaxed text-white/55">
            A lake, an hour before the sun clears the ridge. Nothing to win here — walk the
            shore, stand in the shallows, and watch it come up.
          </p>

          {error ? (
            <p className="max-w-md rounded-lg border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200/90">
              It did not start: {error}
            </p>
          ) : ready ? (
            <>
              <button
                onClick={enter}
                className="rounded-full bg-white/92 px-8 py-3 text-sm font-medium text-[#141a20] transition hover:bg-white"
              >
                Walk down to the water
              </button>
              <p className="mt-6 font-mono text-[11px] tracking-wide text-white/35">
                WASD to walk · shift to jog · mouse to look · esc to stop · F3 for numbers
              </p>
            </>
          ) : (
            <div className="w-64">
              <div className="h-px w-full overflow-hidden bg-white/10">
                <div
                  className="h-full bg-white/60 transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-4 font-mono text-[11px] tracking-wide text-white/40">
                {progress.stage}…
              </p>
            </div>
          )}
        </div>
      )}

      {/* Standing still, pointer released. */}
      {entered && !locked && !shotMode && (
        <div
          className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/45 backdrop-blur-[2px]"
          onClick={enter}
        >
          <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-white/70">
            Click to keep walking
          </p>
        </div>
      )}
    </div>
  );
}
