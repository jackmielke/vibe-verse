/**
 * Continue with Google — and the same three lines for anybody else.
 *
 * The OAuth call itself is trivial; everything in this file is about the two
 * ways it fails in production, both of which produce a blank stare rather than
 * an error if you do not handle them.
 *
 * ## Failure one: the provider is not turned on
 *
 * Google OAuth needs a client ID and secret from the Google Cloud console
 * pasted into Supabase's dashboard. Until that happens `signInWithOAuth`
 * returns — it does not throw, and it does not redirect — with an error that
 * says "Unsupported provider". A button that silently does nothing is the
 * single most confusing state this feature has, so `describeOAuthError` turns
 * that one into a sentence that names the fix. `docs/social-sign-in.md` is the
 * fix, in order.
 *
 * ## Failure two: the redirect comes back somewhere unexpected
 *
 * Google returns to Supabase, which returns to us at `redirectTo` — but only
 * if that URL is in the project's allow list. An unlisted one silently becomes
 * the project's Site URL, so a preview deploy sends you home to production and
 * you appear to be signed out. Same fix, same doc.
 *
 * So **everything here comes back to `/auth/callback`** and stashes where the
 * visitor actually was. That is the whole reason this file exists rather than
 * two call sites each passing `window.location.href`: an allow list with one
 * entry per page is an allow list somebody will forget to add a page to, and
 * `window.location.href` carries query strings that will not match it anyway.
 * One path, listed once per origin, forever.
 */
import { supabase } from "@/integrations/supabase/client";

/** Providers the project offers, or intends to. */
export type OAuthProvider = "google" | "github";

/** Where to put the visitor back once Google is done with them. */
const RETURN_KEY = "vibe.auth.returnTo";

/** The one path that has to be in Supabase's redirect allow list. */
export const OAUTH_CALLBACK_PATH = "/auth/callback";

/** The one URL that has to be in Supabase's redirect allow list, per origin. */
export function oauthRedirectTo(): string {
  return `${window.location.origin}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Remember where we were, and hand off to the provider.
 *
 * Resolves only if the hand-off failed — on success the browser is already
 * navigating away and nothing after this runs.
 */
export async function signInWithProvider(
  provider: OAuthProvider,
  returnTo?: string,
): Promise<void> {
  rememberReturnTo(returnTo ?? window.location.pathname + window.location.search);

  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: oauthRedirectTo(),
      /* Without this, Google silently reuses the one session in the browser.
         That is the wrong default for a shared laptop at an event, and it is
         the reason "sign out and sign in as someone else" appears broken. */
      ...(provider === "google" ? { queryParams: { prompt: "select_account" } } : {}),
    },
  });

  if (error) throw new Error(describeOAuthError(error.message));
}

/** The named door, for the dialog. */
export const signInWithGoogle = (returnTo?: string) => signInWithProvider("google", returnTo);

/**
 * Add a provider to the account somebody is already signed into.
 *
 * Same redirect, same allow list, same callback — which is the point. The
 * callback finds a session already in place (theirs, unchanged) and hands
 * straight back, so linking looks like a round trip rather than a login.
 */
export async function linkProviderIdentity(
  provider: OAuthProvider,
  returnTo?: string,
): Promise<void> {
  rememberReturnTo(returnTo ?? window.location.pathname + window.location.search);

  const { error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo: oauthRedirectTo() },
  });

  if (error) throw new Error(describeOAuthError(error.message));
}

/**
 * Turn a GoTrue OAuth error into something with a next step in it.
 *
 * Kept pure and exported so it can be tested without a browser: the string
 * Supabase returns for an unconfigured provider is the one message this whole
 * feature hinges on, and it is worth a test that notices if it drifts.
 */
export function describeOAuthError(message: string): string {
  if (/unsupported provider|provider is not enabled|not enabled/i.test(message)) {
    return (
      "That sign-in provider is not switched on for this project yet. " +
      "Enable it under Authentication → Providers in the Supabase dashboard " +
      "(see docs/social-sign-in.md) and it will work here with no code change."
    );
  }
  if (/redirect|allow list|allowlist/i.test(message)) {
    return `${message} — add this origin to the Supabase redirect allow list (see docs/social-sign-in.md).`;
  }
  return message;
}

/**
 * The error Google sent back on the callback, if it sent one.
 *
 * It arrives in the query string on the PKCE flow and in the fragment on the
 * implicit one, and which flow you are on depends on a client option that is
 * easy to change without thinking about this file — so read both rather than
 * betting on either.
 */
export function readCallbackError(url = window.location.href): string | null {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const err =
    parsed.searchParams.get("error_description") ??
    parsed.searchParams.get("error") ??
    hash.get("error_description") ??
    hash.get("error");
  return err ? err.replace(/\+/g, " ") : null;
}

/**
 * Does this callback URL carry a session for the client to pick up?
 *
 * Distinguishes "still loading, wait for it" from "there was never anything
 * here" — which is what somebody who opens `/auth/callback` directly, or comes
 * back on a stale bookmark, actually hit. Without it that person watches a
 * spinner until the timeout instead of being sent home.
 */
export function hasAuthPayload(url = window.location.href): boolean {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  return Boolean(
    parsed.searchParams.get("code") ||
      hash.get("access_token") ||
      parsed.searchParams.get("token_hash") ||
      hash.get("error") ||
      parsed.searchParams.get("error"),
  );
}

export function rememberReturnTo(path: string): void {
  try {
    // Same-origin paths only. A full URL here would be an open redirect with
    // extra steps, and there is no reason to ever want one.
    if (path.startsWith("/") && !path.startsWith("//")) {
      sessionStorage.setItem(RETURN_KEY, path);
    }
  } catch {
    /* Private mode. We land on the lobby instead, which is a fine place. */
  }
}

/** Where to go after a successful sign-in. Consumed once. */
export function takeReturnTo(fallback = "/"): string {
  try {
    const stored = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (stored?.startsWith("/") && !stored.startsWith("//")) {
      // Never bounce straight back into the callback — that is a redirect loop.
      return stored.startsWith(OAUTH_CALLBACK_PATH) ? fallback : stored;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}
