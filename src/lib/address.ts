/**
 * Showing an address to a person. Nothing else.
 *
 * This exists as its own file for one reason: it has no dependencies, and the
 * module it used to live in (`vibe-wallet.ts`) pulls in viem's public client,
 * the Base chain definition and an ERC-20 ABI. The coin chip in the global nav
 * renders on every page in the app and wanted exactly one function from that
 * module — this one, four lines of string slicing — and paid about 700 kB for
 * it in the entry chunk.
 *
 * So: if a helper only formats, it belongs here rather than next to the code
 * that talks to a chain.
 */

/** Truncate a hex address for display, e.g. 0x7255…a7d1. */
export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
