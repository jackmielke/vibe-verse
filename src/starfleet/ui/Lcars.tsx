/**
 * The interface, which on this ship is the same thing as the controls.
 *
 * One React component, one subscription. `createGame` is imperative and owns
 * the simulation; this reads its state through `subscribe` and writes to it
 * through the eight methods on the `Game` handle. There is no shared mutable
 * object between the two and no React state inside the render loop — a
 * `setState` per frame at sixty hertz is how a three.js world ends up dropping
 * frames in the DOM rather than the GPU.
 *
 * Two things in here are load-bearing and easy to get wrong:
 *
 * **The comm input takes the keyboard away from the ship.** `input.typing` is
 * set on focus and cleared on blur. Without it, asking a Klingon "what do you
 * want" walks the away team backwards through a wall, because `w`, `a`, `s`
 * and `d` are also flight controls. It is the single most obvious bug a world
 * with a text box in it can ship.
 *
 * **The channel history lives in a ref, not in state.** The `Channel` object
 * is handed to `comms.say` and mutated by it; React re-renders off a separate
 * message array. Keeping the transcript in state and passing it down would
 * make every keystroke a new conversation as far as the model is concerned.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "./lcars.css";
import type { Game } from "../game";
import {
  MAX_WARP,
  SYSTEMS,
  distanceLy,
  stardate,
  travelTime,
  type TrekSystem,
} from "../galaxy/systems";
import { BRIDGE_CREW, type Character } from "../crew/characters";
import { hail as openHail, openChannel, say, setVoice, speak, stopVoice, type Brain, type Channel } from "../crew/comms";

interface Msg {
  from: "me" | "them";
  name: string;
  text: string;
  brain?: Brain;
}

export default function Lcars({ game }: { game: Game }) {
  const [, force] = useState(0);
  const [showTitle, setShowTitle] = useState(true);
  const [showChart, setShowChart] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [voice, setVoiceOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const channelRef = useRef<Channel | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const s = game.state;

  useEffect(() => game.subscribe(() => force((n) => n + 1)), [game]);

  /* M opens the chart. It lives here rather than in `game` because the chart is
     a piece of UI and the game has no opinion about whether it is open — but it
     still has to be a key, because every other order on this ship is one. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (game.input.typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "m") setShowChart((v) => !v);
      if (e.key === "Escape") setShowChart(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game]);

  /* Open and close the transcript alongside the game's channel. The game owns
     "is there a channel"; this owns "what has been said on it". */
  useEffect(() => {
    const ch = s.channel;
    if (!ch) {
      channelRef.current = null;
      setMsgs([]);
      stopVoice();
      return;
    }
    if (channelRef.current?.character.key === ch.key) return;
    const channel = openChannel(ch);
    channelRef.current = channel;
    const greeting = openHail(channel);
    setMsgs([{ from: "them", name: ch.name, text: greeting }]);
    if (voice) speak(ch, greeting);
  }, [s.channel, voice]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, pending]);

  const send = useCallback(
    async (text: string) => {
      const channel = channelRef.current;
      if (!channel || !text.trim() || pending) return;
      const c = channel.character;
      setMsgs((m) => [...m, { from: "me", name: s.captain, text }]);
      setPending(true);
      const { reply, brain } = await say(channel, text);
      setPending(false);
      setMsgs((m) => [...m, { from: "them", name: c.name, text: reply, brain }]);
      if (voice) speak(c, reply);
      game.audio.chirp(1);
    },
    [pending, s.captain, voice, game],
  );

  /* Any open panel gives the mouse back. This is the counterpart to the drag-
     look path in `types.ts`: pointer lock is a mode you opt into by clicking
     the viewport, and every panel opt out of it, because a locked pointer
     routes every click to the canvas and the rail stops working. */
  useEffect(() => {
    if (showChart || s.channel || showTitle) game.releasePointerLock();
  }, [showChart, s.channel, showTitle, game]);

  const begin = () => {
    setShowTitle(false);
    game.audio.resume();
  };

  const sys = s.system;
  const scanned = s.scanned.includes(sys.key);
  const selectedSys = useMemo(
    () => SYSTEMS.find((x) => x.key === (selected ?? sys.key)) ?? sys,
    [selected, sys],
  );

  return (
    <div id="snw-root">
      {/* ---------------- title card ---------------- */}
      {showTitle && (
        <div className="title">
          <div className="kicker">UNITED FEDERATION OF PLANETS · STARFLEET COMMAND</div>
          <h1>
            STRANGE
            <br />
            NEW WORLDS
          </h1>
          <p>
            You have the USS Odyssey and a chart with twelve real systems on it — Vulcan at 40
            Eridani, Qo'noS ninety light years out, Wolf 359 where the fleet is still lying.
            Lay in a course, make orbit, run the sensors, and then beam down and talk to whoever is
            waiting at the coordinates. They will talk back.
          </p>
          <button className="go" onClick={begin}>
            ENGAGE
          </button>
          <div className="keys">
            W A S D — CONN · MOUSE — LOOK · C — SCAN · H — HAIL · B — TRANSPORT
            <br />O — ORBIT · V — VIEW · Y — ALERT · F — SPEAK · ESC — CLOSE CHANNEL
          </div>
        </div>
      )}

      {/* ---------------- rail ---------------- */}
      <div className="rail">
        <div className="rail-cap">USS ODYSSEY</div>

        <button className="lc-btn nav" onClick={() => { setShowChart(true); game.audio.chirp(0); }}>
          <span>CHART</span>
          <span className="key">M</span>
        </button>
        <button className="lc-btn sci" onClick={game.scan} disabled={s.phase !== "idle"}>
          <span>SCAN</span>
          <span className="key">C</span>
        </button>
        <button
          className={`lc-btn${s.channel ? " on" : ""}`}
          onClick={() => (s.channel ? game.closeChannel() : game.hail(s.near?.key))}
          disabled={s.phase !== "idle"}
        >
          <span>{s.channel ? "CLOSE" : "HAIL"}</span>
          <span className="key">H</span>
        </button>
        {s.mode === "space" ? (
          <>
            <button className={`lc-btn${s.orbiting ? " on" : ""}`} onClick={game.toggleOrbit}>
              <span>ORBIT</span>
              <span className="key">O</span>
            </button>
            <button className="lc-btn nav" onClick={game.beamDown} disabled={s.phase !== "idle"}>
              <span>BEAM DOWN</span>
              <span className="key">B</span>
            </button>
            <button className="lc-btn" onClick={game.toggleView}>
              <span>VIEW</span>
              <span className="key">V</span>
            </button>
          </>
        ) : (
          <button className="lc-btn nav" onClick={game.beamUp} disabled={s.phase !== "idle"}>
            <span>BEAM UP</span>
            <span className="key">B</span>
          </button>
        )}
        <button className={`lc-btn${s.alert ? " alert" : ""}`} onClick={game.toggleAlert}>
          <span>ALERT</span>
          <span className="key">Y</span>
        </button>

        <div className="rail-spacer" />

        <button
          className={`lc-btn${voice ? " on" : ""}`}
          onClick={() => {
            const next = !voice;
            setVoiceOn(next);
            setVoice(next);
          }}
        >
          <span>VOX</span>
        </button>
        <button
          className={`lc-btn${muted ? " on" : ""}`}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            game.audio.setMuted(next);
          }}
        >
          <span>{muted ? "AUDIO OFF" : "AUDIO"}</span>
        </button>
        <Link className="rail-foot" to="/">
          ← VIBEVERSE
        </Link>
      </div>

      {/* ---------------- top strip ---------------- */}
      <div className="top">
        <div className="block">STARDATE {stardate(s.elapsedDays)}</div>
        <div className="block sci">{sys.name}</div>
        <div className="block wide">
          {s.mode === "space"
            ? `${s.orbiting ? "STANDARD ORBIT" : "MANUAL CONN"} · ALT ${s.altitude.toLocaleString()} KM`
            : (sys.surface?.site ?? "SURFACE").toUpperCase()}
        </div>
        {s.alert && <div className="block red">RED ALERT</div>}
      </div>

      {/* ---------------- sensor readout ---------------- */}
      {s.mode === "space" && !showChart && (
        <div className="readout">
          <h3>{sys.world.name}</h3>
          <div className="sub">
            {sys.world.designation} · CLASS {sys.world.class} · {sys.quadrant.toUpperCase()} QUADRANT
          </div>
          {scanned ? (
            <>
              <dl>
                <dt>Diameter</dt>
                <dd>{sys.world.diameterKm.toLocaleString()} km</dd>
                <dt>Gravity</dt>
                <dd>{sys.world.gravity.toFixed(2)} g</dd>
                <dt>Rotation</dt>
                <dd>{sys.world.day}</dd>
                <dt>Orbit</dt>
                <dd>{sys.world.year}</dd>
                <dt>Atmosphere</dt>
                <dd>{sys.world.atmosphere}</dd>
                <dt>Population</dt>
                <dd>{sys.world.population}</dd>
                <dt>Government</dt>
                <dd>{sys.world.government}</dd>
                <dt>Contact</dt>
                <dd>{sys.world.contact}</dd>
              </dl>
              <div className="note">
                {sys.world.notes.map((n) => (
                  <p key={n}>› {n}</p>
                ))}
              </div>
            </>
          ) : (
            <div className="note">
              <p>NO SENSOR RECORD ON FILE FOR THIS BODY.</p>
              <p>› Run a sweep — press C, or SCAN on the panel.</p>
            </div>
          )}
          {sys.hazard && <div className="hazard">⚠ {sys.hazard}</div>}
        </div>
      )}

      {/* ---------------- log ---------------- */}
      <div className="log">
        {s.log.slice(-9).map((l) => (
          <div key={l.id} className={`line${l.urgent ? " urgent" : ""}`}>
            <span className="stamp">{l.stamp}</span>
            {l.text}
          </div>
        ))}
      </div>

      {/* ---------------- surface prompt ---------------- */}
      {s.mode === "surface" && s.phase === "idle" && !s.channel && (
        <>
          <div className="reticle" />
          {s.near && <div className="talk-prompt">F — SPEAK WITH {s.near.name.toUpperCase()}</div>}
        </>
      )}

      {/* ---------------- comms ---------------- */}
      {s.channel && (
        <div className="comms">
          <div className="comms-head">
            <div>
              <div className="who">{s.channel.name}</div>
              <div className="what">
                {s.channel.species.toUpperCase()} · {s.channel.title.toUpperCase()}
                <span
                  className="brainlight"
                  title={
                    msgs.some((m) => m.brain === "live")
                      ? "Live channel"
                      : "Local pattern buffer — subspace relay unavailable"
                  }
                  style={{
                    background: msgs.some((m) => m.brain === "live") ? "#7fff9f" : "#ffcc66",
                  }}
                />
              </div>
            </div>
            <button className="x" onClick={game.closeChannel}>
              CLOSE
            </button>
          </div>

          <div className="comms-body" ref={bodyRef}>
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.from}`}>
                <span className="from">{m.from === "me" ? s.captain.toUpperCase() : m.name}</span>
                {m.text}
              </div>
            ))}
            {pending && (
              <div className="msg them">
                <span className="from">{s.channel.name}</span>
                <span className="dots" />
              </div>
            )}
          </div>

          <div className="comms-prompts">
            {s.channel.prompts.map((p) => (
              <button key={p} onClick={() => void send(p)} disabled={pending}>
                {p}
              </button>
            ))}
          </div>

          <form
            className="comms-input"
            onSubmit={(e) => {
              e.preventDefault();
              const el = inputRef.current;
              if (!el) return;
              const v = el.value;
              el.value = "";
              void send(v);
            }}
          >
            <input
              ref={inputRef}
              placeholder="Say something…"
              maxLength={400}
              onFocus={() => {
                game.input.typing = true;
              }}
              onBlur={() => {
                game.input.typing = false;
              }}
            />
            <button type="submit" disabled={pending}>
              SEND
            </button>
          </form>
        </div>
      )}

      {/* ---------------- star chart ---------------- */}
      {showChart && (
        <div className="sheet" onClick={(e) => e.target === e.currentTarget && setShowChart(false)}>
          <div className="sheet-inner">
            <div className="sheet-head">
              <h2>STELLAR CARTOGRAPHY</h2>
              <button className="close" onClick={() => setShowChart(false)}>
                CLOSE
              </button>
            </div>
            <div className="sheet-body">
              <div className="chart">
                <ChartMap
                  current={sys.key}
                  selected={selectedSys.key}
                  visited={s.visited}
                  onPick={(k) => {
                    setSelected(k);
                    game.audio.chirp(3);
                  }}
                />
                <div className="chart-side">
                  <h3>{selectedSys.name}</h3>
                  <div className="sub lc-mono" style={{ color: "var(--lc-ice)", fontSize: 10, letterSpacing: "0.12em" }}>
                    {selectedSys.star.name.toUpperCase()} · CLASS {selectedSys.star.class} ·{" "}
                    {selectedSys.ly.toFixed(2)} LY FROM SOL
                  </div>
                  <div className="tag">{selectedSys.tagline}</div>
                  <div className="star-note">{selectedSys.star.note}</div>

                  <div className="warp-row">
                    <span className="lc-mono" style={{ fontSize: 11, color: "var(--lc-orange)" }}>
                      WARP {s.warpFactor.toFixed(1)}
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={MAX_WARP}
                      step={0.1}
                      value={s.warpFactor}
                      onChange={(e) => game.setWarpFactor(Number(e.target.value))}
                    />
                  </div>
                  <Eta from={sys} to={selectedSys} warp={s.warpFactor} />

                  <button
                    className="engage"
                    disabled={selectedSys.key === sys.key || s.phase !== "idle"}
                    onClick={() => {
                      game.setCourse(selectedSys.key);
                      setShowChart(false);
                    }}
                  >
                    {selectedSys.key === sys.key ? "YOU ARE HERE" : "ENGAGE"}
                  </button>

                  <div className="star-note" style={{ marginTop: 14, borderColor: "var(--lc-lilac)", color: "var(--lc-lilac)" }}>
                    Your own bridge is always on the channel — {BRIDGE_CREW.map((c) => c.name.replace(/^.*\. /, "")).join(", ")}.
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
                    {BRIDGE_CREW.map((c) => (
                      <CrewButton key={c.key} c={c} onPick={() => { game.hail(c.key); setShowChart(false); }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- washes ---------------- */}
      {s.beamK > 0.001 && <div className="wash beam" style={{ opacity: s.beamK }} />}
      {s.alert && s.phase === "idle" && <div className="wash alert" />}
      {s.phase === "warping" && (
        <div className="warp-banner" style={{ opacity: Math.min(1, s.warpK * 1.5) }}>
          <div className="big">WARP {s.warpFactor.toFixed(1)}</div>
          <div className="small">ENGAGED</div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CrewButton({ c, onPick }: { c: Character; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className="lc-mono"
      style={{
        fontSize: 10,
        padding: "5px 10px",
        borderRadius: 12,
        background: `#${c.accent.toString(16).padStart(6, "0")}22`,
        color: `#${c.accent.toString(16).padStart(6, "0")}`,
      }}
    >
      {c.name}
    </button>
  );
}

