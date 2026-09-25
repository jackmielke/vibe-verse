/**
 * A QR code as an SVG path, for the projector's "scan to join".
 *
 * The encoder is qrcode-generator, vendored in `vendor/qrcode.js`.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore vendored plain JS
import qrcode from "./vendor/qrcode.js";

export interface QrMatrix { size: number; dark(x: number, y: number): boolean }

export function qrMatrix(text: string, level: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
  const q = qrcode(0, level);
  q.addData(text);
  q.make();
  const size: number = q.getModuleCount();
  return { size, dark: (x, y) => q.isDark(y, x) };
}

/** One path of unit squares, `size` + 2×quiet modules across. */
export function qrPath(text: string, quiet = 2): { path: string; size: number } {
  const m = qrMatrix(text);
  let d = "";
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.dark(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return { path: d, size: m.size + quiet * 2 };
}
