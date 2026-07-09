import { Component, type ErrorInfo, type ReactNode } from "react";

/** The friendly fallback shown when a render crash is caught — exported
 *  on its own so it can be previewed/verified without forcing a crash. */
export function ErrorFallback({ error, onReload }: { error?: Error | null; onReload?: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-5 p-6 text-center"
      style={{ background: "radial-gradient(120% 100% at 50% 0%, #16233a 0%, #0b1220 60%, #070b14 100%)" }}
    >
      <div className="text-5xl" aria-hidden>🌧️</div>
      <div className="max-w-sm">
        <h1 className="font-heading text-xl font-semibold tracking-wide text-white">
          A corner of the VibeVerse glitched
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Something hiccuped and this view stopped. A quick reload usually clears the weather.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => (onReload ? onReload() : window.location.reload())}
          className="rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_hsl(var(--primary)/0.5)] transition-transform active:scale-95"
        >
          ↻ Reload
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
 *  instead of a blank white page. Also records the error (console +
 *  sessionStorage) so it can later be forwarded to the build loop. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[VibeVerse] render crash caught by ErrorBoundary:", error, info);
    try {
      sessionStorage.setItem(
        "vibe.lastError",
        JSON.stringify({
          message: error.message,
          stack: error.stack?.slice(0, 2000),
          componentStack: info.componentStack?.slice(0, 2000),
          at: new Date().toISOString(),
          url: window.location.href,
        }),
      );
    } catch {
      /* storage may be unavailable in private mode */
    }
    // TODO(loop-learns-from-users): forward to Supabase so the build loop
    // can triage real crashes. Needs a client_errors sink first.
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}
