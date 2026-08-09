/**
 * DROP ZERO / SOAKED — the on-screen touch controls.
 *
 * A battle royale whose whole identity is *building* cannot ship a phone
 * build with a move stick and a fire tap. `engine/input.ts` already turns the
 * canvas into a twin stick — left half moves, right half looks, a tap on the
 * right shoots — and that is enough to walk around and miss. This layer is
 * everything a thumb otherwise cannot reach: jump, sprint, aim, reload, the
 * four build pieces, rotate, edit, the material cycle, the five inventory
 * slots, the balloon and glue-gun shortcuts, and the contextual interact.
 *
 * ## How it is wired
 *
 * It writes nothing into the game itself. Every button calls a method on the
 * `TouchDriver` that `input.ts` publishes, and that file writes the same
 * `ctx.input` fields a key would have written (`buildKind`, `pressed`, `fire`,
 * `jump`, `slot`, `rotate`, `interact`). No gameplay system knows a finger was
 * involved, and there is exactly one place — `input.ts` — where a control
 * means something.
 *
 * It reads the game through engine events only, the same contract the HUD
 * keeps: `dz:build` for the selected piece and the edit state, `dz:inventory`
 * for what is in which slot, `dz:loot-prompt` for the interact button. Both
 * of the first two fire every frame, so every handler is signature-guarded
 * and React only re-renders when something structural actually changed.
 *
 * ## Why it mounts itself
 *
 * `input.ts` imports this module dynamically when `(pointer: coarse)` matches
 * and mounts it into its own host element. That means a desktop visitor never
 * downloads the chunk, never mounts a component and never pays a listener —
 * and a page that boots this engine gets thumb controls without having to
 * know they exist.
 *
 * ## The rules of the layout
 *
 * - Nothing is `pointer-events: auto` except the buttons themselves, so the
 *   look-drag region and the move stick underneath keep working between them.
 * - Everything interactive is `touch-action: none`, or the browser claims the
 *   gesture for scroll/zoom and the button feels broken.
 * - The whole layer is hidden until the touch session is engaged, so it never
 *   sits on top of the lobby, and hidden again on the end card, which owns the
 *   screen.
 * - Safe-area insets on every edge cluster: a fire button under the home
 *   indicator is a fire button you cannot press.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { BuildKind, WorldCtx } from "../types";
import type { StickState, TouchDriver } from "../engine/input";
import { WATER } from "../mode/water";

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

const HOST_ID = "dz-touch-controls";

/**
 * Mount the control layer into its own host under `<body>`.
 *
 * Returns the teardown. Called from `input.ts`'s factory and torn down in its
 * `dispose()`, so the layer's lifetime is exactly the engine's — a leaked
 * overlay would sit on top of the *next* world a visitor opens.
 */
export function mountTouchControls(ctx: WorldCtx, driver: TouchDriver): () => void {
  if (typeof document === "undefined") return () => {};
  // Two engines on one page (or a double-mount in React strict mode) must not
  // stack two control layers on top of each other.
  if (document.getElementById(HOST_ID)) return () => {};

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<TouchControls ctx={ctx} driver={driver} />);

  return () => {
    // Deferred: React refuses to unmount a root synchronously from inside its
    // own render/commit, and dispose() can be reached from either.
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
}

/* ------------------------------------------------------------------------ *
 * Payload readers — same defensive shape the HUD uses
 * ------------------------------------------------------------------------ */

const EMPTY: Record<string, unknown> = {};
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : EMPTY;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const KINDS: BuildKind[] = ["wall", "floor", "ramp", "cone"];
const asKind = (v: unknown): BuildKind | null => {
  const s = str(v);
  return (KINDS as string[]).includes(s) ? (s as BuildKind) : null;
};

/* ------------------------------------------------------------------------ *
 * Palette
 *
 * Same reasoning as the HUD's: this sits on a saturated outdoor render and
 * needs its own dark plate rather than a Tailwind token. SOAKED lightens it
 * and goes cyan, Drop Zero stays cold and near-black.
 * ------------------------------------------------------------------------ */

interface Skin {
  plate: string;
  plateOn: string;
  edge: string;
  edgeOn: string;
  text: string;
}

