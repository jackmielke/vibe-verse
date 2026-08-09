import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installGlobalErrorCapture } from "@/lib/errorLog";
import "./index.css";

// Catch async rejections + global runtime errors (things a React
// ErrorBoundary can't see) so nothing is lost silently.
installGlobalErrorCapture();

/**
 * Warm the floating-island GLB in parallel with React boot, so the hub's hero
 * renders without a pop-in on a cold load — but only on the four routes that
 * actually draw it.
 *
 * The gate is the whole point. That file is **40 MB**, and this used to run on
 * every page load of every route: somebody opening a card grid, or a link to a
 * 2D game, on a phone, on cellular, pulled forty megabytes they would never
 * look at — more than the entire JavaScript bundle, competing for bandwidth
 * with the thing they were actually waiting for. It was written when `/` was
 * the 3D hub. `/` has been the grid for a while now, and this did not notice.
 *
 * Kept as a literal set rather than read from the registry because the registry
 * describes worlds, and this is a fact about two pages: `HubV2` renders one
 * carousel slot as this model, and `Unit7Playground` stands on it.
 */
import floatingIslandUrl from "@/assets/glb/floating-island.glb";
const ISLAND_ROUTES = new Set(["/hub", "/lobby-3d", "/space", "/unit7"]);
if (ISLAND_ROUTES.has(window.location.pathname)) {
  try { fetch(floatingIslandUrl, { cache: "force-cache" }); } catch { /* cache warm is best-effort */ }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
