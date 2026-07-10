import { supabase } from "@/integrations/supabase/client";

/**
 * One capture path for every kind of client error — React render crashes
 * (via ErrorBoundary), unhandled promise rejections, and global runtime
 * errors. Keeps a rolling list in sessionStorage (inspectable when
 * debugging a session), logs to console, and best-effort forwards to the
 * public.client_errors table so the autonomous build loop can read and
 * triage real user crashes — the "loop learns from users" sink.
 */
export interface CapturedError {
  kind: "render" | "error" | "unhandledrejection";
  message: string;
  stack?: string;
  extra?: string;
  at: string;
  url: string;
}

const KEY = "vibe.errors";
const MAX = 20;

export function recordError(kind: CapturedError["kind"], err: unknown, extra?: string): void {
  const e = err as { message?: string; stack?: string } | null;
  const entry: CapturedError = {
    kind,
    message: String(e?.message ?? err ?? "unknown error").slice(0, 500),
    stack: e?.stack?.slice(0, 2000),
    extra: extra?.slice(0, 2000),
    at: new Date().toISOString(),
    url: typeof window !== "undefined" ? window.location.href : "",
  };
  try {
    console.error(`[VibeVerse:${kind}]`, entry.message, err);
  } catch {
    /* console may be unavailable */
  }
  try {
    const raw = sessionStorage.getItem(KEY);
    const list: CapturedError[] = raw ? JSON.parse(raw) : [];
    list.push(entry);
    while (list.length > MAX) list.shift();
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable in private mode */
  }
  // Best-effort forward to the build loop's sink. Fully fire-and-forget:
  // the .catch swallows failures (offline / blocked) so reporting an error
  // can never itself throw or spawn another unhandled rejection.
  try {
    void supabase
      .from("client_errors")
      .insert({
        kind: entry.kind,
        message: entry.message,
        stack: entry.stack,
        extra: entry.extra,
        url: entry.url,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 300) : null,
      })
      .then(
        () => {},
        () => {},
      );
  } catch {
    /* client unavailable — the sessionStorage copy still exists */
  }
}

/**
 * Register global listeners for errors an ErrorBoundary can't catch —
 * async promise rejections and non-React runtime errors. Passive: it only
 * records and never calls preventDefault, so the browser's normal error
 * reporting still happens.
 */
export function installGlobalErrorCapture(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (ev) => {
    recordError(
      "error",
      ev.error ?? new Error(ev.message),
      ev.filename ? `${ev.filename}:${ev.lineno ?? "?"}` : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (ev) => {
    recordError("unhandledrejection", ev.reason ?? new Error("unhandled rejection"));
  });
}
