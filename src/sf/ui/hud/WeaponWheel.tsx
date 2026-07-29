/**
 * The weapon wheel.
 *
 * Held, not toggled: the wheel is a modal state you pass *through*, so it
 * opens on key-down, tracks the pointer, and commits on release. The pointer
 * does not need to reach a segment — only to point at one — because at the
 * moment you open this you are usually being shot at.
 *
 * Selection is by angle from the wheel centre with a dead zone in the middle,
 * which is how a thumbstick would drive it too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { sf, useSfStore } from "../../state/store";
import { keyFor, useUiStore } from "../uiStore";
import { WHEEL_ORDER, weaponUi } from "../weaponMeta";
import { COLORS, rgba } from "../theme";

const R_OUTER = 172;
const R_INNER = 74;
const DEAD_ZONE = 46;

function segPath(a0: number, a1: number, r0: number, r1: number): string {
  const p = (a: number, r: number): [number, number] => [
    Math.cos(a) * r,
    Math.sin(a) * r,
  ];
  const [x0, y0] = p(a0, r1);
  const [x1, y1] = p(a1, r1);
  const [x2, y2] = p(a1, r0);
  const [x3, y3] = p(a0, r0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return (
    `M ${x0.toFixed(2)} ${y0.toFixed(2)} ` +
    `A ${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
    `L ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
    `A ${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`
  );
}

export default function WeaponWheel() {
  const open = useUiStore((s) => s.wheelOpen);
  const setWheel = useUiStore((s) => s.setWheel);
  const current = useSfStore((s) => s.weapon);
  const setWeapon = useSfStore((s) => s.setWeapon);
  const [hover, setHover] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(-1);
  hoverRef.current = hover;

  const items = useMemo(() => WHEEL_ORDER.map((k) => weaponUi(k)), []);
  const n = items.length;
  const step = (Math.PI * 2) / n;
  // Rotate so segment 0 is centred at the top.
  const offset = -Math.PI / 2 - step / 2;

  // Seed the hover to whatever is equipped, so releasing immediately is a
  // no-op rather than an accidental swap.
  useEffect(() => {
    if (!open) return;
    const idx = items.findIndex((i) => i.key === current);
    setHover(idx >= 0 ? idx : -1);
  }, [open, current, items]);

  useEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      if (Math.hypot(dx, dy) < DEAD_ZONE) return; // keep the last choice
      let a = Math.atan2(dy, dx) - offset;
      a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      setHover(Math.floor(a / step) % n);
    };

    const commit = () => {
      const i = hoverRef.current;
      if (i >= 0 && items[i]) setWeapon(items[i].key);
      setWheel(false);
    };

    // Releasing the wheel key is the primary commit — the wheel is a held
    // state, and letting go is how you choose.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === keyFor("wheel") || e.code === "Escape") commit();
    };

    window.addEventListener("pointermove", onMove);
    // Any mouse button release commits too — the wheel is usually opened with
    // the same hand that is about to shoot.
    window.addEventListener("pointerup", commit);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [open, items, n, offset, step, setWeapon, setWheel]);

  if (!open) return null;

  const active = hover >= 0 ? items[hover] : null;
  const ammo = active ? sf().ammo[active.key] : undefined;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 sf-pe sf-anim-fade"
      style={{
        zIndex: 40,
        background:
          "radial-gradient(ellipse at center, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.74) 100%)",
        backdropFilter: "blur(3px) saturate(0.7)",
        WebkitBackdropFilter: "blur(3px) saturate(0.7)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute"
        style={{ left: "50%", top: "50%", transform: "translate(-50%,-50%)" }}
      >
        <svg
          width={R_OUTER * 2 + 40}
          height={R_OUTER * 2 + 40}
          viewBox={`${-R_OUTER - 20} ${-R_OUTER - 20} ${R_OUTER * 2 + 40} ${R_OUTER * 2 + 40}`}
        >
          {items.map((it, i) => {
            const a0 = offset + i * step + 0.012;
            const a1 = offset + (i + 1) * step - 0.012;
            const mid = (a0 + a1) / 2;
            const isHover = i === hover;
            const isCurrent = it.key === current;
            const rOut = isHover ? R_OUTER + 12 : R_OUTER;
            const ix = Math.cos(mid) * ((R_INNER + rOut) / 2);
            const iy = Math.sin(mid) * ((R_INNER + rOut) / 2);
            return (
              <g key={it.key}>
                <path
                  d={segPath(a0, a1, R_INNER, rOut)}
                  fill={isHover ? rgba(COLORS.signal, 0.22) : "rgba(8,10,14,0.72)"}
                  stroke={isHover ? COLORS.signal : "rgba(255,255,255,0.12)"}
                  strokeWidth={isHover ? 1.6 : 1}
                  style={{ transition: "fill 120ms var(--sf-ease)" }}
                />
                <g transform={`translate(${ix - 14},${iy - 20})`} opacity={isHover ? 1 : 0.62}>
                  <svg width={28} height={28} viewBox="0 0 24 24">
                    <path d={it.icon} fill={isHover ? "#fff" : "rgba(255,255,255,0.8)"} />
                  </svg>
                </g>
                <text
                  x={ix}
                  y={iy + 20}
                  textAnchor="middle"
                  style={{
                    fontFamily: "Sora, sans-serif",
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    fill: isHover ? "#fff" : "rgba(255,255,255,0.55)",
                  }}
                >
                  {it.short.toUpperCase()}
                </text>
                {isCurrent && (
                  <circle
                    cx={Math.cos(mid) * (R_INNER + 8)}
                    cy={Math.sin(mid) * (R_INNER + 8)}
                    r={2.5}
                    fill={COLORS.signal}
                  />
                )}
                <text
                  x={Math.cos(mid) * (rOut - 12)}
                  y={Math.sin(mid) * (rOut - 12) + 3}
                  textAnchor="middle"
                  style={{
                    fontFamily: "Sora, sans-serif",
                    fontSize: 9,
                    fontWeight: 700,
                    fill: "rgba(255,255,255,0.35)",
                  }}
                >
                  {it.slot % 10}
                </text>
              </g>
            );
          })}
          <circle r={R_INNER - 4} fill="rgba(5,6,10,0.86)" stroke="rgba(255,255,255,0.12)" />
        </svg>

        {/* Hub */}
        <div
          className="absolute flex flex-col items-center justify-center text-center"
          style={{
            left: "50%",
            top: "50%",
            width: (R_INNER - 8) * 2,
            transform: "translate(-50%,-50%)",
          }}
        >
          <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.26em" }}>
            {active ? active.cls.toUpperCase() : "SELECT"}
          </span>
          <span
            className="sf-display"
            style={{ fontSize: 15, marginTop: 3, lineHeight: 1.1, color: "#fff" }}
          >
            {active ? active.name : "—"}
          </span>
          {active && (
            <span className="sf-num" style={{ fontSize: 12, marginTop: 6, color: COLORS.signal }}>
              {ammo ? `${ammo.magazine} / ${ammo.reserve}` : `${active.magazine} RD`}
            </span>
          )}
        </div>
      </div>

      {/* Blurb rail — designer voice, bottom of the screen, never over the wheel. */}
      {active?.blurb && (
        <div
          className="absolute sf-anim-rise"
          style={{ left: "50%", bottom: 96, transform: "translateX(-50%)", maxWidth: 520 }}
        >
          <p
            className="sf-text text-center"
            style={{ fontSize: 12, color: "rgba(255,255,255,0.62)", lineHeight: 1.5 }}
          >
            {active.blurb}
          </p>
        </div>
      )}
    </div>
  );
}
