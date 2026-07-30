/**
 * World-space markers, clamped to the screen edge.
 *
 * A fixed pool of DOM nodes is built once and then re-targeted every frame.
 * The alternative — mapping over a live list — would mount and unmount nodes
 * as the player turns, which is both a layout cost and a visual stutter as
 * markers pop rather than slide.
 *
 * Projection comes from `frame` via `projection.ts` rather than from the
 * THREE camera, so this layer works identically in photo mode.
 */
import { useRef } from "react";
import { LANDMARKS, type LandmarkDef } from "../../geo/sfGeo";
import { frame, sf } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText } from "../raf";
import { useUiStore } from "../uiStore";
import { makeProjected, project } from "../projection";
import { distance as fmtDistance } from "../format";
import { COLORS, cvdColor } from "../theme";

const MAX_SLOTS = 26;
const LANDMARK_SLOTS = 5;

type MarkerKind = "objective" | "waypoint" | "landmark" | "enemy" | "pickup";

interface Target {
  x: number;
  y: number;
  z: number;
  kind: MarkerKind;
  label: string;
  /** 0..1 extra emphasis. */
  weight: number;
}

/** Scratch targets — preallocated, never grown inside the loop. */
const targets: Target[] = Array.from({ length: MAX_SLOTS }, () => ({
  x: 0,
  y: 0,
  z: 0,
  kind: "landmark" as MarkerKind,
  label: "",
  weight: 0,
}));

const proj = makeProjected();

/** Nearest-N landmark scratch, so the sort never allocates. */
const lmScratch: { lm: LandmarkDef; d: number }[] = LANDMARKS.filter((l) => l.navpoint).map(
  (lm) => ({ lm, d: 0 }),
);

