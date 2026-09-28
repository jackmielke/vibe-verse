/** A QR code drawn as one SVG path, for a projector's "scan to join". */
import { useMemo } from "react";
import { qrPath } from "@/lib/qr";

export function QrCode({ text, size }: { text: string; size: number }) {
  const { path, size: n } = useMemo(() => qrPath(text, 2), [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <path d={path} fill="#16121f" />
    </svg>
  );
}
