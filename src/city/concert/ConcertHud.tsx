/**
 * What the Vibe Bowl puts on screen while you are at the show: a small
 * "now playing" card (with the way to put your own Spotify on), and, up on
 * the stage, the solo button.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NowPlaying } from "./index";
import { parseSpotify, saveSpotify, savedSpotify, type SpotifyPick } from "./spotify";

const SECTION: Record<string, string> = {
  intro: "Intro",
  verse: "Verse",
  chorus: "Chorus",
  bridge: "Bridge",
  solo: "Guitar solo",
  outro: "Outro",
};

export function ConcertHud(props: {
  now: NowPlaying;
  onStage: boolean;
  isTouch: boolean;
  onSolo: () => void;
  onExternal: (on: boolean) => void;
}) {
  const { now, onStage, isTouch, onSolo, onExternal } = props;
  const [sheet, setSheet] = useState(false);
  const [link, setLink] = useState(savedSpotify);
  const [pick, setPick] = useState<SpotifyPick | null>(null);
  const [error, setError] = useState("");

  const external = useRef(onExternal);
  external.current = onExternal;
  useEffect(() => {
    external.current(!!pick);
  }, [pick]);
  // Walking away from the show stops your music with it.
  useEffect(() => () => external.current(false), []);

  const play = () => {
    const p = parseSpotify(link);
    if (!p) {
      setError("That does not look like a Spotify link. Try Share, then Copy link, on a playlist, album or song.");
      return;
    }
    setError("");
    saveSpotify(link.trim());
    setPick(p);
    setSheet(false);
  };

  const card = (
    <div
      data-concert-now
      className="fixed left-1/2 -translate-x-1/2 top-[4.25rem] z-30 pointer-events-auto w-[min(92vw,360px)] rounded-2xl border border-fuchsia-300/40 bg-[rgba(10,6,24,0.72)] backdrop-blur-md text-white shadow-[0_0_28px_rgba(155,92,255,0.45)]"
    >
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="text-2xl leading-none">{pick ? "🎧" : now.inBreak ? "👏" : "🎤"}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-200/80">{now.venue} · Live</div>
          {pick ? (
            <div className="text-sm font-semibold truncate">Your Spotify is on</div>
          ) : now.inBreak ? (
            <div className="text-sm font-semibold truncate">
              Next up: {now.next} <span className="text-white/60 font-normal">in {Math.max(1, Math.round(now.nextIn))}s</span>
            </div>
          ) : (
            <div className="text-sm font-semibold truncate">
              {now.title} <span className="text-white/60 font-normal">· {now.band}</span>
            </div>
          )}
          {!pick && !now.inBreak && (
            <div className="text-[11px] text-cyan-200/80">{now.soloing ? "Your solo!" : SECTION[now.section] ?? ""}</div>
          )}
        </div>
        {pick ? (
          <button
            onClick={(e) => {
              setPick(null);
              e.currentTarget.blur();
            }}
            className="shrink-0 rounded-full border border-white/30 px-3 py-1.5 text-xs hover:bg-white/10"
          >
            Back to the band
          </button>
        ) : (
          <button
            onClick={(e) => {
              setSheet((s) => !s);
              e.currentTarget.blur();
            }}
            className="shrink-0 rounded-full border border-emerald-300/60 bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/25"
          >
            Play your Spotify
          </button>
        )}
      </div>
      {sheet && !pick && (
        <div className="border-t border-white/10 px-3.5 py-3 space-y-2">
          <div className="text-xs text-white/75">
            Paste a link to a Spotify playlist, album or song. The band steps aside and the lights keep dancing.
          </div>
          <div className="flex gap-2">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") play();
              }}
              onKeyUp={(e) => e.stopPropagation()}
              placeholder="https://open.spotify.com/playlist/..."
              className="min-w-0 flex-1 rounded-lg bg-black/40 border border-white/20 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-300/70"
            />
            <button onClick={play} className="rounded-lg bg-emerald-500/80 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-500">
              Play
            </button>
          </div>
          {error && <div className="text-[11px] text-rose-200">{error}</div>}
          <div className="text-[10px] text-white/50">
            Signed in to Spotify in this browser, you hear whole songs. Otherwise Spotify plays 30 second previews.
          </div>
        </div>
      )}
      {pick && (
        <div className="px-2 pb-2">
          <iframe
            title="Spotify"
            src={pick.embed}
            width="100%"
            height={pick.kind === "track" || pick.kind === "episode" ? 80 : 152}
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            className="rounded-xl border-0"
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      {createPortal(card, document.body)}
      {onStage && (
        <button
          data-concert-solo
          onClick={(e) => {
            onSolo();
            e.currentTarget.blur();
          }}
          disabled={now.inBreak || now.soloing || !!pick}
          className="glass-panel rounded-full px-5 py-2.5 text-sm text-white border-2 border-fuchsia-300/80 backdrop-blur-md shadow-[0_0_24px_rgba(255,63,209,0.55)] hover:bg-white/10 disabled:opacity-50"
          style={{ background: "rgba(10,6,24,0.55)" }}
        >
          {now.soloing ? "🔥 Shredding..." : now.inBreak ? "🎸 Wait for the next song" : `🎸 Take a solo${isTouch ? "" : " (E)"}`}
        </button>
      )}
    </>
  );
}
