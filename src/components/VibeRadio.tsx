/**
 * VibeRadio — VIBE FM, the retro cassette deck that follows you
 * through every world.
 *
 * Mounted once in App (outside the routes) so the music never stops
 * when you hop worlds. Collapsed: a little boombox button with
 * spinning reels while playing. Expanded: a chunky retro deck — LCD
 * marquee, cassette window, transport buttons, volume fader and the
 * track list.
 *
 * Tracks come from /audio/playlist.json — drop mp3s into public/audio
 * and list them there; the deck picks them up on load.
 */
import { useEffect, useRef, useState } from "react";

interface Track {
  file: string;
  title: string;
  artist: string;
}

export default function VibeRadio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [idx, setIdx] = useState(() => Number(localStorage.getItem("vibefm.idx") ?? "0"));
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("vibefm.vol") ?? "0.7"));

  // Load the playlist manifest.
  useEffect(() => {
    fetch("/audio/playlist.json")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.tracks) && j.tracks.length) setTracks(j.tracks);
      })
      .catch(() => { /* no playlist — the deck just stays quiet */ });
  }, []);

  const track = tracks[idx % Math.max(1, tracks.length)] ?? null;

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    try { localStorage.setItem("vibefm.vol", String(volume)); } catch { /* ignore */ }
  }, [volume]);
  useEffect(() => {
    try { localStorage.setItem("vibefm.idx", String(idx)); } catch { /* ignore */ }
  }, [idx]);

  const play = (i = idx) => {
    const t = tracks[i % Math.max(1, tracks.length)];
    const a = audioRef.current;
    if (!t || !a) return;
    if (i !== idx) setIdx(i);
    const src = `/audio/${t.file}`;
    if (!a.src.endsWith(encodeURI(t.file))) a.src = src;
    a.volume = volume;
    void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };
  const next = (dir: 1 | -1 = 1) => {
    if (!tracks.length) return;
    const n = (idx + dir + tracks.length) % tracks.length;
    play(n);
  };

  if (!tracks.length) return null;

  return (
    <>
      <audio ref={audioRef} onEnded={() => next(1)} />
      <style>{`
        @keyframes vibefm-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
        @keyframes vibefm-marquee { 0% { transform: translateX(100%);} 100% { transform: translateX(-100%);} }
        .vibefm-reel { animation: vibefm-spin 1.6s linear infinite; }
      `}</style>

      {/* Collapsed boombox button — bottom-left, above world HUDs. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-28 left-3 z-40 glass-panel rounded-full pl-2 pr-3 py-2 flex items-center gap-2 hover:scale-105 transition-transform"
          title="VIBE FM"
        >
          <span
            className={`w-7 h-7 rounded-full bg-zinc-900 border-2 border-amber-400/70 flex items-center justify-center text-sm ${playing ? "vibefm-reel" : ""}`}
          >
            📻
          </span>
          <span className="text-[10px] font-heading font-bold tracking-widest text-amber-300">
            {playing ? "VIBE FM" : "FM"}
          </span>
        </button>
      )}

      {/* The deck. */}
      {open && (
        <div
          className="fixed bottom-24 left-3 z-40 w-72 rounded-2xl overflow-hidden shadow-[0_12px_50px_rgba(0,0,0,0.6)]"
          style={{
            background: "linear-gradient(180deg, #3d3630 0%, #2a2521 55%, #1c1815 100%)",
            border: "1px solid rgba(255,205,130,0.25)",
          }}
        >
          {/* Faceplate header */}
          <div className="flex items-center justify-between px-4 pt-3">
            <div className="font-heading font-bold tracking-[0.28em] text-amber-300 text-xs">
              📻 VIBE FM
            </div>
            <button onClick={() => setOpen(false)} className="text-amber-100/50 hover:text-amber-100 px-1">✕</button>
          </div>

          {/* LCD marquee */}
          <div className="mx-4 mt-2 rounded-md bg-[#101a10] border border-lime-400/25 px-2 py-1.5 overflow-hidden">
            <div
              className="whitespace-nowrap font-mono text-[11px] text-lime-300"
              style={playing ? { animation: "vibefm-marquee 9s linear infinite" } : undefined}
            >
              {track ? `♪ ${track.title} — ${track.artist}   ·   every builder grows the universe   ` : "insert cassette"}
            </div>
          </div>

          {/* Cassette window */}
          <div className="mx-4 mt-3 rounded-lg bg-zinc-900/90 border border-zinc-700 p-2.5 flex items-center justify-between">
            {[0, 1].map((r) => (
              <div key={r} className="flex items-center gap-2">
                <div
                  className={`w-9 h-9 rounded-full border-4 border-zinc-600 bg-zinc-800 flex items-center justify-center ${playing ? "vibefm-reel" : ""}`}
                  style={{ animationDuration: r ? "2.2s" : "1.6s" }}
                >
                  <div className="w-2.5 h-2.5 rounded-full bg-zinc-500" />
                </div>
              </div>
            ))}
            <div className="absolute left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-widest text-zinc-500">
              stereo
            </div>
          </div>

          {/* Transport */}
          <div className="flex items-center justify-center gap-3 mt-3">
            <button
              onClick={() => next(-1)}
              className="w-10 h-9 rounded-md bg-zinc-800 border border-zinc-600 text-amber-200 active:translate-y-px"
            >
              ⏮
            </button>
            <button
              onClick={() => (playing ? pause() : play())}
              className="w-14 h-11 rounded-md bg-amber-400 text-zinc-900 font-bold text-lg border border-amber-300 active:translate-y-px"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              onClick={() => next(1)}
              className="w-10 h-9 rounded-md bg-zinc-800 border border-zinc-600 text-amber-200 active:translate-y-px"
            >
              ⏭
            </button>
          </div>

          {/* Volume fader */}
          <div className="flex items-center gap-2 px-4 mt-3">
            <span className="text-[10px] text-amber-100/60">vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="flex-1 accent-amber-400"
            />
          </div>

          {/* Track list */}
          <div className="mt-3 max-h-40 overflow-y-auto border-t border-zinc-700/60">
            {tracks.map((t, i) => (
              <button
                key={t.file}
                onClick={() => play(i)}
                className={`w-full text-left px-4 py-2 text-[11px] flex items-center gap-2 transition-colors ${
                  i === idx ? "bg-amber-400/15 text-amber-200" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="w-4">{i === idx && playing ? "♪" : `${i + 1}.`}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto text-zinc-500 truncate max-w-[40%]">{t.artist}</span>
              </button>
            ))}
          </div>
          <div className="px-4 py-2 text-[9px] text-zinc-500">
            drop mp3s in <span className="text-zinc-400">public/audio</span> + list them in playlist.json
          </div>
        </div>
      )}
    </>
  );
}
