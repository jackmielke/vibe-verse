import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./index.css";

// Warm the floating-island GLB cache in parallel with React boot so the
// HubV2 hero renders without a pop-in even on a cold load.
import floatingIslandUrl from "@/assets/glb/floating-island.glb";
try { fetch(floatingIslandUrl, { cache: "force-cache" }); } catch { /* cache warm is best-effort */ }

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
