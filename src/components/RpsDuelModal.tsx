/**
 * RpsDuelModal — a walk-up rock-paper-scissors duel against an AI resident.
 * v1 is pure client fun: no wagers, no persistence (Jack's roadmap note says
 * "RPS first, wagers later"). Throw a hand, the resident throws a random one,
 * and on your win the resident breaks into a little celebration dance (wired
 * via onWin in City). data-rps / data-rps-result attributes give headless
 * tests stable hooks.
 */
import { useState } from "react";

type Choice = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "tie";

const CHOICES: { key: Choice; emoji: string; label: string }[] = [
  { key: "rock", emoji: "✊", label: "Rock" },
  { key: "paper", emoji: "✋", label: "Paper" },
  { key: "scissors", emoji: "✌️", label: "Scissors" },
];
const EMOJI: Record<Choice, string> = { rock: "✊", paper: "✋", scissors: "✌️" };
// What each choice beats.
const BEATS: Record<Choice, Choice> = { rock: "scissors", paper: "rock", scissors: "paper" };

interface Props {
  agentName: string;
  /** Fired once each time the player wins a round (agent celebrates). */
  onWin: () => void;
  onClose: () => void;
}

export default function RpsDuelModal({ agentName, onWin, onClose }: Props) {
  const [round, setRound] = useState<{ you: Choice; them: Choice; outcome: Outcome } | null>(null);
  const [score, setScore] = useState({ you: 0, them: 0 });

  const play = (you: Choice) => {
    const them = CHOICES[Math.floor(Math.random() * CHOICES.length)].key;
    const outcome: Outcome = you === them ? "tie" : BEATS[you] === them ? "win" : "lose";
    setRound({ you, them, outcome });
    if (outcome === "win") {
      setScore((s) => ({ ...s, you: s.you + 1 }));
      onWin();
    } else if (outcome === "lose") {
      setScore((s) => ({ ...s, them: s.them + 1 }));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-xs rounded-2xl p-5 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-xs uppercase tracking-widest text-primary/80">Duel</div>
        <div className="mb-4 text-lg font-semibold">✊✋✌️ vs {agentName}</div>

        {!round ? (
          <>
            <div className="mb-3 text-sm text-muted-foreground">Throw your hand…</div>
            <div className="flex justify-center gap-3">
              {CHOICES.map((c) => (
                <button
                  key={c.key}
                  data-rps={c.key}
                  onClick={() => play(c.key)}
                  className="glass-panel flex h-16 w-16 flex-col items-center justify-center rounded-xl text-2xl transition-transform hover:scale-110 active:scale-95"
                >
                  <span>{c.emoji}</span>
                  <span className="mt-0.5 text-[9px] text-muted-foreground">{c.label}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-center gap-4 text-3xl">
              <span title="you">{EMOJI[round.you]}</span>
              <span className="text-sm text-muted-foreground">vs</span>
              <span title={agentName}>{EMOJI[round.them]}</span>
            </div>
            <div
              data-rps-result={round.outcome}
              className={`mb-3 text-xl font-bold ${
                round.outcome === "win"
                  ? "text-emerald-400"
                  : round.outcome === "lose"
                  ? "text-rose-400"
                  : "text-amber-300"
              }`}
            >
              {round.outcome === "win"
                ? "You win! 🎉"
                : round.outcome === "lose"
                ? `${agentName} wins`
                : "Tie!"}
            </div>
            <div className="mb-4 text-xs text-muted-foreground">
              You {score.you} · {score.them} {agentName}
            </div>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setRound(null)}
                className="glass-panel rounded-full px-4 py-1.5 text-sm text-primary"
              >
                Again
              </button>
              <button
                onClick={onClose}
                className="glass-panel rounded-full px-4 py-1.5 text-sm text-muted-foreground"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
