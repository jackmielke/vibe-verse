/**
 * The one crash a continuously-deployed SPA gives itself.
 *
 * ## What happens
 *
 * Every route in `App.tsx` is `lazy()`, so opening a world fetches a chunk by
 * its content-hashed filename — `SanPalmas-CMTPbMrg.js`. Those filenames are
 * baked into the JavaScript the browser is already running. Deploy again and
 * the hashes change and the old files stop being served, so a tab that was
 * opened before the deploy is holding a map to files that no longer exist. The
 * page it is on keeps working perfectly. The moment somebody clicks through to
 * a world they have not visited yet, the import 404s and the route dies.
 *
 * `main` here deploys on every push, and pushes are frequent, so the window
 * where a tab is stale is not a corner case — it is most afternoons.
 *
 * ## What to do about it
 *
 * Reload. A full reload re-fetches `index.html`, which points at the new
 * filenames, and the click that failed works on the second try. That is the
 * whole fix, and it is safe *because* the failure is so specific: the app was
 * running fine a second ago and one file is missing.
 *
 * The only real hazard is a reload loop — if the chunk is missing for some
 * other reason (offline, a proxy eating it, a genuinely broken deploy), the
 * reload fails the same way and we would spin forever. So it is once per
 * minute, remembered in `sessionStorage`; a second failure inside that window
 * falls through to the error screen, which tells the visitor what happened and
 * leaves the decision to them.
 */

/**
 * Does this look like "the file I asked for is not there any more"?
 *
 * Every engine words it differently and none of them use an error class we can
 * check with `instanceof`, so it is string matching or nothing. Kept narrow on
 * purpose — a false positive here reloads the page under somebody, which is a
 * worse experience than the error screen it is trying to avoid.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message ?? error ?? "");
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /* A host that serves the SPA's index.html for a missing asset — which is
       every SPA host, including ours — turns a 404 into a MIME type refusal
       rather than a network error. Same cause, unrecognisable wording. */
    /failed to load module script/i.test(message) ||
    /ChunkLoadError/i.test(message)
  );
}

const KEY = "vibe.staleChunkReload.v1";

/** How long a reload counts as "we already tried that". */
export const RELOAD_COOLDOWN_MS = 60_000;

/**
 * Claim the right to reload, or report that we just did.
 *
 * Returns true at most once per cooldown. Split out from the reload itself so
 * the decision is testable without a jsdom that can navigate.
 */
export function claimStaleChunkReload(now: number = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    /* `null` means we have never reloaded, which is not the same as having
       reloaded at time zero — read as a number, that would put every clock
       inside the cooldown of the epoch. */
    const last = raw === null ? null : Number(raw);
    if (last !== null && Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(KEY, String(now));
    return true;
  } catch {
    /* Private mode, or storage disabled. Without somewhere to remember the
       attempt there is no way to bound a loop, so do not start one. */
    return false;
  }
}
