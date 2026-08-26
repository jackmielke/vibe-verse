/**
 * The UI root.
 *
 * One mount point for everything the player sees that is not rendered by
 * three.js. Drop `<SfUi />` next to `<Canvas>` and the whole interface —
 * HUD, map, menus, photo mode, notifications, the way back to the Vibeverse —
 * comes with it.
 *
 * It owns three things nothing else should:
 *   1. The `.sf-ui` root element, which carries the design tokens as CSS
 *      custom properties and the accessibility data-attributes.
 *   2. Interface key handling — pause, map, photo, HUD toggle, weapon slots —
 *      resolved through the player's own bindings, never hard-coded.
 *   3. The settings bridge: pushing user settings into the systems that own
 *      them (post chain, audio mixer, camera FOV) so the options screen is a
 *      live preview rather than a promise.
 *
 * Gameplay input (movement, firing) is emphatically NOT handled here. That
 * belongs to the player subsystem; this layer only claims keys that open and
 * close interface surfaces, and it stands down entirely while a text field
 * has focus.
 */
import { useEffect, type CSSProperties } from "react";
import { frame, useSfStore } from "../state/store";
import { readShotRequest } from "../debug/shotHook";
import { postfx } from "../postfx/state";
import { installUiStyles } from "./styles";
import { useUiStore, actionFor } from "./uiStore";
import { WHEEL_ORDER } from "./weaponMeta";
import { photoRig } from "./photo";
import Hud from "./Hud";
import MapScreen from "./MapScreen";
import Menus from "./Menus";
import LoadingScreen from "./LoadingScreen";
import PhotoMode from "./PhotoMode";
import DeathScreen from "./DeathScreen";
import Discovery from "./Discovery";

export interface SfUiProps {
  /** Force the whole interface off — the screenshot harness uses this. */
  hidden?: boolean;
  /**
   * No opposition and no scoring, so no widgets about either. The interface
   * should not promise a game that is not running: a chaos multiplier ticking
   * away in the corner of a city you are only walking through is the single
   * loudest way to say "this is a shooter" to somebody who came for a walk.
   */
  peaceful?: boolean;
}