function Eta({ from, to, warp }: { from: TrekSystem; to: TrekSystem; warp: number }) {
  if (from.key === to.key) return <div className="eta">IN SYSTEM</div>;
  const ly = distanceLy(from, to);
  return (
    <div className="eta">
      {ly.toFixed(1)} LY · {travelTime(ly, warp).toUpperCase()} AT WARP {warp.toFixed(1)}
    </div>
  );
}

/**
 * The chart.
 *
 * Positions come straight out of the registry in light years and are projected
 * with a square-root radial compression — linear puts Sol, Wolf 359 and
 * Procyon inside one pixel of each other while Romulus is off the edge, and a
 * pure log flattens the difference between eight light years and ninety, which
 * is the one thing the chart exists to communicate. The range rings are
 * labelled in light years so the compression is visible rather than a lie.
 */
function ChartMap({
  current,
  selected,
  visited,
  onPick,
}: {
  current: string;
  selected: string;
  visited: string[];
  onPick: (key: string) => void;
}) {
  const MAX = 130;
  const project = (x: number, y: number) => {
    const r = Math.hypot(x, y);
    const k = r < 0.001 ? 0 : Math.sqrt(r / MAX) / (r / MAX);
    return { px: 50 + (x * k * 50) / MAX, py: 50 - (y * k * 50) / MAX };
  };

  return (
    <div className="chart-map">
      {[10, 40, 90].map((ly) => {
        const size = (Math.sqrt(ly / MAX) * 100).toFixed(1);
        return (
          <div key={ly} className="chart-ring" style={{ width: `${size}%`, height: `${size}%` }}>
            <span>{ly} LY</span>
          </div>
        );
      })}
      {SYSTEMS.map((sysx) => {
        const { px, py } = project(sysx.chart.x, sysx.chart.y);
        const here = sysx.key === current;
        const sel = sysx.key === selected;
        const seen = visited.includes(sysx.key);
        return (
          <button
            key={sysx.key}
            className={`pip${here ? " here" : ""}${sel ? " sel" : ""}`}
            style={{ left: `${px}%`, top: `${py}%`, color: `#${sysx.accent.toString(16).padStart(6, "0")}` }}
            onClick={() => onPick(sysx.key)}
            title={sysx.tagline}
          >
            <span className="dot" style={{ opacity: seen ? 1 : 0.55 }} />
            <span className="name">{sysx.name}</span>
          </button>
        );
      })}
    </div>
  );
}
