/**
 * Your own music at the Vibe Bowl, through Spotify's embed player.
 *
 * The embed needs no developer app, no client id and no login flow of ours:
 * paste a link to a playlist, album, track, artist, episode or show, and
 * Spotify's own player plays it. Somebody signed in to Spotify in this
 * browser hears whole tracks (Premium) or Spotify's free experience; anybody
 * else hears 30-second previews. The band mimes along quietly while it plays,
 * because an iframe's audio cannot be heard by the page and so the lights
 * cannot follow it; they keep the city's beat instead.
 *
 * (Playing a player's library straight into the world, with the lights on
 * their tracks, would be the Web Playback SDK, which needs a Spotify developer
 * app and a sign-in. That is a step for later, not a requirement for this.)
 */

const KINDS = ["playlist", "album", "track", "artist", "episode", "show"] as const;
export type SpotifyKind = (typeof KINDS)[number];

export interface SpotifyPick {
  kind: SpotifyKind;
  id: string;
  /** What goes in the iframe's src. */
  embed: string;
}

const ID = /^[A-Za-z0-9]{10,32}$/;

/**
 * Turn anything a person might paste into an embed: an open.spotify.com link
 * (with or without `/intl-xx/`, query strings, `/embed/`), or a `spotify:` URI.
 * Returns null for anything else, so the page never frames a URL it was handed.
 */
export function parseSpotify(input: string): SpotifyPick | null {
  const s = input.trim();
  if (!s) return null;
  let kind: string | undefined;
  let id: string | undefined;
  const uri = s.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/);
  if (uri) {
    kind = uri[1];
    id = uri[2];
  } else {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (u.hostname !== "open.spotify.com") return null;
    const parts = u.pathname.split("/").filter(Boolean).filter((p) => !/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(p) && p !== "embed");
    kind = parts[0];
    id = parts[1];
  }
  if (!kind || !id || !(KINDS as readonly string[]).includes(kind) || !ID.test(id)) return null;
  return { kind: kind as SpotifyKind, id, embed: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator&theme=0` };
}

const KEY = "city.concert.spotify";

export function savedSpotify(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSpotify(link: string) {
  try {
    if (link) localStorage.setItem(KEY, link);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: it just will not be remembered */
  }
}