export default function SfUi({ hidden, peaceful = false }: SfUiProps) {
  installUiStyles();

  const settings = useUiStore((s) => s.settings);
  const route = useUiStore((s) => s.route);
  const phase = useSfStore((s) => s.phase);

  /* --- screenshot harness ------------------------------------------ */
  // `?shot=...&hud=0` means a critic is photographing the render, not the
  // interface. Respect it: a HUD in every capture makes the world impossible
  // to judge.
  const shotHidesUi = (() => {
    if (typeof window === "undefined") return false;
    const req = readShotRequest(window.location.search);
    return req ? !req.hud : false;
  })();

  /* --- settings bridge --------------------------------------------- */
  useEffect(() => {
    // Post chain. These are plain scalars the pipeline reads each frame, so
    // writing them here is the entire integration.
    postfx.grain = settings.filmGrain;
    postfx.chromaticAberration = settings.chromaticAberration;
    postfx.vignette = settings.vignette;
    postfx.bloomIntensity = settings.bloom;
    postfx.motionBlurScale = settings.motionBlur;
    postfx.exposure = settings.brightness;
  }, [settings]);

  useEffect(() => {
    // Audio mixer. Imported lazily and defensively: the audio graph may not
    // exist yet (it needs a user gesture), and a missing mixer must never
    // break the settings screen.
    let cancelled = false;
    import("../audio/api")
      .then(({ sfAudio }) => {
        if (cancelled || !sfAudio?.available) return;
        sfAudio.setVolume("master", settings.volMaster);
        sfAudio.setVolume("weapons", settings.volSfx);
        sfAudio.setVolume("vehicles", settings.volSfx);
        sfAudio.setVolume("world", settings.volSfx);
        sfAudio.setVolume("music", settings.volMusic);
        sfAudio.setVolume("voice", settings.volVoice);
        sfAudio.setVolume("ui", settings.volUi);
      })
      .catch(() => {
        /* audio subsystem absent — the rest of the UI does not care */
      });
    return () => {
      cancelled = true;
    };
  }, [
    settings.volMaster,
    settings.volSfx,
    settings.volMusic,
    settings.volVoice,
    settings.volUi,
  ]);

  useEffect(() => {
    // FOV is applied by the camera rig from `frame.fov` every frame.
    if (!photoRig.active) frame.fov = settings.fov;
  }, [settings.fov]);

  /* --- pause bookkeeping ------------------------------------------- */
  useEffect(() => {
    const modal = route === "pause" || route === "settings" || route === "controls" || route === "credits" || route === "main";
    if (modal) {
      frame.paused = true;
      document.exitPointerLock?.();
    } else if (route === "none" && phase === "playing" && !photoRig.active) {
      frame.paused = false;
    }
  }, [route, phase]);

  /* --- interface keys ---------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const ui = useUiStore.getState();
      const store = useSfStore.getState();

      const action = actionFor(e.code);

      // Photo mode runs its own key handling; do not fight it — with one
      // exception. The photo toggle itself has to get through, or the mode
      // that swallows every key also swallows the key that leaves it, and the
      // only way out is a page reload. (Escape is handled below and works too.)
      if (ui.route === "photo" && action !== "photo") return;

      // Escape is special: it always means "one step back", regardless of
      // what it happens to be bound to.
      if (e.code === "Escape") {
        e.preventDefault();
        if (ui.route !== "none") {
          if (ui.routeStack.length > 0) ui.back();
          else {
            ui.go("none");
            if (store.phase === "paused") store.setPhase("playing");
          }
        } else if (store.phase === "playing") {
          ui.go("pause");
          store.setPhase("paused");
        }
        return;
      }

      switch (action) {
        case "map":
          e.preventDefault();
          if (ui.route === "map") ui.go("none");
          else ui.go("map");
          return;
        case "photo":
          e.preventDefault();
          ui.go(ui.route === "photo" ? "none" : "photo");
          return;
        case "hud":
          e.preventDefault();
          store.toggleHud();
          return;
        case "debug":
          e.preventDefault();
          store.toggleDebug();
          return;
        case "waypoint":
          e.preventDefault();
          ui.setWaypoint(null);
          return;
        case "wheel":
          if (!e.repeat && ui.route === "none" && store.phase === "playing") {
            e.preventDefault();
            ui.setWheel(true);
          }
          return;
        default:
          break;
      }

      // Weapon slots on the number row. 1..9 then 0 for the tenth, matching
      // `WEAPON_ORDER`.
      if (ui.route === "none" && store.phase === "playing" && e.code.startsWith("Digit")) {
        const d = parseInt(e.code.slice(5), 10);
        const idx = d === 0 ? 9 : d - 1;
        const key = WHEEL_ORDER[idx];
        if (key) {
          e.preventDefault();
          store.setWeapon(key);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (actionFor(e.code) === "wheel" && ui.wheelOpen) {
        // The wheel commits its own selection on release (see WeaponWheel);
        // this only guarantees it closes even if the pointer never moved.
        ui.setWheel(false);
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  if (hidden || shotHidesUi) return null;

  const hudVisible = !(photoRig.active && photoRig.hideHud);

  return (
    <div
      className="sf-ui"
      data-cvd={settings.colorblind}
      data-reduce-motion={settings.reduceMotion ? "1" : "0"}
      style={
        {
          "--sf-hud-scale": String(settings.hudScale),
          "--sf-hud-opacity": String(settings.hudOpacity),
          "--sf-subtitle-scale":
            settings.subtitleSize === "s"
              ? "0.85"
              : settings.subtitleSize === "l"
                ? "1.3"
                : settings.subtitleSize === "xl"
                  ? "1.7"
                  : "1",
        } as CSSProperties
      }
    >
      <LoadingScreen />
      <Hud visible={hudVisible} peaceful={peaceful} />
      <Discovery />
      <MapScreen />
      <PhotoMode />
      <Menus />
      <DeathScreen />
      {/* The way out is the vibeverse's own home button now, top-left, in
          every world rather than in this one. It follows the rule this file's
          chrome established first: gone while the pointer is locked. */}
    </div>
  );
}
