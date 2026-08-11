/**
 * The Google sign-in helpers, tested at the two places they earn their keep.
 *
 * The OAuth call itself is three lines of Supabase and there is nothing to
 * test in it. What is worth pinning down is the handling around it: the error
 * string that means "nobody has configured this yet" — the single most
 * confusing state this feature has, because the button just does nothing — and
 * the return-path bookkeeping, which is a redirect loop and an open redirect
 * waiting to happen if it is sloppy.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  describeOAuthError,
  hasAuthPayload,
  readCallbackError,
  rememberReturnTo,
  takeReturnTo,
} from "@/lib/oauth";

beforeEach(() => {
  sessionStorage.clear();
});

describe("describeOAuthError", () => {
  it("turns the unconfigured-provider error into an instruction", () => {
    /* This is the exact string GoTrue returns when Google has no client ID and
       secret in the dashboard, which is the state the project is in until
       somebody does that once. If Supabase ever rephrases it this test fails,
       which is the point — the fallback is passing the raw message through,
       and "Unsupported provider" tells a person nothing about what to do. */
    const out = describeOAuthError("Unsupported provider: provider is not enabled");
    expect(out).toMatch(/not switched on/i);
    expect(out).toMatch(/docs\/social-sign-in\.md/);
  });

  it("points a redirect complaint at the allow list", () => {
    expect(describeOAuthError("redirect_to is not in the allow list")).toMatch(
      /allow list/i,
    );
  });

  it("passes anything else through untouched", () => {
    expect(describeOAuthError("Network request failed")).toBe("Network request failed");
  });
});

describe("readCallbackError", () => {
  it("reads the error out of the query string (PKCE)", () => {
    expect(
      readCallbackError("https://vibeverse.com/auth/callback?error=access_denied"),
    ).toBe("access_denied");
  });

  it("reads it out of the fragment (implicit), where the tokens also live", () => {
    expect(
      readCallbackError("https://vibeverse.com/auth/callback#error_description=Bad+state"),
    ).toBe("Bad state");
  });

  it("prefers the description, which is the half a human can read", () => {
    expect(
      readCallbackError(
        "https://vibeverse.com/auth/callback?error=server_error&error_description=Try+later",
      ),
    ).toBe("Try later");
  });

  it("is null on a clean callback", () => {
    expect(readCallbackError("https://vibeverse.com/auth/callback#access_token=abc")).toBeNull();
  });
});

describe("hasAuthPayload", () => {
  it("sees a PKCE code and an implicit token alike", () => {
    expect(hasAuthPayload("https://v.com/auth/callback?code=xyz")).toBe(true);
    expect(hasAuthPayload("https://v.com/auth/callback#access_token=xyz")).toBe(true);
  });

  it("is false for somebody who opened the callback route by hand", () => {
    // This is what sends that person home immediately instead of leaving them
    // watching a spinner until the give-up timer fires.
    expect(hasAuthPayload("https://v.com/auth/callback")).toBe(false);
  });
});

describe("return path", () => {
  it("brings you back to where you were", () => {
    rememberReturnTo("/kart?track=2");
    expect(takeReturnTo()).toBe("/kart?track=2");
  });

  it("is consumed once, so a later reload does not teleport you", () => {
    rememberReturnTo("/kart");
    takeReturnTo();
    expect(takeReturnTo()).toBe("/");
  });

  it("refuses an absolute URL, which would be an open redirect", () => {
    rememberReturnTo("https://evil.example/steal");
    expect(takeReturnTo()).toBe("/");
  });

  it("refuses a protocol-relative URL, which is the same trick with less typing", () => {
    rememberReturnTo("//evil.example/steal");
    expect(takeReturnTo()).toBe("/");
  });

  it("never sends you back into the callback, which would loop", () => {
    rememberReturnTo("/auth/callback");
    expect(takeReturnTo()).toBe("/");
  });
});
