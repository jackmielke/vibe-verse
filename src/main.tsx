import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installGlobalErrorCapture } from "@/lib/errorLog";
import "./index.css";

// Catch async rejections + global runtime errors (things a React
// ErrorBoundary can't see) so nothing is lost silently.
installGlobalErrorCapture();

// Warm the floating-island GLB cache in parallel with React boot so the
// HubV2 hero renders without a pop-in even on a cold load.
import floatingIslandUrl from "@/assets/glb/floating-island.glb";
try { fetch(floatingIslandUrl, { cache: "force-cache" }); } catch { /* cache warm is best-effort */ }

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