const CLASSIC_SKIN: Skin = {
  plate: "rgba(6,10,20,0.5)",
  plateOn: "rgba(150,120,255,0.42)",
  edge: "rgba(255,255,255,0.28)",
  edgeOn: "rgba(214,196,255,0.95)",
  text: "rgba(255,255,255,0.94)",
};

const WATER_SKIN: Skin = {
  plate: "rgba(8,26,44,0.46)",
  plateOn: "rgba(56,189,248,0.42)",
  edge: "rgba(186,236,255,0.34)",
  edgeOn: "rgba(186,236,255,0.95)",
  text: "rgba(255,255,255,0.95)",
};

/**
 * Item `def` ids the two water shortcuts look for. `WATER.balloon` carries its
 * own id; the glue gun is a weapon in `WATER.weapons` and its id is spelled
 * out here rather than searched for, because a lookup that silently misses
 * would give a button that does nothing.
 */
const BALLOON_DEF = WATER.balloon.id;
const GLUE_DEF = "glue-gun";

/** Material chip label. Water re-letters wood/stone/metal; classic does not. */
const MAT_LABEL: Record<string, { classic: string; water: string }> = {
  wood: { classic: "WOOD", water: WATER.strings.materials.wood.toUpperCase() },
  stone: { classic: "STONE", water: WATER.strings.materials.stone.toUpperCase() },
  metal: { classic: "METAL", water: WATER.strings.materials.metal.toUpperCase() },
};

/* ------------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------------ */

interface PadProps {
  label?: string;
  icon?: ReactNode;
  /** Small caption under the label — the keyboard equivalent, mostly. */
  sub?: string;
  size?: number;
  /** Width override for pill-shaped buttons. */
  width?: number;
  round?: boolean;
  on?: boolean;
  skin: Skin;
  /** Held buttons pass both; tap buttons pass only `onDown`. */
  onDown: () => void;
  onUp?: () => void;
  style?: CSSProperties;
  fontSize?: number;
}

/**
 * One button.
 *
 * Pointer events rather than click: a click fires ~300 ms late on some mobile
 * browsers and cannot express "held", and a shooter needs both. The pointer is
 * captured on down so a thumb that slides off the edge still releases the
 * flag, which is the difference between letting go of the trigger and firing
 * forever.
 */
