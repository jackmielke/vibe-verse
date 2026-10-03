/**
 * /bots — the thirty-second loop: type your X handle, get a bot, coach it
 * through one rock-paper-scissors match, share the card, dare a friend.
 *
 * A link with `?vs=` is a challenge: the bot inside it is the opponent. With
 * no challenge you spar with Vibey's house bot, so the loop works alone.
 * See `src/bots/bot.ts` for why there is no database.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { haptic } from "@/lib/haptics";
import { IOS_APP } from "@/lib/iosApp";
import { openSafety } from "@/safety/safety";
import {
  type Bot,
  type Throw,
  FIRST_TO,
  THROWS,
  THROW_EMOJI,
  challengeUrl,
  decodeBot,
  drawCard,
  forgeBot,
  loadBot,
  outcome,
  saveBot,
  shareCard,
  styleThrow,
} from "@/bots/bot";

const HOUSE: Bot = {
  v: 1,
  handle: "vibey",
  name: "Vibey Prime",
  emoji: "🤖",
  species: "Goggled Lobby Robot",
  color: "#7dffd4",
  catchphrase: "Every throw is a vibe check.",
  personality: "The house bot. Friendly, a little smug, loves paper.",
  style: { rock: 0.25, paper: 0.5, scissors: 0.25 },
  tell: "Smooths its goggles before a flat, open throw.",
  win: "Beep. Called it.",
  lose: "Respect. Run it back.",
  stats: { grit: 5, flair: 7, cunning: 6 },
};

interface Round {
  mine: Throw;
  theirs: Throw;
  result: 1 | 0 | -1;
}

export default function Bots() {
  const [params, setParams] = useSearchParams();
  const challenger = useMemo(() => decodeBot(params.get("vs") ?? ""), [params]);
  const [bot, setBot] = useState<Bot | null>(() => loadBot());
  const opponent = challenger ?? HOUSE;

  return (
    <div className="min-h-[100dvh] w-full bg-[#07060d] text-white">
      <main className="mx-auto flex max-w-md flex-col px-4 pb-24 pt-20">
        <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#7dffd4]/80">Bot Battle</p>
        <h1 className="mt-1 font-heading text-3xl font-black tracking-tight">Your Pokémon, made of software.</h1>
        {challenger && (
          <p className="mt-2 text-sm text-white/70">
            <b>@{challenger.handle}</b> challenged you with {challenger.emoji} <b>{challenger.name}</b>.
          </p>
        )}
        {!bot ? (
          <Forge onBot={(b) => (saveBot(b), setBot(b))} />
        ) : (
          <Arena
            key={opponent.handle + opponent.name}
            me={bot}
            them={opponent}
            onReforge={() => (saveBot(null), setBot(null))}
            onHouse={() => setParams({})}
            isChallenge={!!challenger}
          />
        )}
      </main>
    </div>
  );
}

function Forge({ onBot }: { onBot: (b: Bot) => void }) {
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const h = handle.replace(/^@/, "").trim();
    if (!h) return;
    setBusy(true);
    try {
      const b = await forgeBot(h, bio);
      haptic("success");
      onBot(b);
    } catch (e) {
      toast.error(`Couldn't forge a bot: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <label className="text-xs font-semibold uppercase tracking-wider text-white/50">Your X handle</label>
      <div className="mt-2 flex items-center rounded-xl border border-white/15 bg-black/40 px-3">
        <span className="text-white/40">@</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="jackmielke"
          autoCapitalize="none"
          autoCorrect="off"
          className="h-12 w-full bg-transparent px-1 outline-none"
        />
      </div>
      <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-white/50">A line about you (optional)</label>
      <input
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        placeholder="builder, surfer, chaos gremlin"
        className="mt-2 h-12 w-full rounded-xl border border-white/15 bg-black/40 px-3 outline-none"
      />
      <button
        disabled={busy || !handle.trim()}
        onClick={go}
        className="mt-5 h-12 w-full rounded-xl bg-[#ffb23f] font-bold text-black disabled:opacity-40"
      >
        {busy ? "Forging…" : "Forge my bot"}
      </button>
      <p className="mt-3 text-center text-[11px] text-white/40">X sign-in is coming soon. For now your handle is enough.</p>
    </div>
  );
}

function BotCard({ b, dim, onReport }: { b: Bot; dim?: boolean; onReport?: () => void }) {
  return (
    <div className={`min-w-0 flex-1 basis-0 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-center transition ${dim ? "opacity-50" : ""}`}>
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-4xl sm:h-20 sm:w-20 sm:text-5xl" style={{ background: b.color + "44", boxShadow: `0 0 30px ${b.color}55` }}>
        {b.emoji}
      </div>
      <div className="mt-2 truncate font-bold">{b.name}</div>
      <div className="truncate text-[11px] text-white/50">@{b.handle} · {b.species}</div>
      <div className="mt-2 flex flex-wrap justify-center gap-x-2 text-[9px] uppercase tracking-wider text-white/60">
        <span>grit {b.stats.grit}</span>
        <span>flair {b.stats.flair}</span>
        <span>cunning {b.stats.cunning}</span>
      </div>
      {onReport && (
        <button onClick={onReport} className="mt-2 text-[10px] text-white/40 underline">Report</button>
      )}
    </div>
  );
}

function Arena({ me, them, onReforge, onHouse, isChallenge }: { me: Bot; them: Bot; onReforge: () => void; onHouse: () => void; isChallenge: boolean }) {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [line, setLine] = useState<string>(them.catchphrase);
  const mine = rounds.filter((r) => r.result === 1).length;
  const theirs = rounds.filter((r) => r.result === -1).length;
  const over = mine >= FIRST_TO || theirs >= FIRST_TO;
  const last = rounds[rounds.length - 1];

  useEffect(() => {
    if (over) haptic(mine > theirs ? "success" : "error");
  }, [over, mine, theirs]);

  const play = (t: Throw) => {
    if (over) return;
    const theirThrow = styleThrow(them, Math.random());
    const result = outcome(t, theirThrow);
    setRounds((r) => [...r, { mine: t, theirs: theirThrow, result }]);
    setLine(result === 1 ? `${them.name}: “${them.lose}”` : result === -1 ? `${them.name}: “${them.win}”` : "Tie. Same throw.");
    haptic(result === 1 ? "medium" : result === -1 ? "heavy" : "light");
  };

  const share = async () => {
    const blob = await drawCard(me, them, mine, theirs);
    await shareCard(blob, mine > theirs ? `My bot ${me.name} beat ${them.name}. Think yours can beat mine?` : `${them.name} got me. Think your bot can beat mine?`, challengeUrl(me));
  };

  const dare = async () => {
    const url = challengeUrl(me);
    const nav = navigator as Navigator;
    if (nav.share) await nav.share({ text: `My bot ${me.emoji} ${me.name} wants a rock-paper-scissors match.`, url }).catch(() => {});
    else {
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success("Challenge link copied");
    }
  };

  return (
    <div className="mt-6">
      <div className="flex items-stretch gap-2">
        <BotCard b={me} dim={over && mine < theirs} />
        <div className="flex shrink-0 flex-col items-center justify-center font-heading">
          <div className="text-3xl font-black tabular-nums">{mine}<span className="text-white/30">:</span>{theirs}</div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">first to {FIRST_TO}</div>
        </div>
        <BotCard
          b={them}
          dim={over && theirs < mine}
          onReport={IOS_APP && isChallenge ? () => openSafety({ name: `@${them.handle}`, text: `${them.name}: ${them.catchphrase}`, world: "bots" }) : undefined}
        />
      </div>

      <div className="mt-4 min-h-[52px] rounded-xl bg-white/[0.04] px-4 py-3 text-center text-sm text-white/80">
        {last && (
          <span className="mr-2 text-lg">
            {THROW_EMOJI[last.mine]} vs {THROW_EMOJI[last.theirs]}
          </span>
        )}
        {line}
      </div>

      {!over ? (
        <>
          <p className="mt-5 text-center text-xs text-white/50">
            Coach's read on {them.name}: <i>“{them.tell}”</i>
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {THROWS.map((t) => (
              <button key={t} onClick={() => play(t)} className="flex h-24 flex-col items-center justify-center rounded-2xl border border-white/15 bg-white/[0.05] active:scale-95">
                <span className="text-4xl">{THROW_EMOJI[t]}</span>
                <span className="mt-1 text-[11px] uppercase tracking-wider text-white/60">{t}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-6 space-y-3">
          <div className="text-center font-heading text-2xl font-black">{mine > theirs ? `${me.name} wins!` : `${them.name} wins.`}</div>
          <button onClick={share} className="h-12 w-full rounded-xl bg-[#ffb23f] font-bold text-black">Share the result card</button>
          <button onClick={dare} className="h-12 w-full rounded-xl border border-white/20 font-semibold">Challenge a friend</button>
          <button onClick={() => (setRounds([]), setLine(them.catchphrase))} className="h-10 w-full text-sm text-white/60">Rematch</button>
        </div>
      )}

      <div className="mt-8 flex justify-center gap-5 text-xs text-white/40">
        {!over && <button onClick={dare} className="underline">Challenge a friend</button>}
        {isChallenge && <button onClick={onHouse} className="underline">Spar with Vibey instead</button>}
        <button onClick={onReforge} className="underline">Forge a new bot</button>
      </div>
    </div>
  );
}
