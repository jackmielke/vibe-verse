/**
 * StartFlow — the first sixty seconds of the VibeVerse.
 *
 * Brand-new visitors land here (HubV2 redirects anyone with no saved
 * name/character). Three quick beats over the VibeVerse poster:
 *
 *   1. splash    — the poster, a sliding light, "every builder grows
 *                  the universe". One tap to begin.
 *   2. name+char — "what should we call you?" with a rerollable
 *                  generated name, then a big friendly character grid.
 *   3. account   — email → 6-digit code (the email carries a tap-link
 *                  too), OR one tap to continue as guest. Zero
 *                  pressure; guests keep everything in localStorage.
 *
 * Then straight into the island arrival cinematic — the payoff.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CHARACTERS } from "@/lib/characters";
import { generateCharacterName } from "@/lib/character-naming";
import { setActiveCharacter } from "@/hooks/use-active-character";
import { VIBEVERSE_POSTER_URL } from "@/components/city/cardboardIsland";

const FEATURED_IDS = [
  "vibey", "Ninja_Female", "Pirate_Anne", "Wizard", "Knight_Golden_Male",
  "Cowboy_Female", "Chef_Male", "Zombie_Male", "Pug", "Cow", "alien", "Witch",
];

type Step = "splash" | "name" | "char" | "account";

export default function StartFlow() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("splash");
  const [posterOk, setPosterOk] = useState(true);
  const [name, setName] = useState(() => generateCharacterName("Vibey"));
  const [charId, setCharId] = useState("vibey");
  const [showAll, setShowAll] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const featured = useMemo(
    () =>
      FEATURED_IDS.map((id) => CHARACTERS.find((c) => c.id === id)).filter(
        (c): c is (typeof CHARACTERS)[number] => !!c,
      ),
    [],
  );
  const roster = showAll ? CHARACTERS : featured;
  const chosen = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];

  // Auto-advance the splash after the light sweep (tap skips it).
  useEffect(() => {
    if (step !== "splash") return;
    const t = window.setTimeout(() => setStep("name"), 2600);
    return () => window.clearTimeout(t);
  }, [step]);

  const finish = () => {
    const finalName = name.trim() || generateCharacterName(chosen.label);
    setActiveCharacter(charId);
    try {
      localStorage.setItem("city.playerName", finalName);
      localStorage.setItem("city.displayName", finalName);
    } catch { /* private mode */ }
    navigate("/city?spawn=island&fresh=1", { replace: true });
  };

  const sendCode = async () => {
    const em = email.trim();
    if (!em || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: em,
        options: { emailRedirectTo: `${window.location.origin}/city?spawn=island` },
      });
      if (error) throw error;
      setCodeSent(true);
      toast.success("Code sent ✨ check your email");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  };
  const verifyCode = async () => {
    const token = code.replace(/\D/g, "");
    if (token.length < 6 || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: "email" });
      if (error) throw error;
      toast.success("Account ready — welcome to the Vibe ✨");
      finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That code didn't match");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b1e33] text-white">
      <style>{`
        @keyframes start-sweep { 0% { transform: translateX(-130%) skewX(-18deg);} 100% { transform: translateX(430%) skewX(-18deg);} }
        @keyframes start-rise { from { opacity: 0; transform: translateY(26px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes start-pop { 0% { transform: scale(0.92);} 60% { transform: scale(1.04);} 100% { transform: scale(1);} }
        .start-card { animation: start-rise .5s cubic-bezier(.2,.8,.2,1) both; }
      `}</style>

      {/* The VibeVerse poster fills the sky behind everything. */}
      {posterOk && (
        <img
          src={VIBEVERSE_POSTER_URL}
          onError={() => setPosterOk(false)}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      {!posterOk && (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(180deg,#2470dd 0%,#4f9bee 55%,#8fcbf6 100%)" }}
        />
      )}
      {/* Readability scrim, heavier at the bottom where the cards live. */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, rgba(8,16,32,0.25) 0%, rgba(8,16,32,0.45) 55%, rgba(8,16,32,0.88) 100%)" }}
      />

      {/* ---- splash ---- */}
      {step === "splash" && (
        <button
          onClick={() => setStep("name")}
          className="absolute inset-0 flex flex-col items-center justify-end pb-20 px-8 text-center"
        >
          <div className="relative overflow-hidden rounded-2xl px-6 py-4">
            <h1 className="font-heading text-3xl sm:text-4xl font-bold tracking-[0.18em] drop-shadow-[0_4px_20px_rgba(0,0,0,0.6)]">
              VIBEVERSE
            </h1>
            <p className="mt-2 text-[11px] tracking-[0.32em] uppercase text-white/85">
              every builder grows the universe
            </p>
            {/* The sliding light — the "loading" beat. */}
            <div
              className="pointer-events-none absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-white/45 to-transparent"
              style={{ animation: "start-sweep 1.9s ease-in-out .2s both" }}
            />
          </div>
          <div className="mt-6 h-1 w-44 rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full bg-white/85 rounded-full"
              style={{ animation: "start-sweep 2.2s ease-in-out both" }}
            />
          </div>
          <p className="mt-4 text-xs text-white/60">tap anywhere</p>
        </button>
      )}

      {/* ---- name ---- */}
      {step === "name" && (
        <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
          <div className="start-card max-w-md mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-6 space-y-4">
            <div>
              <h2 className="font-heading text-2xl font-bold">Hey, traveler 👋</h2>
              <p className="text-sm text-white/60 mt-1">What should the island call you?</p>
            </div>
            <div className="flex gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 24))}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && setStep("char")}
                className="flex-1 min-w-0 h-12 px-4 rounded-2xl border border-white/15 focus:border-emerald-300/70 outline-none text-lg font-semibold text-white"
                style={{ backgroundColor: "rgba(255,255,255,0.08)", caretColor: "#6ee7b7" }}
              />
              <button
                onClick={() => setName(generateCharacterName(chosen.label))}
                className="w-13 px-4 rounded-2xl bg-white/8 border border-white/15 hover:bg-white/15 text-xl"
                title="Roll a new name"
              >
                🎲
              </button>
            </div>
            <button
              onClick={() => name.trim() && setStep("char")}
              disabled={!name.trim()}
              className="w-full h-13 py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors disabled:opacity-40"
            >
              That's me →
            </button>
          </div>
        </div>
      )}

      {/* ---- character ---- */}
      {step === "char" && (
        <div className="absolute inset-x-0 bottom-0 top-14 flex flex-col justify-end p-5 pb-8">
          <div className="start-card max-w-md w-full mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-6 space-y-4 max-h-full overflow-hidden flex flex-col">
            <div>
              <h2 className="font-heading text-2xl font-bold">Pick your vibe, {name.trim()}</h2>
              <p className="text-sm text-white/60 mt-1">You can swap anytime — this is just your first body.</p>
            </div>
            <div className="grid grid-cols-4 gap-2.5 overflow-y-auto">
              {roster.map((c) => {
                const on = c.id === charId;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCharId(c.id)}
                    className={`rounded-2xl p-2.5 flex flex-col items-center gap-1 transition-all ${
                      on ? "bg-emerald-400/20" : "bg-white/6 hover:bg-white/12"
                    }`}
                    style={on ? { boxShadow: `0 0 0 2px ${c.accent}`, animation: "start-pop .3s both" } : undefined}
                  >
                    <span className="text-3xl">{c.emoji}</span>
                    <span className="text-[9.5px] text-white/75 leading-tight text-center truncate w-full">
                      {c.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {!showAll && (
              <button onClick={() => setShowAll(true)} className="text-xs text-white/55 hover:text-white">
                show everyone ({CHARACTERS.length}) ↓
              </button>
            )}
            <button
              onClick={() => setStep("account")}
              className="w-full h-13 py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors"
            >
              {chosen.emoji} Let's go →
            </button>
          </div>
        </div>
      )}

      {/* ---- account (or guest) ---- */}
      {step === "account" && (
        <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
          <div className="start-card max-w-md mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-6 space-y-4">
            <div>
              <h2 className="font-heading text-2xl font-bold">Save your vibe?</h2>
              <p className="text-sm text-white/60 mt-1">
                An account keeps {name.trim()} and your ✦ coins on every device.
                Totally optional.
              </p>
            </div>
            {!codeSent ? (
              <>
                <div className="flex gap-2">
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void sendCode()}
                    className="flex-1 min-w-0 h-13 py-3.5 px-4 rounded-2xl bg-white/8 border border-white/15 focus:border-emerald-300/70 outline-none"
                  />
                  <button
                    onClick={() => void sendCode()}
                    disabled={busy || !email.trim()}
                    className="px-4 rounded-2xl bg-emerald-400 text-emerald-950 font-bold hover:bg-emerald-300 transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    {busy ? "…" : "Send code"}
                  </button>
                </div>
                <p className="text-[11px] text-white/45">
                  We email you a 6-digit code (and a one-tap link — either works).
                </p>
              </>
            ) : (
              <>
                <input
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && void verifyCode()}
                  className="w-full h-14 rounded-2xl bg-white/8 border border-white/15 focus:border-emerald-300/70 outline-none text-center text-2xl tracking-[0.5em] font-mono"
                />
                <button
                  onClick={() => void verifyCode()}
                  disabled={busy || code.length < 6}
                  className="w-full h-13 py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors disabled:opacity-40"
                >
                  {busy ? "Checking…" : "Verify & enter the Vibe"}
                </button>
                <div className="flex justify-between text-[11px] text-white/45">
                  <button onClick={() => setCodeSent(false)} className="hover:text-white">different email</button>
                  <button onClick={() => void sendCode()} disabled={busy} className="hover:text-white">resend code</button>
                </div>
              </>
            )}
            <button
              onClick={finish}
              className="w-full h-13 py-3.5 rounded-2xl bg-white/10 ring-1 ring-white/20 font-semibold text-white/90 hover:bg-white/15 transition-colors"
            >
              🎮 Continue as guest
            </button>
            <p className="text-[10px] text-white/35 text-center">
              guests keep their vibe on this device — you can add an email later from the top-right chip
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
