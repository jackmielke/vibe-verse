import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordError } from "@/lib/errorLog";

/** The friendly fallback shown when a render crash is caught — exported
 *  on its own so it can be previewed/verified without forcing a crash. */
/** Detect the "browser/device couldn't start 3D" family of crashes so we can
 *  give real guidance instead of "just reload" (which won't help if WebGL is
 *  unavailable). Covers Three.js/R3F context-creation + context-loss errors. */
function isWebGLError(error?: Error | null): boolean {
  return /webgl|creating .*context|context (lost|creation)|gpu/i.test(error?.message ?? "");
}

export function ErrorFallback({ error, onReload }: { error?: Error | null; onReload?: () => void }) {
  const webgl = isWebGLError(error);
  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-5 p-6 text-center"
      style={{ background: "radial-gradient(120% 100% at 50% 0%, #16233a 0%, #0b1220 60%, #070b14 100%)" }}
    >
      <div className="text-5xl" aria-hidden>{webgl ? "🖥️" : "🌧️"}</div>
      <div className="max-w-sm">
        <h1 className="font-heading text-xl font-semibold tracking-wide text-white">
          {webgl ? "This device couldn't start 3D" : "A corner of the VibeVerse glitched"}
        </h1>
        <p className="mt-2 text-sm text-white/60">
          {webgl
            ? "The VibeVerse runs on WebGL. Try turning on hardware acceleration in your browser settings, closing a few other tabs, or opening it in Chrome or Safari — then try again."
            : "Something hiccuped and this view stopped. A quick reload usually clears the weather."}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => (onReload ? onReload() : window.location.reload())}
          className="rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_hsl(var(--primary)/0.5)] transition-transform active:scale-95"
        >
          {webgl ? "↻ Try again" : "↻ Reload"}
        </button>
        <a
          href="/"
          className="rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          Back to start
        </a>
      </div>
      {error?.message && (
        <p className="mt-1 max-w-sm truncate text-[11px] text-white/25" title={error.message}>
          {error.message}
        </p>
      )}
    </div>
  );
}

interface State {
  error: Error | null;
}

/** Top-level boundary so a render crash shows a friendly reload screen
 *  instead of a blank white page. Records the crash via the shared
 *  errorLog (console + sessionStorage) for later forwarding to the loop. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordError("render", error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}
