import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipForward, SkipBack, Shuffle, Music } from "lucide-react";
import {
  loadSpotifySDK,
  getAccessToken,
  spotifyFetch,
  spotifyPut,
} from "@/lib/spotify";

// Minimal types for the Web Playback SDK we use here. Subset of the
// official shape — no need to install @types/spotify-web-playback-sdk.
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

interface TopTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
}

export default function SpotifyPlayer({
  onClose,
}: {
  onClose?: () => void;
}) {
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [track, setTrack] = useState<PlaybackTrack | null>(null);
  const [paused, setPaused] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [shuffling, setShuffling] = useState(false);

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

      player.addListener("ready", (data: unknown) => {
        const id = (data as { device_id: string }).device_id;
        setDeviceId(id);
      });
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
      player.addListener("initialization_error", (e: unknown) => {
        setError((e as { message: string }).message);
      });
      player.addListener("authentication_error", () => {
        setError("Spotify auth expired — sign in again.");
      });
      player.addListener("account_error", () => {
        setError("Spotify Premium is required to play tracks here.");
      });

      const ok = await player.connect();
      if (!ok && alive) setError("Couldn't connect to Spotify Web Playback.");
    })();
    return () => {
      alive = false;
      player?.disconnect();
      playerRef.current = null;
    };
  }, []);

  // Once the device is ready, transfer playback to it (so commands
  // route to this browser tab instead of e.g. a phone).
  useEffect(() => {
    if (!deviceId) return;
    spotifyPut("/me/player", { device_ids: [deviceId], play: false });
  }, [deviceId]);

  async function shuffleTopTracks() {
    if (!deviceId) return;
    setShuffling(true);
    try {
      const data = await spotifyFetch<{ items: TopTrack[] }>(
        "/me/top/tracks?limit=30&time_range=medium_term",
      );
      const items = data?.items ?? [];
      if (items.length === 0) {
        setError("Couldn't fetch top tracks. Listen to more music on Spotify first?");
        return;
      }
      // Fisher–Yates shuffle the URIs.
      const uris = items.map((t) => t.uri);
      for (let i = uris.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [uris[i], uris[j]] = [uris[j], uris[i]];
      }
      const ok = await spotifyPut(`/me/player/play?device_id=${deviceId}`, {
        uris: uris.slice(0, 20),
      });
      if (!ok) {
        setError("Play failed. Premium is required for SDK playback.");
      }
    } finally {
      setShuffling(false);
    }
  }

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
        <button
          onClick={shuffleTopTracks}
          disabled={!deviceId || shuffling}
          className="ml-auto rounded-md border border-primary/40 bg-primary/10 hover:bg-primary/20 transition-colors px-2.5 py-1 flex items-center gap-1.5 text-[10px] font-heading font-semibold tracking-widest uppercase text-primary disabled:opacity-50"
          title="Shuffle 20 of your top tracks"
        >
          <Shuffle className="w-3 h-3" />
          {shuffling ? "Loading…" : "Shuffle Top"}
        </button>
      </div>

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
