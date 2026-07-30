/**
 * ai/Pedestrians.tsx — the crowd, on screen.
 *
 * All this component does is own the instanced character batch and put it in
 * the scene. The simulation runs in `pedestrians.ts` and is driven by the AI
 * root, because pedestrians, soldiers and police all write into the *same*
 * batch and the begin/push/commit cycle has to happen exactly once per frame
 * across all three. Splitting that across three components' `useFrame`
 * callbacks would work right up until someone reorders the JSX.
 *
 * Mounting this component is therefore what makes people *visible*; mounting
 * `<CityAI />` is what makes them *exist*.
 */
import { useEffect, useMemo } from "react";
import { characterBatch } from "./stage";

export interface PedestriansProps {
  /** Distance at which a body drops to the low-detail mesh, metres. */
  lodDistance?: number;
  /** Cast shadows. Off is a genuine win on the low tier. */
  shadows?: boolean;
}

export default function Pedestrians({ lodDistance = 55, shadows = true }: PedestriansProps) {
  const batch = useMemo(() => characterBatch(), []);

  useEffect(() => {
    batch.setLodDistance(lodDistance);
  }, [batch, lodDistance]);

  useEffect(() => {
    batch.group.traverse((o) => {
      const m = o as { castShadow?: boolean; receiveShadow?: boolean };
      if (m.castShadow !== undefined) m.castShadow = shadows;
      if (m.receiveShadow !== undefined) m.receiveShadow = shadows;
    });
  }, [batch, shadows]);

  return <primitive object={batch.group} />;
}
