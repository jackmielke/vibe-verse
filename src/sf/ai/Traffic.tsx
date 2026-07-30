/**
 * ai/Traffic.tsx — the rolling stock, on screen.
 *
 * Thirteen instanced meshes plus the air wing, all sharing one material. As
 * with the crowd, the *simulation* is driven from the AI root; this component
 * only owns the batches and their scene graph presence, so that mounting and
 * unmounting the renderer never disturbs the sim's ordering.
 *
 * Headlights come on with the sun, not with a magic number: the same
 * `frame.timeOfDay` the sky reads decides when two hundred pairs of tail lights
 * appear on Van Ness.
 */
import { useEffect, useMemo } from "react";
import { helicopterBatch, vehicleBatch } from "./stage";

export interface TrafficProps {
  shadows?: boolean;
}

/**
 * 0..1 headlight factor for a given hour. Dusk is a ramp, not a switch: lights
 * come on across civil twilight, roughly 16:36–18:24, and go off 05:54–07:24.
 */
export function headlightFactor(hour: number): number {
  const evening = smooth(16.6, 18.4, hour);
  const morning = 1 - smooth(5.9, 7.4, hour);
  return Math.max(0, Math.min(1, Math.max(evening, morning)));
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export default function Traffic({ shadows = true }: TrafficProps) {
  const vb = useMemo(() => vehicleBatch(), []);
  const hb = useMemo(() => helicopterBatch(), []);

  useEffect(() => {
    vb.group.traverse((o) => {
      const m = o as { castShadow?: boolean; receiveShadow?: boolean };
      if (m.castShadow !== undefined) m.castShadow = shadows;
      if (m.receiveShadow !== undefined) m.receiveShadow = shadows;
    });
    hb.mesh.castShadow = shadows;
  }, [vb, hb, shadows]);

  // Lamp brightness is per instance, not per material: the AI driver writes
  // `headlightFactor(frame.timeOfDay)` into each vehicle's lamp channel, which
  // is what lets an emergency vehicle run its headlights at noon.
  return (
    <>
      <primitive object={vb.group} />
      <primitive object={hb.mesh} />
    </>
  );
}
