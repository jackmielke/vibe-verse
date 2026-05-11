import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Pause, SkipForward, SkipBack, Shuffle, Music, Clock, Search, X,
} from "lucide-react";
import {
  loadSpotifySDK,
  getAccessToken,
  spotifyFetch,
  spotifyPut,
} from "@/lib/spotify";

// ---- Spotify SDK + Web API shapes (just what we touch) -----------
interface SpotifyPlayer {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  togglePlay: () => Promise<void>;
  nextTrack: () => Promise<void>;
  previousTrack: () => Promise<void>;
  addListener: (event: string, cb: (data: unknown) => void) => void;
}
interface SpotifySDK {
  Player: new (options: {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume: number;
  }) => SpotifyPlayer;
}
interface PlaybackTrack {
  name: string;
  uri: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
}
interface PlaybackState {
  paused: boolean;
  track_window: { current_track: PlaybackTrack };
}

interface ApiTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { release_date?: string; images: { url: string }[]; name: string };
}

interface SavedTrackRow {
  added_at: string;
  track: ApiTrack;
}

type ViewMode = "default" | "portal" | "search";

const LIKED_CACHE_KEY = "spotify.liked_tracks_cache_v1";
const LIKED_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

function decadeOf(release: string | undefined): number | null {
  if (!release) return null;
  const year = Number(release.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return Math.floor(year / 10) * 10;
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function SpotifyPlayer({ onClose }: { onClose?: () => void }) {
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [track, setTrack] = useState<PlaybackTrack | null>(null);
  const [paused, setPaused] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("default");

  // Time Portal state
  const [liked, setLiked] = useState<ApiTrack[]>([]);
  const [likedLoading, setLikedLoading] = useState(false);

  // Search state
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<ApiTrack[]>([]);

  useEffect(() => {
    let alive = true;
    let player: SpotifyPlayer | null = null;
    (async () => {
      await loadSpotifySDK();
      if (!alive) return;
      const SDK = (window as unknown as { Spotify: SpotifySDK }).Spotify;
      player = new SDK.Player({
        name: "Vibey 2.0 · Outer Space",
        getOAuthToken: async (cb) => {
          const token = await getAccessToken();
          if (token) cb(token);
        },
        volume: 0.5,
      });
      playerRef.current = player;

      player.addListener("ready", (data: unknown) =>
        setDeviceId((data as { device_id: string }).device_id),
      );
      player.addListener("not_ready", () => setDeviceId(null));
      player.addListener("player_state_changed", (state: unknown) => {
        if (!state) {
          setTrack(null);
          return;
        }
        const s = state as PlaybackState;
        setTrack(s.track_window.current_track);
        setPaused(s.paused);
      });
      player.addListener("authentication_error", () =>
        setError("Spotify auth expired — sign in again."),
      );
      player.addListener("account_error", () =>
        setError("Spotify Premium is required to play tracks here."),
      );

      const ok = await player.connect();
      if (!ok && alive) setError("Couldn't connect to Spotify Web Playback.");
    })();
    return () => {
      alive = false;
      player?.disconnect();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    spotifyPut("/me/player", { device_ids: [deviceId], play: false });
  }, [deviceId]);

  // ---- Shuffle Top Tracks ----------------------------------------
  async function shuffleTopTracks() {
    if (!deviceId) return;
    setBusy("shuffle");
    setError(null);
    try {
      const data = await spotifyFetch<{ items: ApiTrack[] }>(
        "/me/top/tracks?limit=30&time_range=medium_term",
      );
      const items = data?.items ?? [];
      if (items.length === 0) {
        setError("No top tracks yet — needs scope user-top-read. Sign out + back in to grant.");
        return;
      }
      const uris = shuffle(items.map((t) => t.uri)).slice(0, 20);
      const ok = await spotifyPut(`/me/player/play?device_id=${deviceId}`, { uris });
      if (!ok) setError("Play failed. Premium is required.");
    } finally {
      setBusy(null);
    }
  }

  // ---- Time Portal: fetch Liked Songs and bucket by decade ------
  async function loadLikedTracks() {
    // Cache hit?
    try {
      const raw = localStorage.getItem(LIKED_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: number; tracks: ApiTrack[] };
        if (Date.now() - parsed.at < LIKED_CACHE_TTL_MS) {
          setLiked(parsed.tracks);
          return parsed.tracks;
        }
      }
    } catch { /* ignore */ }

    setLikedLoading(true);
    setError(null);
    try {
      const all: ApiTrack[] = [];
      // Fetch up to 500 saved tracks (10 pages × 50). Plenty for the
      // decade portal without hammering Spotify.
      for (let page = 0; page < 10; page++) {
        const data = await spotifyFetch<{ items: SavedTrackRow[]; next: string | null }>(
          `/me/tracks?limit=50&offset=${page * 50}`,
        );
        const items = data?.items ?? [];
        if (items.length === 0) break;
        for (const row of items) all.push(row.track);
        if (!data?.next) break;
      }
      if (all.length === 0) {
        setError("Couldn't fetch your Liked Songs — needs scope user-library-read. Sign out + back in.");
        return [];
      }
      setLiked(all);
      try {
        localStorage.setItem(
          LIKED_CACHE_KEY,
          JSON.stringify({ at: Date.now(), tracks: all }),
        );
      } catch { /* quota */ }
      return all;
    } finally {
      setLikedLoading(false);
    }
  }

  // Decade → list of tracks bucket. Memoized so the Time Portal UI
  // re-renders quickly as the user clicks decades.
  const buckets = useMemo(() => {
    const m = new Map<number, ApiTrack[]>();
    for (const t of liked) {
      const d = decadeOf(t.album.release_date);
      if (d == null) continue;
      const arr = m.get(d) ?? [];
      arr.push(t);
      m.set(d, arr);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [liked]);

  async function playDecade(decade: number) {
    if (!deviceId) return;
    setBusy(`decade-${decade}`);
    setError(null);
    try {
      const tracks = (buckets.find(([d]) => d === decade) ?? [, []])[1] as ApiTrack[];
      const uris = shuffle(tracks.map((t) => t.uri)).slice(0, 30);
      const ok = await spotifyPut(`/me/player/play?device_id=${deviceId}`, { uris });
      if (!ok) setError("Play failed. Premium is required.");
    } finally {
      setBusy(null);
    }
  }

  // ---- Search ----------------------------------------------------
  useEffect(() => {
    if (view !== "search") return;
    if (query.trim().length < 2) {
      setSearchHits([]);
      return;
    }
    const t = window.setTimeout(async () => {
      const data = await spotifyFetch<{ tracks: { items: ApiTrack[] } }>(
        `/search?q=${encodeURIComponent(query)}&type=track&limit=8`,
      );
      setSearchHits(data?.tracks?.items ?? []);
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, view]);

  async function playUri(uri: string) {
    if (!deviceId) return;
    setBusy("playing");
    setError(null);
    try {
      const ok = await spotifyPut(`/me/player/play?device_id=${deviceId}`, {
        uris: [uri],
      });
      if (!ok) setError("Play failed. Premium is required.");
    } finally {
      setBusy(null);
    }
  }

  // ---- UI --------------------------------------------------------
  const albumArt = track?.album.images?.[0]?.url;
  const title = track?.name ?? "Nothing playing yet";
  const artist = track?.artists?.map((a) => a.name).join(", ") ?? "";

  return (
    <div className="glass-panel rounded-xl border border-primary/30 p-3 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
          Spotify Player
        </p>
        {onClose && (
          <button
            onClick={onClose}
            className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            Hide
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {albumArt ? (
          <img
            src={albumArt}
            alt={track?.album.name ?? "album art"}
            className="w-12 h-12 rounded-md border border-border/40"
          />
        ) : (
          <div className="w-12 h-12 rounded-md bg-primary/15 flex items-center justify-center">
            <Music className="w-5 h-5 text-primary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-heading font-semibold text-foreground truncate">
            {title}
          </p>
          <p className="text-[10px] text-muted-foreground truncate">{artist || "—"}</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => playerRef.current?.previousTrack()}
          className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
          disabled={!deviceId}
          title="Previous"
        >
          <SkipBack className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        <button
          onClick={() => playerRef.current?.togglePlay()}
          disabled={!deviceId}
          className="p-2 rounded-full bg-primary/15 hover:bg-primary/25 transition-colors disabled:opacity-50"
          title={paused ? "Play" : "Pause"}
        >
          {paused ? (
            <Play className="w-4 h-4 text-primary" />
          ) : (
            <Pause className="w-4 h-4 text-primary" />
          )}
        </button>
        <button
          onClick={() => playerRef.current?.nextTrack()}
          className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
          disabled={!deviceId}
          title="Next"
        >
          <SkipForward className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Mode-pick row: Shuffle Top · Time Portal · Search */}
      <div className="grid grid-cols-3 gap-1">
        <button
          onClick={() => {
            setView("default");
            shuffleTopTracks();
          }}
          disabled={!deviceId || busy === "shuffle"}
          className="rounded-md border border-primary/40 bg-primary/10 hover:bg-primary/20 transition-colors px-2 py-1.5 flex items-center justify-center gap-1 text-[10px] font-heading font-semibold tracking-widest uppercase text-primary disabled:opacity-50"
        >
          <Shuffle className="w-3 h-3" />
          {busy === "shuffle" ? "…" : "Shuffle"}
        </button>
        <button
          onClick={async () => {
            setView("portal");
            if (liked.length === 0) await loadLikedTracks();
          }}
          disabled={!deviceId}
          className={`rounded-md border transition-colors px-2 py-1.5 flex items-center justify-center gap-1 text-[10px] font-heading font-semibold tracking-widest uppercase ${
            view === "portal"
              ? "border-primary/60 bg-primary/20 text-primary"
              : "border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary"
          } disabled:opacity-50`}
        >
          <Clock className="w-3 h-3" />
          Portal
        </button>
        <button
          onClick={() => setView(view === "search" ? "default" : "search")}
          disabled={!deviceId}
          className={`rounded-md border transition-colors px-2 py-1.5 flex items-center justify-center gap-1 text-[10px] font-heading font-semibold tracking-widest uppercase ${
            view === "search"
              ? "border-primary/60 bg-primary/20 text-primary"
              : "border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary"
          } disabled:opacity-50`}
        >
          <Search className="w-3 h-3" />
          Search
        </button>
      </div>

      {/* Time Portal — decade buckets from Liked Songs */}
      {view === "portal" && (
        <div className="flex flex-col gap-1.5 pt-1">
          {likedLoading ? (
            <p className="text-[10.5px] text-muted-foreground italic">
              Pulling your Liked Songs…
            </p>
          ) : buckets.length === 0 ? (
            <p className="text-[10.5px] text-muted-foreground italic">
              No saved tracks found yet.
            </p>
          ) : (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground">
                Time portal · pick a decade from your Liked Songs
              </p>
              <div className="grid grid-cols-3 gap-1">
                {buckets.map(([decade, tracks]) => (
                  <button
                    key={decade}
                    onClick={() => playDecade(decade)}
                    disabled={busy === `decade-${decade}`}
                    className="flex flex-col items-center rounded-md border border-border/60 bg-background/40 hover:border-primary/50 hover:bg-primary/10 px-2 py-1.5 transition-colors disabled:opacity-50"
                  >
                    <span className="text-[12px] font-heading font-bold text-foreground leading-none">
                      {decade}s
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground tracking-wider mt-0.5">
                      {tracks.length}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Search — Spotify-wide track lookup */}
      {view === "search" && (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search any song…"
              className="w-full bg-background/40 border border-border/60 rounded-md pl-7 pr-7 py-1.5 text-[12px] focus:outline-none focus:border-primary/50"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {searchHits.length > 0 && (
            <div className="flex flex-col gap-0.5 max-h-[260px] overflow-y-auto">
              {searchHits.map((t) => (
                <button
                  key={t.uri}
                  onClick={() => playUri(t.uri)}
                  className="flex items-center gap-2 rounded-md hover:bg-muted/40 px-1.5 py-1 transition-colors text-left"
                >
                  {t.album.images?.[2]?.url ? (
                    <img
                      src={t.album.images[2].url}
                      alt=""
                      className="w-7 h-7 rounded-sm"
                    />
                  ) : (
                    <div className="w-7 h-7 rounded-sm bg-primary/15" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-heading font-semibold leading-tight truncate">
                      {t.name}
                    </p>
                    <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground truncate">
                      {t.artists.map((a) => a.name).join(", ")}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-[10.5px] text-destructive leading-snug">{error}</p>
      )}
      {!deviceId && !error && (
        <p className="text-[10px] text-muted-foreground italic">
          Connecting Spotify player…
        </p>
      )}
    </div>
  );
}
