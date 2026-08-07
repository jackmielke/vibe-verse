/**
 * Vibe Kart — the multiplayer screens.
 *
 * Two panels over the same scenic camera the title screen uses, so joining a
 * room never leaves the world:
 *
 *   · **Join** — your name and a four-letter room code. Arriving on a `?room=`
 *     link skips it, because a link that still makes you type the code is a
 *     link that has done nothing.
 *   · **Lobby** — the roster, one row per racer, with the kart they picked and
 *     whether they are ready. When everyone is ready the countdown runs itself;
 *     see `net/lobby.ts` for why nobody gets a "drop the flag" button any more.
 *
 * The lobby draws its rows from presence, so a row appearing is somebody's
 * browser saying so — there is no local guess to get out of sync.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CharacterPreset } from "../types";
import { LOBBY_MAX, normalizeRoomCode, randomRoomCode, type KartLobby } from "../net/lobby";
import { CharacterPortrait } from "./portrait";
import { useRuntime } from "./runtime";
import type { ModelsView } from "./views";

interface JoinProps {
  name: string;
  code: string;
  onName(name: string): void;
  onCode(code: string): void;
  onJoin(): void;
  onBack(): void;
}

export function JoinScreen({ name, code, onName, onCode, onJoin, onBack }: JoinProps) {
  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onJoin();
    },
    [onJoin],
  );

  return (
    <div className="vk-layer" data-kart-hud="mpjoin">
      <div className="vk-scrim" />

      <div className="vk-sheet" style={{ gap: "2.2vmin" }}>
        <div style={{ textAlign: "center" }}>
          <div className="vk-title-head vk-ink-edge">Race your friends</div>
          <div className="vk-sub" style={{ marginTop: "0.6vmin" }}>
            Up to {LOBBY_MAX} on the grid · CPU fills the rest
          </div>
        </div>

        <form className="vk-panel vk-anim-rise vk-mp-join" onSubmit={submit}>
          <label className="vk-label" htmlFor="vk-mp-name">
            Your racer name
          </label>
          <input
            id="vk-mp-name"
            className="vk-input"
            value={name}
            maxLength={18}
            onChange={(e) => onName(e.target.value)}
            autoComplete="off"
          />

          <label className="vk-label" htmlFor="vk-mp-code" style={{ marginTop: "1.6vmin" }}>
            Room code
          </label>
          <div className="vk-row" style={{ gap: "1vmin" }}>
            <input
              id="vk-mp-code"
              className="vk-input vk-input--code"
              value={code}
              maxLength={6}
              onChange={(e) => onCode(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="vk-btn vk-btn--ghost vk-btn--sm"
              onClick={() => onCode(randomRoomCode())}
              aria-label="New room code"
              title="New room code"
            >
              🎲
            </button>
          </div>
          <p className="vk-blurb" style={{ margin: "1.2vmin 0 0" }}>
            Share the code — or the invite link from the lobby — and whoever types it lands on
            the same grid as you.
          </p>

          <div className="vk-row" style={{ marginTop: "2vmin", justifyContent: "center" }}>
            <button type="button" className="vk-btn vk-btn--ghost" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="vk-btn vk-btn--gold vk-btn--wide">
              Enter lobby
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface LobbyProps {
  lobby: KartLobby;
  onChooseRacer(): void;
  onLeave(): void;
}

export function LobbyScreen({ lobby, onChooseRacer, onLeave }: LobbyProps) {
  const rt = useRuntime();
  const models = rt.ctx.services.models as ModelsView | undefined;
  // Held steady: a fresh `[]` every render would re-key every lookup below.
  const roster = useMemo<CharacterPreset[]>(() => models?.roster ?? [], [models]);
  const [copied, setCopied] = useState(false);

  const presetOf = useCallback(
    (characterId: string | null): CharacterPreset | undefined =>
      characterId ? roster.find((p) => p.id === characterId) : undefined,
    [roster],
  );

  const invite = useMemo(
    () =>
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}/kart?room=${lobby.code ?? ""}`,
    [lobby.code],
  );

  const share = useCallback(() => {
    void navigator.clipboard?.writeText(invite);
    setCopied(true);
  }, [invite]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const me = lobby.me;
  const counting = lobby.phase === "countdown";
  const waiting = lobby.members.filter((m) => !m.racing);
  const readyCount = waiting.filter((m) => m.ready).length;

  return (
    <div className="vk-layer" data-kart-hud="mplobby">
      <div className="vk-scrim" />

      <div className="vk-sheet" style={{ gap: "1.8vmin" }}>
        <div style={{ textAlign: "center" }}>
          <div className="vk-label">Room</div>
          <div className="vk-mp-code vk-ink-edge">{lobby.code}</div>
          <button type="button" className="vk-btn vk-btn--ghost vk-btn--sm" onClick={share}>
            {copied ? "Link copied" : "Copy invite link"}
          </button>
        </div>

        <div className="vk-panel vk-mp-roster vk-anim-rise">
          <div className="vk-label" style={{ padding: "0 0.4vmin" }}>
            On the grid · {lobby.members.length}/{LOBBY_MAX} · {readyCount} ready
          </div>

          {lobby.members.map((m) => {
            const preset = presetOf(m.characterId);
            return (
              <div key={m.peerId} className="vk-mp-row" data-ready={m.ready ? "1" : "0"}>
                <div className="vk-mp-face">
                  {preset ? (
                    <CharacterPortrait preset={preset} />
                  ) : (
                    <span className="vk-mp-face-q">?</span>
                  )}
                </div>
                <div className="vk-mp-who">
                  <span className="vk-mp-name">{m.name}</span>
                  <span className="vk-mp-kart">
                    {preset ? preset.name : "picking a racer…"}
                    {m.peerId === lobby.peerId ? " · you" : ""}
                  </span>
                </div>
                <span className="vk-mp-state">
                  {m.racing ? "racing" : m.ready ? "✓ ready" : "waiting"}
                </span>
              </div>
            );
          })}

          {lobby.members.length < 2 ? (
            <p className="vk-blurb" style={{ margin: "0.6vmin 0.4vmin 0" }}>
              {lobby.connected
                ? "Nobody else yet. Send the invite link — or ready up anyway and race the CPU field."
                : "Still reaching the room. You can ready up regardless; you will race the CPU field."}
            </p>
          ) : null}
        </div>

        {counting ? (
          <div className="vk-mp-go vk-anim-pop" key={lobby.countdown}>
            <span className="vk-num">{lobby.countdown}</span>
            <span className="vk-sub">everyone ready — get set</span>
          </div>
        ) : (
          <div className="vk-row" style={{ flexWrap: "wrap", justifyContent: "center" }}>
            <button type="button" className="vk-btn vk-btn--ghost" onClick={onLeave}>
              Leave
            </button>
            <button type="button" className="vk-btn" onClick={onChooseRacer}>
              {me?.characterId ? "Change racer" : "Choose racer"}
            </button>

            {lobby.raceInProgress && !me?.ready ? (
              <button type="button" className="vk-btn vk-btn--gold vk-btn--wide" onClick={lobby.jumpIn}>
                Jump into the race
              </button>
            ) : (
              <button
                type="button"
                className={me?.ready ? "vk-btn vk-btn--wide" : "vk-btn vk-btn--gold vk-btn--wide"}
                disabled={!lobby.seated}
                onClick={() => lobby.setReady(!me?.ready)}
              >
                {!lobby.seated ? "Room full" : me?.ready ? "✓ Ready — cancel" : "Ready up"}
              </button>
            )}

            {lobby.isHost && !lobby.raceInProgress && lobby.members.length > 1 ? (
              <button type="button" className="vk-btn vk-btn--sm vk-btn--ghost" onClick={lobby.startNow}>
                Start without them
              </button>
            ) : null}
          </div>
        )}

        <div className="vk-sub" style={{ fontSize: "1.25vmin", textAlign: "center", maxWidth: "70vmin" }}>
          {counting
            ? "The flag drops for everyone at once"
            : lobby.seated
              ? "The race starts on its own once every racer here is ready"
              : `Six karts to a room — you are next in line`}
        </div>
      </div>
    </div>
  );
}
