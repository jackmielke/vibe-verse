/**
 * Vibe Kart · Multiplayer — lobby, then the race.
 *
 * The lobby is a Supabase Realtime presence room keyed by a four-letter code.
 * Everyone in the room sees the same roster; anybody can drop the flag, which
 * broadcasts `start` and moves every client into the race at once. From there
 * the single-player engine takes over — see `src/kart/net/netplay.ts` for how
 * the other humans get into the field.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { bootKart } from "@/kart/boot";
import { detectKartQuality, type KartEngine } from "@/kart/engine/core";
import KartUI from "@/kart/ui/KartUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";

type Member = { peerId: string; name: string };

const NAMES = [
  "Turbo Tofu", "Neon Newt", "Drift Otter", "Sparky", "Mango Bolt",
  "Cardboard Kid", "Zoom Zoom", "Gremlin", "Comet", "Wasabi",
];

function randomName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export default function VibeKartMultiplayer() {
  useWorldStamp("/kart-mp", "Vibe Kart Multiplayer");

  const [params, setParams] = useSearchParams();
  const peerId = useMemo(
    () => `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    [],
  );

  const [name, setName] = useState(() => localStorage.getItem("kart:name") || randomName());
  const [code, setCode] = useState(() => (params.get("room") || randomCode()).toUpperCase().slice(0, 6));
  const [joined, setJoined] = useState(false);
  const [racing, setRacing] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [copied, setCopied] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // --- Lobby presence -------------------------------------------------------
  useEffect(() => {
    if (!joined) return;
    const channel = supabase.channel(`kart-lobby-${code}`, {
      config: { presence: { key: peerId } },
    });
    channelRef.current = channel;

    const readPresence = () => {
      const state = channel.presenceState<{ peerId: string; name: string }>();
      const list: Member[] = [];
      for (const entries of Object.values(state)) {
        for (const e of entries) list.push({ peerId: e.peerId, name: e.name });
      }
      list.sort((a, b) => a.peerId.localeCompare(b.peerId));
      setMembers(list);
    };

    channel.on("presence", { event: "sync" }, readPresence);
    channel.on("broadcast", { event: "start" }, () => setRacing(true));
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") void channel.track({ peerId, name });
    });

    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [joined, code, peerId, name]);

  const join = useCallback(() => {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || randomCode();
    setCode(clean);
    localStorage.setItem("kart:name", name.trim() || "Racer");
    setParams({ room: clean }, { replace: true });
    setJoined(true);
  }, [code, name, setParams]);

  const startRace = useCallback(() => {
    void channelRef.current?.send({ type: "broadcast", event: "start", payload: {} });
    setRacing(true);
  }, []);

  const share = useCallback(() => {
    const url = `${window.location.origin}/kart-mp?room=${code}`;
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [code]);

  if (racing) {
    return <KartRace room={code} peerId={peerId} name={name.trim() || "Racer"} />;
  }

  return (
    <div className="fixed inset-0 overflow-y-auto bg-[#07101c] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center gap-6 p-6">
        <header>
          <h1 className="text-3xl font-black tracking-tight text-amber-300">
            🏁 Vibe Kart · Multiplayer
          </h1>
          <p className="mt-1 text-sm text-white/60">
            Same track, same shells — with your friends in the field. Share a room code and go.
          </p>
        </header>

        {!joined ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <label className="block text-xs uppercase tracking-widest text-white/50">Your racer name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 18))}
              className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-lg outline-none focus:border-amber-300"
            />

            <label className="mt-5 block text-xs uppercase tracking-widest text-white/50">Room code</label>
            <div className="mt-2 flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 font-mono text-2xl tracking-[0.4em] outline-none focus:border-amber-300"
              />
              <button
                onClick={() => setCode(randomCode())}
                className="rounded-xl border border-white/15 px-4 text-sm text-white/70 hover:border-amber-300 hover:text-amber-200"
              >
                🎲
              </button>
            </div>

            <button
              onClick={join}
              className="mt-6 w-full rounded-xl bg-amber-400 px-6 py-4 text-lg font-black uppercase tracking-widest text-amber-950 transition hover:bg-amber-300"
            >
              Enter lobby →
            </button>
            <a href="/kart" className="mt-3 block text-center text-xs uppercase tracking-widest text-white/40 hover:text-white/70">
              ← single player
            </a>
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-300/30 bg-white/5 p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-widest text-white/50">Room</div>
                <div className="font-mono text-3xl tracking-[0.4em] text-amber-300">{code}</div>
              </div>
              <button
                onClick={share}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/80 hover:border-amber-300 hover:text-amber-200"
              >
                {copied ? "Copied!" : "Copy invite"}
              </button>
            </div>

            <div className="mt-5 text-xs uppercase tracking-widest text-white/50">
              On the grid · {members.length}
            </div>
            <ul className="mt-2 space-y-2">
              {members.map((m) => (
                <li
                  key={m.peerId}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3"
                >
                  <span className="text-lg">🏎️</span>
                  <span className="font-semibold">{m.name}</span>
                  {m.peerId === peerId && (
                    <span className="ml-auto text-[10px] uppercase tracking-widest text-amber-300">you</span>
                  )}
                </li>
              ))}
              {members.length === 0 && (
                <li className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-sm text-white/40">
                  Connecting…
                </li>
              )}
            </ul>

            <p className="mt-4 text-xs text-white/40">
              The rest of the eight-kart field is filled by CPU rivals. Anyone can drop the flag —
              everyone in the lobby starts together.
            </p>

            <button
              onClick={startRace}
              className="mt-5 w-full rounded-xl bg-emerald-400 px-6 py-4 text-lg font-black uppercase tracking-widest text-emerald-950 transition hover:bg-emerald-300"
            >
              Start race
            </button>
            <button
              onClick={() => setJoined(false)}
              className="mt-3 w-full text-center text-xs uppercase tracking-widest text-white/40 hover:text-white/70"
            >
              ← leave lobby
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The race itself: the single-player shell plus a net config. */
function KartRace({ room, peerId, name }: { room: string; peerId: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<KartEngine | null>(null);
  const [engine, setEngine] = useState<KartEngine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await bootKart(
          { canvas, quality: detectKartQuality(), net: { room, peerId, name } },
          (stage, fraction) => !cancelled && setProgress({ stage, fraction }),
        );
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        setEngine(eng);
        eng.start();
        setReady(true);
        (window as unknown as Record<string, unknown>).__kartmp = eng;
      } catch (err) {
        console.error("[Vibe Kart MP] boot failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [room, peerId, name]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#07101c]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && <KartUI engine={engine} ready={ready} progress={progress} />}

      <div className="pointer-events-none absolute bottom-16 left-3 z-40 rounded-full border border-amber-300/30 bg-black/50 px-3 py-1 font-mono text-[11px] tracking-widest text-amber-200 backdrop-blur">
        ROOM {room}
      </div>

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Vibe Kart failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <a href="/" className="mt-4 text-xs uppercase tracking-widest text-amber-300">
            ← back to the vibeverse
          </a>
        </div>
      )}
    </div>
  );
}
