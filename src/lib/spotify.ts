/**
 * Spotify OAuth (PKCE flow) — browser-only, no client secret.
 *
 * Flow:
 *  1. user clicks Connect → generate verifier, redirect to Spotify
 *  2. Spotify bounces back to /auth/spotify?code=...
 *  3. callback page exchanges code+verifier for access_token
 *  4. token stored in localStorage; calls auto-refresh when stale
 *
 * The callback domain has to be one of the redirect URIs registered
 * on the Spotify dashboard. We use whichever matches the current
 * window.location.origin so dev preview and prod both work.
 */

export const SPOTIFY_CLIENT_ID = "cc4b1625ac38449bb4856011ef3356b3";

// Scopes — minimum we need to greet the user, read what they're
// listening to, and (Premium only) drive a Web Playback player.
export const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
  // Read user's top tracks/artists for the Shuffle button.
  "user-top-read",
  // Read user's saved tracks (Liked Songs) — powers the Time
  // Portal that filters by decade.
  "user-library-read",
].join(" ");

const VERIFIER_KEY = "spotify.code_verifier";
const TOKEN_KEY = "spotify.token";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
  scope: string;
  token_type: string;
}

// PKCE helpers — generate the verifier + S256 challenge per RFC 7636.
function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

function base64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** The redirect URI for the current host. Must match a registered URI. */
export function getRedirectUri(): string {
  return `${window.location.origin}/auth/spotify`;
}

/** Kicks off the auth flow. Throws the user at accounts.spotify.com. */
export async function loginWithSpotify(): Promise<void> {
  const verifier = randomString(64);
  const challenge = base64Url(await sha256(verifier));
  localStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SPOTIFY_SCOPES,
  });
  // Remember where we came from so the callback page can navigate back.
  localStorage.setItem("spotify.return_to", window.location.pathname);
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

/** Called by the callback page; exchanges the auth code for a token. */
export async function exchangeCodeForToken(code: string): Promise<void> {
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier — restart the flow");

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${await res.text()}`);
  }
  const data = await res.json();
  storeToken(data);
  localStorage.removeItem(VERIFIER_KEY);
}

function storeToken(data: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}) {
  const stored: StoredToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    token_type: data.token_type,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(stored));
}

function readStoredToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

/** Returns a valid access token, refreshing if expired. Null if not signed in. */
export async function getAccessToken(): Promise<string | null> {
  const stored = readStoredToken();
  if (!stored) return null;
  // Refresh if we're within 60s of expiry.
  if (Date.now() < stored.expires_at - 60_000) {
    return stored.access_token;
  }
  try {
    const body = new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      logout();
      return null;
    }
    const data = await res.json();
    // Spotify may not return a new refresh_token; keep the old one.
    storeToken({ refresh_token: stored.refresh_token, ...data });
    return data.access_token as string;
  } catch {
    return null;
  }
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(VERIFIER_KEY);
}

export function isConnected(): boolean {
  return !!readStoredToken();
}

/** Tiny helper for authenticated Spotify API calls. */
export async function spotifyFetch<T = unknown>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export interface SpotifyProfile {
  display_name: string | null;
  images?: { url: string }[];
  product?: "premium" | "free" | "open";
  email?: string;
}

/** Authenticated PUT to a Spotify Web API endpoint. Returns true on 2xx. */
export async function spotifyPut(path: string, body?: unknown): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok;
}

export async function spotifyPost(path: string, body?: unknown): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok;
}

/**
 * Load the Spotify Web Playback SDK script + initialize a Player
 * tied to our access token. Returns the device id once it's ready.
 *
 * The SDK requires Spotify Premium. Free accounts get a 401 when
 * trying to play tracks; we surface that with a friendly message.
 */
let sdkScriptPromise: Promise<void> | null = null;
export function loadSpotifySDK(): Promise<void> {
  if (sdkScriptPromise) return sdkScriptPromise;
  sdkScriptPromise = new Promise((resolve) => {
    if ((window as unknown as { Spotify?: unknown }).Spotify) {
      resolve();
      return;
    }
    (window as unknown as Record<string, unknown>).onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);
  });
  return sdkScriptPromise;
}