export default function WorldMarkers() {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const acc = useRef(0);

  const colors: Record<MarkerKind, string> = {
    objective: COLORS.signal,
    waypoint: cvdColor("info", cvd),
    landmark: "rgba(255,255,255,0.72)",
    enemy: cvdColor("danger", cvd),
    pickup: cvdColor("good", cvd),
  };

  useUiFrame((_, dt) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const px = frame.position.x;
    const pz = frame.position.z;
    const s = sf();
    const uiState = useUiStore.getState();

    let n = 0;

    // 1. Objectives — always first, always visible.
    for (const o of s.objectives) {
      if (o.complete || n >= MAX_SLOTS) continue;
      const t = targets[n++];
      t.x = o.x;
      t.y = o.y;
      t.z = o.z;
      t.kind = "objective";
      t.label = o.title;
      t.weight = o.id === uiState.trackedObjective ? 1 : 0.6;
    }

    // 2. The player's own waypoint.
    if (uiState.waypoint && n < MAX_SLOTS) {
      const t = targets[n++];
      t.x = uiState.waypoint.x;
      t.y = frame.position.y;
      t.z = uiState.waypoint.z;
      t.kind = "waypoint";
      t.label = uiState.waypoint.label;
      t.weight = 0.9;
    }

    // 3. Hostile contacts published by the AI system.
    const contacts = hudTelemetry.contacts;
    for (let i = 0; i < hudTelemetry.contactCount && n < MAX_SLOTS; i++) {
      const c = contacts[i];
      if (!c) continue;
      if (c.kind !== "enemy" && c.kind !== "police" && c.kind !== "pickup") continue;
      const t = targets[n++];
      t.x = c.x;
      t.y = frame.position.y + 1;
      t.z = c.z;
      t.kind = c.kind === "pickup" ? "pickup" : "enemy";
      t.label = "";
      t.weight = c.alert;
    }

    // 4. The nearest few landmarks, as quiet orientation aids. Partial
    //    selection sort — five passes over 16 entries beats a full sort.
    for (const e of lmScratch) e.d = Math.hypot(e.lm.x - px, e.lm.z - pz);
    for (let k = 0; k < LANDMARK_SLOTS && k < lmScratch.length; k++) {
      let best = k;
      for (let i = k + 1; i < lmScratch.length; i++) {
        if (lmScratch[i].d < lmScratch[best].d) best = i;
      }
      const tmp = lmScratch[k];
      lmScratch[k] = lmScratch[best];
      lmScratch[best] = tmp;
      if (n >= MAX_SLOTS) break;
      const lm = lmScratch[k].lm;
      const t = targets[n++];
      t.x = lm.x;
      t.y = lm.height * 0.85;
      t.z = lm.z;
      t.kind = "landmark";
      t.label = lm.name;
      t.weight = 0.3;
    }

    acc.current += dt;
    const refreshText = acc.current > 0.2;
    if (refreshText) acc.current = 0;

    for (let i = 0; i < MAX_SLOTS; i++) {
      const el = slotRefs.current[i];
      if (!el) continue;
      if (i >= n) {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }
      const t = targets[i];
      project(t.x, t.y, t.z, W, H, proj, 54);

      // Landmarks and contacts are only worth an edge arrow when they are
      // close or important; otherwise the screen border fills with clutter.
      if (proj.clamped && t.kind === "landmark") {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }
      if (el.style.display !== "block") el.style.display = "block";

      el.style.transform = `translate3d(${(proj.x - 60).toFixed(1)}px,${(proj.y - 30).toFixed(1)}px,0)`;

      // Fade with distance from the centre so the marker in front of you is
      // solid and the ones in the corner of your eye are hints.
      const base = t.kind === "landmark" ? 0.34 : 0.9;
      const fade = proj.clamped ? 0.85 : base + (1 - proj.offCentre) * (1 - base);
      el.style.opacity = Math.min(1, fade * (0.55 + 0.45 * t.weight)).toFixed(3);

      const arrow = el.querySelector<SVGElement>("[data-arrow]");
      if (arrow) {
        arrow.style.display = proj.clamped ? "block" : "none";
        arrow.style.transform = `rotate(${proj.edgeAngle.toFixed(1)}deg)`;
      }
      const glyphs = el.querySelectorAll<SVGElement>("[data-kind]");
      for (const g of Array.from(glyphs)) {
        const want = g.getAttribute("data-kind") === t.kind;
        const disp = want && !proj.clamped ? "block" : "none";
        if (g.style.display !== disp) g.style.display = disp;
      }

      const labelEl = el.querySelector<HTMLElement>("[data-label]");
      const distEl = el.querySelector<HTMLElement>("[data-dist]");
      if (refreshText) {
        if (labelEl) setText(labelEl, proj.clamped ? "" : t.label.toUpperCase());
        if (distEl) setText(distEl, fmtDistance(proj.distance));
      }
      if (labelEl) labelEl.style.color = colors[t.kind];
      if (distEl) distEl.style.opacity = t.kind === "landmark" ? "0.55" : "0.85";
      const tint = el.querySelector<HTMLElement>("[data-tint]");
      if (tint) tint.style.color = colors[t.kind];
    }
  });

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {Array.from({ length: MAX_SLOTS }, (_, i) => (
        <div
          key={i}
          ref={(el) => (slotRefs.current[i] = el)}
          className="absolute top-0 left-0 flex flex-col items-center"
          style={{ width: 120, display: "none", willChange: "transform" }}
        >
          <div data-tint="" style={{ color: COLORS.signal, height: 22 }}>
            <svg
              width={22}
              height={22}
              viewBox="0 0 22 22"
              style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.95))" }}
            >
              {/* Off-screen arrow — one shape for every marker kind, tinted. */}
              <g data-arrow="" style={{ display: "none", transformOrigin: "11px 11px" }}>
                <path d="M11 2 L18 17 L11 13 L4 17 Z" fill="currentColor" stroke="rgba(0,0,0,0.85)" strokeWidth={1} />
              </g>
              <g data-kind="objective" style={{ display: "none" }}>
                <path d="M11 3 L19 18 L3 18 Z" fill="none" stroke="currentColor" strokeWidth={2} />
                <circle cx={11} cy={13.5} r={2} fill="currentColor" />
              </g>
              <g data-kind="waypoint" style={{ display: "none" }}>
                <path d="M11 2 L20 11 L11 20 L2 11 Z" fill="none" stroke="currentColor" strokeWidth={2} />
                <circle cx={11} cy={11} r={2.2} fill="currentColor" />
              </g>
              <g data-kind="landmark" style={{ display: "none" }}>
                <rect x={6} y={6} width={10} height={10} fill="none" stroke="currentColor" strokeWidth={1.4} />
                <rect x={9.6} y={9.6} width={2.8} height={2.8} fill="currentColor" />
              </g>
              <g data-kind="enemy" style={{ display: "none" }}>
                <path d="M4 6 L11 3 L18 6 L11 19 Z" fill="none" stroke="currentColor" strokeWidth={2} />
              </g>
              <g data-kind="pickup" style={{ display: "none" }}>
                <circle cx={11} cy={11} r={5} fill="none" stroke="currentColor" strokeWidth={2} />
                <circle cx={11} cy={11} r={1.6} fill="currentColor" />
              </g>
            </svg>
          </div>
          <span
            data-label=""
            className="sf-label sf-text-hard"
            style={{ fontSize: 8, letterSpacing: "0.16em", whiteSpace: "nowrap", marginTop: 1 }}
          />
          <span
            data-dist=""
            className="sf-num sf-text-hard"
            style={{ fontSize: 9, color: "rgba(255,255,255,0.8)" }}
          />
        </div>
      ))}
    </div>
  );
}