function Pad({
  label,
  icon,
  sub,
  size = 58,
  width,
  round = true,
  on = false,
  skin,
  onDown,
  onUp,
  style,
  fontSize = 11,
}: PadProps) {
  const [held, setHeld] = useState(false);

  const down = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setHeld(true);
      onDown();
    },
    [onDown],
  );

  const up = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setHeld(false);
      onUp?.();
    },
    [onUp],
  );

  const lit = on || held;
  return (
    <button
      type="button"
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        pointerEvents: "auto",
        touchAction: "none",
        WebkitTapHighlightColor: "transparent",
        width: width ?? size,
        height: size,
        borderRadius: round ? 9999 : 14,
        background: lit ? skin.plateOn : skin.plate,
        border: `1.5px solid ${lit ? skin.edgeOn : skin.edge}`,
        boxShadow: held
          ? "inset 0 2px 8px rgba(0,0,0,0.45)"
          : "inset 0 1px 0 rgba(255,255,255,0.2), 0 2px 10px rgba(0,0,0,0.4)",
        color: skin.text,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        fontWeight: 800,
        fontSize,
        letterSpacing: "0.06em",
        lineHeight: 1,
        backdropFilter: "blur(3px)",
        overflow: "hidden",
        padding: "0 4px",
        transform: held ? "scale(0.94)" : "none",
        transition: "transform 90ms ease, background 120ms ease",
        ...style,
      }}
    >
      {icon}
      {label ? <span>{label}</span> : null}
      {sub ? (
        <span
          style={{
            fontSize: 8,
            opacity: 0.6,
            fontWeight: 600,
            maxWidth: "100%",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {sub}
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------------ *
 * Build-piece glyphs
 *
 * Drawn rather than labelled: at 62 px a word is unreadable at arm's length
 * and a silhouette is not. Same four shapes the build preview uses.
 * ------------------------------------------------------------------------ */

function PieceIcon({ kind }: { kind: BuildKind }) {
  const stroke = "currentColor";
  const common = { fill: "none", stroke, strokeWidth: 1.8, strokeLinejoin: "round" as const };
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" aria-hidden>
      {kind === "wall" && <rect x="4" y="3" width="18" height="16" rx="1.5" {...common} />}
      {kind === "floor" && <path d="M2 14 L13 8 L24 14 L13 20 Z" {...common} />}
      {kind === "ramp" && <path d="M3 19 L3 12 L22 3 L22 19 Z" {...common} />}
      {kind === "cone" && <path d="M13 3 L23 19 L3 19 Z" {...common} />}
    </svg>
  );
}

/* ------------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------------ */

interface SlotView {
  index: number;
  def: string;
  name: string;
  color: number;
  filled: boolean;
  active: boolean;
  count: number;
}

interface BuildView {
  kind: BuildKind | null;
  material: string;
  editing: boolean;
}

export default function TouchControls({ ctx, driver }: { ctx: WorldCtx; driver: TouchDriver }) {
  const water = ctx.mode === "water";
  const skin = water ? WATER_SKIN : CLASSIC_SKIN;

  const [engaged, setEngaged] = useState(driver.engaged);
  /** The end card owns the screen; controls get out of its way. */
  const [over, setOver] = useState(false);
  const [build, setBuild] = useState<BuildView>({ kind: null, material: "wood", editing: false });
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [prompt, setPrompt] = useState<string | null>(null);

  const baseRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);

  /* ---- engine subscriptions -------------------------------------------- */

  useEffect(() => setEngaged(driver.engaged), [driver]);
  useEffect(() => driver.onEngage(setEngaged), [driver]);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let buildSig = "";
    let slotSig = "";
    let promptSig = "";

    offs.push(
      ctx.on("dz:build", (p) => {
        const d = rec(p);
        const next: BuildView = {
          kind: asKind(d.kind),
          material: str(d.material, "wood"),
          editing: d.editing === true,
        };
        const sig = `${next.kind}|${next.material}|${next.editing}`;
        if (sig === buildSig) return;
        buildSig = sig;
        setBuild(next);
      }),
    );

    offs.push(
      ctx.on("dz:inventory", (p) => {
        const d = rec(p);
        const raw = list(d.slots);
        const active = Math.round(num(d.activeSlot, 0));
        const next: SlotView[] = [];
        let sig = `${active}`;
        // Slot 0 is the pickaxe and is always there; the strip shows 1..5.
        for (let i = 1; i <= 5; i++) {
          const v = rec(raw[i]);
          const def = str(v.def);
          const kind = str(v.kind);
          next.push({
            index: i,
            def,
            name: str(v.name),
            color: Math.round(num(v.color, 0xb1b1b1)) || 0xb1b1b1,
            filled: kind !== "",
            active: i === active,
            count: Math.round(num(v.count)),
          });
          sig += `|${def}:${kind}:${Math.round(num(v.count))}`;
        }
        if (sig === slotSig) return;
        slotSig = sig;
        setSlots(next);
      }),
    );

    offs.push(
      ctx.on("dz:loot-prompt", (p) => {
        // Null clears it — that is the HUD's contract for this event too.
        const d = p === null || p === undefined ? null : rec(p);
        const text = d ? `${str(d.action, "TAKE")} ${str(d.name)}`.trim().toUpperCase() : "";
        if (text === promptSig) return;
        promptSig = text;
        setPrompt(text || null);
      }),
    );

    const end = () => setOver(true);
    offs.push(ctx.on("dz:victory", end));
    offs.push(ctx.on("dz:eliminated", end));

    return () => {
      for (const off of offs) off();
    };
  }, [ctx]);

  /* ---- the thumbstick --------------------------------------------------- */

  // Painted straight into the DOM rather than held in state: the stick moves
  // with the thumb at pointer-event rate and a setState per move would run
  // React reconciliation next to a renderer that wants the whole frame.
  useEffect(() => {
    if (!engaged || over) return;
    const paint = (s: StickState) => {
      const base = baseRef.current;
      const knob = knobRef.current;
      if (!base || !knob) return;
      base.style.opacity = s.active ? "1" : "0";
      if (!s.active) return;
      base.style.transform = `translate(${s.baseX}px, ${s.baseY}px) translate(-50%, -50%)`;
      const dx = s.x - s.baseX;
      const dy = s.y - s.baseY;
      const len = Math.hypot(dx, dy);
      // Clamp the knob to the base's rim so it reads like a stick and not a
      // dot chasing the thumb across the screen.
      const k = len > s.radius ? s.radius / len : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px) translate(-50%, -50%)`;
    };
    return driver.onStick(paint);
  }, [driver, engaged, over]);

  /* ---- actions ---------------------------------------------------------- */

  /**
   * A one-frame trigger pull. `driver.pulse` holds it until the simulation has
   * actually stepped, so a phone running at 12 fps still places the piece — a
   * timed release would let the pulse fall between two frames.
   */
  const pulseFire = useCallback(() => driver.pulse("fire"), [driver]);

  const hold = useCallback(
    (flag: Parameters<TouchDriver["setFlag"]>[0]) => ({
      onDown: () => driver.setFlag(flag, true),
      onUp: () => driver.setFlag(flag, false),
    }),
    [driver],
  );

  const jump = useCallback(() => {
    // player.ts buffers the jump off `pressed.has("Space")` and reads the
    // `jump` flag for hold-to-glide, so a virtual jump has to set both.
    driver.press("Space");
    driver.setFlag("jump", true);
  }, [driver]);

  const pickPiece = useCallback(
    (kind: BuildKind) => {
      // Fortnite Mobile's builder rule: the first tap selects, the next one
      // places. Placement is `input.fire` while a piece is selected, which is
      // exactly what the mouse does.
      if (build.kind === kind) pulseFire();
      else driver.setBuildKind(kind);
    },
    [build.kind, driver, pulseFire],
  );

  const toggleBuild = useCallback(() => {
    driver.setBuildKind(build.kind ? null : "wall");
  }, [build.kind, driver]);

  /** Jump to the slot holding a given item def, if the player has one. */
  const quickSlot = useCallback(
    (def: string) => {
      const found = slots.find((s) => s.def === def && s.filled);
      if (found) driver.selectSlot(found.index);
    },
    [driver, slots],
  );

  const balloon = useMemo(
    () => slots.find((s) => s.def === BALLOON_DEF && s.filled) ?? null,
    [slots],
  );
  const glue = useMemo(
    () => slots.find((s) => s.def === GLUE_DEF && s.filled) ?? null,
    [slots],
  );

  if (!engaged || over) return null;

  const building = build.kind !== null;
  const matLabel = MAT_LABEL[build.material]
    ? water
      ? MAT_LABEL[build.material].water
      : MAT_LABEL[build.material].classic
    : build.material.toUpperCase();

  /** Bottom of the action clusters: clear of the inventory strip + notch. */
  const bottom = "calc(env(safe-area-inset-bottom, 0px) + 62px)";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 28,
        pointerEvents: "none",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        fontFamily: "inherit",
      }}
    >
      {/* ---- move stick. Drawn where the thumb landed; the canvas handlers
              in input.ts are what actually read it. ---------------------- */}
      <div
        ref={baseRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 132,
          height: 132,
          borderRadius: 9999,
          border: `2px solid ${skin.edge}`,
          background: skin.plate,
          opacity: 0,
          transition: "opacity 120ms ease",
        }}
      >
        <div
          ref={knobRef}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 58,
            height: 58,
            borderRadius: 9999,
            background: skin.plateOn,
            border: `2px solid ${skin.edgeOn}`,
            boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
          }}
        />
      </div>

      {/* ---- resting hint: where to put the left thumb ------------------- */}
      <div
        style={{
          position: "absolute",
          left: "calc(env(safe-area-inset-left, 0px) + 26px)",
          bottom: `calc(${bottom} + 26px)`,
          width: 108,
          height: 108,
          borderRadius: 9999,
          border: `1.5px dashed ${skin.edge}`,
          opacity: 0.34,
        }}
      />

      {/* ---- right action cluster --------------------------------------- */}
      <div
        style={{
          position: "absolute",
          right: "calc(env(safe-area-inset-right, 0px) + 12px)",
          bottom,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 8,
        }}
      >
        {prompt && (
          <Pad
            skin={skin}
            label={prompt.slice(0, 18)}
            sub="hold"
            round={false}
            width={168}
            size={44}
            fontSize={10}
            {...hold("interact")}
          />
        )}

        {building ? (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <Pad
                skin={skin}
                label="MAT"
                sub={matLabel}
                size={50}
                width={74}
                round={false}
                onDown={() => driver.press("KeyT")}
              />
              <Pad skin={skin} label="ROT" size={50} onDown={() => driver.rotate()} />
              <Pad skin={skin} label="EDIT" size={50} on={build.editing} onDown={() => driver.press("KeyG")} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Pad
                skin={skin}
                icon={<PieceIcon kind="wall" />}
                label="WALL"
                size={62}
                round={false}
                on={build.kind === "wall"}
                onDown={() => pickPiece("wall")}
              />
              <Pad
                skin={skin}
                icon={<PieceIcon kind="floor" />}
                label="FLOOR"
                size={62}
                round={false}
                on={build.kind === "floor"}
                onDown={() => pickPiece("floor")}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Pad
                skin={skin}
                icon={<PieceIcon kind="ramp" />}
                label="RAMP"
                size={62}
                round={false}
                on={build.kind === "ramp"}
                onDown={() => pickPiece("ramp")}
              />
              <Pad
                skin={skin}
                icon={<PieceIcon kind="cone" />}
                label="CONE"
                size={62}
                round={false}
                on={build.kind === "cone"}
                onDown={() => pickPiece("cone")}
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <Pad skin={skin} label="JUMP" size={54} onDown={jump} onUp={() => driver.setFlag("jump", false)} />
              <Pad skin={skin} label="EXIT" sub="build" size={54} on onDown={toggleBuild} />
              {/* Held, not tapped: holding it is how you spam ramps up a
                  hill, which is the whole point of building on the move. */}
              <Pad skin={skin} label="PLACE" size={84} fontSize={13} {...hold("fire")} />
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <Pad skin={skin} label="RELOAD" size={46} fontSize={9} {...hold("reload")} />
              <Pad skin={skin} label="AIM" size={46} fontSize={9} {...hold("aim")} />
              <Pad skin={skin} label="SPRINT" size={46} fontSize={9} {...hold("sprint")} />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <Pad skin={skin} label="BUILD" size={58} onDown={toggleBuild} />
              <Pad skin={skin} label="JUMP" size={58} onDown={jump} onUp={() => driver.setFlag("jump", false)} />
              <Pad skin={skin} label="FIRE" size={84} fontSize={13} {...hold("fire")} />
            </div>
          </>
        )}
      </div>

      {/* ---- inventory strip --------------------------------------------
          Full width along the bottom edge: five slots plus the two water
          shortcuts, which are the items you reach for under pressure and
          never want to hunt for in a row of icons. -------------------- */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: `0 calc(env(safe-area-inset-right, 0px) + 6px) calc(env(safe-area-inset-bottom, 0px) + 6px) calc(env(safe-area-inset-left, 0px) + 6px)`,
          display: "flex",
          justifyContent: "center",
          gap: 4,
        }}
      >
        {slots.map((s) => (
          <Pad
            key={s.index}
            skin={skin}
            label={String(s.index)}
            sub={s.filled ? s.name.slice(0, 7) : ""}
            size={42}
            width={44}
            round={false}
            fontSize={12}
            on={s.active}
            style={{
              opacity: s.filled ? 1 : 0.45,
              // The rarity colour is the fastest read in a BR inventory; keep
              // it on the rim so the slot number stays legible.
              borderColor: s.filled
                ? `#${(s.color >>> 0).toString(16).padStart(6, "0")}`
                : skin.edge,
            }}
            onDown={() => driver.selectSlot(s.index)}
          />
        ))}
        {water && (
          <>
            <Pad
              skin={skin}
              label="BALL"
              sub={balloon ? String(balloon.count) : "—"}
              size={42}
              width={44}
              round={false}
              fontSize={10}
              on={balloon?.active ?? false}
              style={{ opacity: balloon ? 1 : 0.4 }}
              onDown={() => quickSlot(BALLOON_DEF)}
            />
            <Pad
              skin={skin}
              label="GLUE"
              sub={glue ? "ready" : "—"}
              size={42}
              width={44}
              round={false}
              fontSize={10}
              on={glue?.active ?? false}
              style={{ opacity: glue ? 1 : 0.4 }}
              onDown={() => quickSlot(GLUE_DEF)}
            />
          </>
        )}
      </div>
    </div>
  );
}
