/**
 * `/magician?show`: the valley on the big screen.
 *
 * Nobody stands here. A slow camera circles the village square, a QR code
 * opens the spell remote on every phone in the room, and each spell that
 * lands is credited in large type down the side: "Maya made it snow". The
 * whole audience is shaping one world, and this is the page that shows them
 * they are.
 */
import { useEffect, useRef, useState } from "react";
import { createMagician, type MagicianWorld } from "../world/Magician";
import { readRoom } from "../net";
import { QrCode } from "@/oni/ui/QrCode";

interface FeedLine { id: number; text: string; at: number }

function remoteUrl(room: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://myvibeverse.com";
  return room === "hoshimura" ? `${origin}/magician?remote` : `${origin}/magician?remote&room=${room}`;
}

export function MagicianProjector() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<MagicianWorld | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [casters, setCasters] = useState<string[]>([]);
  const [walkers, setWalkers] = useState<string[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [sound, setSound] = useState(false);
  const idRef = useRef(1);
  const room = readRoom();
  const url = remoteUrl(room);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const world = createMagician(host, {
      onCast: (note) => {
        const id = idRef.current++;
        setFeed((f) => [{ id, text: `${note.emoji} ${note.n} ${note.did}`, at: Date.now() }, ...f].slice(0, 7));
        setCasters((c) => (c.includes(note.n) ? c : [...c, note.n].slice(-40)));
      },
      onPeers: (list, ok) => { setWalkers(list.map((p) => p.name)); setConnected(ok); },
    }, { spectator: true, name: "projector" });
    worldRef.current = world;
    world.setMuted(true);
    return () => { world.dispose(); worldRef.current = null; };
  }, []);

  // Old lines fade: the feed is what is happening, not a log.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const now = Date.now();

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-[#120c1c] text-[#ffe9c8]"
      onPointerDown={() => { if (!sound) { worldRef.current?.wake(); worldRef.current?.setMuted(false); setSound(true); } }}
      data-projector="1"
    >
      <div ref={hostRef} className="absolute inset-0" />
      {/* Clicks stop here: the valley would take them as "look around" and grab the pointer. */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-transparent to-black/50" />

      <div className="absolute left-8 top-20 flex flex-col items-start gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-[#ffe9c8]/70">星村 · Hoshimura</p>
          <div className="mt-1 font-serif text-6xl leading-none">The Magician</div>
          <div className="mt-2 text-base text-[#ffe9c8]/75">Your phone is a wand. Change this world.</div>
        </div>
        <div className="rounded-2xl bg-white p-3 shadow-2xl">
          <QrCode text={url} size={250} />
        </div>
        <div className="text-2xl font-semibold">Scan to cast spells 🪄</div>
        <div className="font-mono text-base text-[#ffe9c8]/70">{url.replace(/^https?:\/\//, "")}</div>
      </div>

      <div className="absolute bottom-8 right-8 top-8 flex w-[26rem] flex-col items-end gap-2">
        <div className="rounded-full bg-black/45 px-4 py-1.5 text-xs uppercase tracking-[0.25em] text-[#ffe9c8]/70 backdrop-blur">
          {casters.length} casting · {walkers.length} walking ·{" "}
          <span className={connected ? "text-[#8fe3a4]" : connected === false ? "text-[#ff9a8a]" : ""}>{connected ? "live" : connected === false ? "offline" : "joining"}</span>
        </div>
        <div className="mt-2 flex w-full flex-col items-end gap-2" data-feed="1">
          {feed.map((l, i) => {
            const age = (now - l.at) / 1000;
            return (
              <div
                key={l.id}
                className={`max-w-full rounded-2xl bg-black/60 px-5 py-3 text-right backdrop-blur transition-opacity duration-1000 [text-shadow:0_2px_8px_rgba(0,0,0,0.6)] ${i === 0 ? "text-3xl font-semibold leading-tight text-[#fff4e0]" : "truncate text-xl text-[#ffe9c8]/90"} ${i === 0 && age < 1.2 ? "animate-in slide-in-from-right-8 zoom-in-95 duration-500" : ""}`}
                style={{ opacity: i === 0 ? 1 : Math.max(0.45, 1 - Math.max(0, age - 15) / 30) }}
              >
                {l.text}
              </div>
            );
          })}
          {!feed.length && <div className="rounded-2xl bg-black/45 px-5 py-3 text-xl text-[#ffe9c8]/70 backdrop-blur">Waiting for the first spell…</div>}
        </div>
        {!sound && <div className="mt-auto rounded-full bg-black/45 px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-[#ffe9c8]/60 backdrop-blur">click anywhere for sound</div>}
      </div>
    </div>
  );
}
