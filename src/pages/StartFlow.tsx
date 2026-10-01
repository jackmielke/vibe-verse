/**
 * StartFlow — the first sixty seconds of the VibeVerse, hosted by Vibey.
 *
 * Brand-new visitors land here (HubV2 redirects anyone with no saved
 * name/character). A live 3D vista of the VibeVerse fills the sky and
 * Vibey — the friendly robot who lives here — rides in the corner of
 * the frame and walks you through it, poster-style:
 *
 *   1. splash    — "EVERY BUILDER GROWS THE UNIVERSE / VIBEVERSE".
 *   2. adventure — Vibey asks: what kind of adventure do you want
 *                  today? EXPLORE · BUILD · CREATE · CONNECT.
 *   3. name      — a rerollable generated name.
 *   4. char      — the character grid ("your first body").
 *   5. account   — email link/code, or one tap to enter as guest.
 *
 * You can talk back to Vibey at every step (same unit7-chat brain the
 * in-world Vibey uses), and a skip chip drops you straight onto the
 * island at any point. The emailed magic link signs this tab in via
 * the cross-tab auth listener, so the flow completes either way.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CHARACTERS } from "@/lib/characters";
import { generateCharacterName } from "@/lib/character-naming";
import { setActiveCharacter } from "@/hooks/use-active-character";
import StartBackdrop from "@/components/StartBackdrop";
import { IOS_APP } from "@/lib/iosApp";

const FEATURED_IDS = [
  "vibey", "Ninja_Female", "Pirate_Anne", "Wizard", "Knight_Golden_Male",
  "Cowboy_Female", "Chef_Male", "Zombie_Male", "Pug", "Cow", "alien", "Witch",
];

type Step = "splash" | "adventure" | "name" | "char" | "account";
type Adventure = "explore" | "build" | "create" | "connect";

const ADVENTURES: Array<{ key: Adventure; icon: string; label: string; blurb: string }> = [
  { key: "explore", icon: "🌍", label: "EXPLORE", blurb: "see the worlds" },
  { key: "build", icon: "🔨", label: "BUILD", blurb: "make stuff exist" },
  { key: "create", icon: "🌱", label: "CREATE", blurb: "make it yours" },
  { key: "connect", icon: "👥", label: "CONNECT", blurb: "find the others" },
];

// Vibey's scripted beats — the chat can riff, these anchor each step.
const VIBEY_LINES: Record<Step, (name: string, adv: Adventure | null) => string> = {
  splash: () => "",
  adventure: () => "Hey, I'm Vibey! 🤖 Welcome home. What kind of adventure do you want today?",
  name: (_n, adv) =>
    adv === "build"
      ? "A builder!! My favorite kind of visitor. First things first — what should the island call you?"
      : adv === "create"
        ? "A creator — excellent. Everything here started as someone's doodle. What should the island call you?"
        : adv === "connect"
          ? "Looking for the others! They're around — the plaza's never empty. What should the island call you?"
          : "An explorer! There's a LOT out there — ski peaks, moons, a zeppelin. What should the island call you?",
  char: (name) => `Love it, ${name}. Now pick your vibe — this is just your first body, my Character Studio can swap it anytime.`,
  account: (name) =>
    `Last thing, ${name} — want me to remember you? An email keeps your ${IOS_APP ? "progress" : "✦"} on every device. Or just dive in as a guest, zero pressure.`,
};

// Steering for the shared NPC brain: keep Vibey short, warm, on-task.
const VIBEY_GUIDE_PREFIX =
  "(You are VIBEY, the friendly robot guide of the VibeVerse — a magically weird " +
  "universe of floating islands: Vibe Island with its SnackFe, Character Studio, God " +
  "Orb (wishes become real features, built within ~10 hours), VIBE FM radio, ninja " +
  "palace reality show, plus Powder Peak ski world, Moon Golf, a rebel-defense moon, " +
  "and a Pokémon-GO-style mobile mode called VIBE GO. You are currently welcoming a " +
  "brand-new visitor through onboarding. Be warm, playful, and BRIEF — max 2 short " +
  "sentences. Never break character. If they ask what to do, point at one concrete " +
  "fun thing. The visitor says:) ";

export default function StartFlow() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("splash");
  const [adventure, setAdventure] = useState<Adventure | null>(null);
  const [name, setName] = useState(() => generateCharacterName("Vibey"));
  const [charId, setCharId] = useState("vibey");
  const [showAll, setShowAll] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  // Vibey talk-back.
  const [vibeySay, setVibeySay] = useState<string | null>(null);
  const [vibeyThinking, setVibeyThinking] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const vibeyHistory = useRef<Array<{ role: string; content: string }>>([]);
  // Ref mirrors so the cross-tab auth listener always finishes with the
  // latest picks instead of a stale closure.
  const latest = useRef({ step, name, charId, adventure });
  latest.current = { step, name, charId, adventure };

  const featured = useMemo(
    () =>
      FEATURED_IDS.map((id) => CHARACTERS.find((c) => c.id === id)).filter(
        (c): c is (typeof CHARACTERS)[number] => !!c,
      ),
    [],
  );
  const roster = showAll ? CHARACTERS : featured;
  const chosen = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
  const vibeyUrl = useMemo(() => CHARACTERS.find((c) => c.id === "vibey")?.url, []);

  // Auto-advance the splash after the light sweep (tap skips it).
  useEffect(() => {
    if (step !== "splash") return;
    const t = window.setTimeout(() => setStep("adventure"), 2600);
    return () => window.clearTimeout(t);
  }, [step]);

  // Fresh scripted line whenever the step changes (chat replies override
  // until the next step).
  useEffect(() => {
    setVibeySay(null);
  }, [step]);

  const finish = () => {
    const { name: n, charId: c, adventure: adv } = latest.current;
    const pick = CHARACTERS.find((x) => x.id === c) ?? CHARACTERS[0];
    const finalName = n.trim() || generateCharacterName(pick.label);
    setActiveCharacter(pick.id);
    try {
      localStorage.setItem("city.playerName", finalName);
      localStorage.setItem("city.displayName", finalName);
      if (adv) localStorage.setItem("vibe.adventure", adv);
    } catch { /* private mode */ }
    navigate("/city?spawn=hub&fresh=1", { replace: true });
  };

  // Until the Supabase email template shows the 6-digit code, the email
  // leads with a magic LINK. Tapping it signs this browser in (auth
  // state syncs across tabs) — ride the session straight into the world.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, session) => {
      if (session && latest.current.step === "account") {
        toast.success("Signed in — welcome to the Vibe ✨");
        finish();
      }
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const askVibey = async () => {
    const text = chatDraft.trim();
    if (!text || vibeyThinking) return;
    setChatDraft("");
    setVibeyThinking(true);
    try {
      const { data, error } = await supabase.functions.invoke("unit7-chat", {
        body: {
          history: vibeyHistory.current.slice(-10),
          text: VIBEY_GUIDE_PREFIX + text,
        },
      });
      if (error) throw error;
      const say =
        data && typeof data === "object" && "say" in data
          ? String((data as Record<string, unknown>).say)
          : null;
      if (!say) throw new Error("bad reply");
      vibeyHistory.current.push({ role: "user", content: text }, { role: "assistant", content: say });
      setVibeySay(say);
    } catch {
      setVibeySay("My uplink's a little fuzzy out here — but trust me, it's great inside. 🤖✨");
    } finally {
      setVibeyThinking(false);
    }
  };

  const sendCode = async () => {
    const em = email.trim();
    if (!em || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: em,
        options: { emailRedirectTo: `${window.location.origin}/city?spawn=hub` },
      });
      if (error) throw error;
      setCodeSent(true);
      toast.success("Sent ✨ check your email");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send the email");
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

  // Vibey's speech bubble + talk-back — rides on top of every card.
  const vibeyBubble = (line: string) => (
    <div className="rounded-2xl bg-[#12233b]/90 ring-1 ring-cyan-300/25 p-3.5 space-y-2.5">
      <div className="flex items-start gap-2.5">
        <div className="w-9 h-9 shrink-0 rounded-full bg-amber-300/90 flex items-center justify-center text-lg shadow-[0_0_14px_rgba(255,209,102,0.5)]">
          🤖
        </div>
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-[0.3em] text-cyan-300/80">Vibey</div>
          <p className="text-[13.5px] leading-snug text-cyan-50">
            {vibeyThinking ? "…" : vibeySay ?? line}
          </p>
        </div>
      </div>
      <div className="flex gap-1.5">
        <input
          value={chatDraft}
          onChange={(e) => setChatDraft(e.target.value.slice(0, 200))}
          onKeyDown={(e) => e.key === "Enter" && void askVibey()}
          placeholder="say something back…"
          className="flex-1 min-w-0 rounded-xl px-3 py-1.5 text-xs border border-white/10 focus:border-cyan-300/60 outline-none text-white placeholder:text-white/35"
          style={{ backgroundColor: "rgba(255,255,255,0.06)", caretColor: "#7af0ff" }}
        />
        <button
          onClick={() => void askVibey()}
          disabled={vibeyThinking || !chatDraft.trim()}
          className="px-3 rounded-xl bg-cyan-400/20 text-cyan-100 text-xs hover:bg-cyan-400/30 disabled:opacity-40 transition-colors"
        >
          ↩
        </button>
      </div>
    </div>
  );

  const skipChip = (
    <button
      onClick={finish}
      className="mx-auto block text-[11px] text-white/45 hover:text-white/80 transition-colors"
    >
      skip — dive in as a guest →
    </button>
  );

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b1e33] text-white">
      <style>{`
        @keyframes start-sweep { 0% { transform: translateX(-130%) skewX(-18deg);} 100% { transform: translateX(430%) skewX(-18deg);} }
        @keyframes start-rise { from { opacity: 0; transform: translateY(26px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes start-pop { 0% { transform: scale(0.92);} 60% { transform: scale(1.04);} 100% { transform: scale(1);} }
        .start-card { animation: start-rise .5s cubic-bezier(.2,.8,.2,1) both; }
        /* Mobile autofill paints inputs white-on-white — force our palette. */
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus {
          -webkit-text-fill-color: #ffffff;
          -webkit-box-shadow: 0 0 0 1000px #16233a inset;
          caret-color: #6ee7b7;
          transition: background-color 99999s ease-in-out 0s;
        }
      `}</style>

      {/* A live 3D postcard of the VibeVerse fills the sky (with Vibey
          riding in the corner) — no image to fetch, works on every host
          and phone. The sky gradient sits behind the alpha canvas. */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg,#2470dd 0%,#4f9bee 55%,#8fcbf6 100%)" }}
      />
      <StartBackdrop companionUrl={vibeyUrl} />
      {/* Readability scrim, heavier at the bottom where the cards live. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(180deg, rgba(8,16,32,0.18) 0%, rgba(8,16,32,0.32) 55%, rgba(8,16,32,0.85) 100%)" }}
      />

      {/* ---- splash: the poster ---- */}
      {step === "splash" && (
        <button
          onClick={() => setStep("adventure")}
          className="absolute inset-0 flex flex-col items-center justify-between py-14 px-8 text-center"
        >
          <p className="text-[11px] tracking-[0.34em] uppercase text-white/90 drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
            every builder grows the universe
          </p>
          <div className="relative overflow-hidden rounded-2xl px-6 py-4">
            <h1 className="font-heading text-4xl sm:text-6xl font-bold tracking-[0.14em] drop-shadow-[0_4px_20px_rgba(0,0,0,0.6)]">
              VIBEVERSE
            </h1>
            <p className="mt-3 text-sm sm:text-base text-white/90 italic drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
              What kind of adventure do you want today?
            </p>
            <div
              className="pointer-events-none absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-white/45 to-transparent"
              style={{ animation: "start-sweep 1.9s ease-in-out .2s both" }}
            />
          </div>
          <div>
            <div className="h-1 w-44 rounded-full bg-white/15 overflow-hidden mx-auto">
              <div
                className="h-full bg-white/85 rounded-full"
                style={{ animation: "start-sweep 2.2s ease-in-out both" }}
              />
            </div>
            <p className="mt-3 text-xs text-white/60 drop-shadow-[0_1px_6px_rgba(0,0,0,0.8)]">tap anywhere</p>
          </div>
        </button>
      )}

      {/* ---- adventure: Vibey's question, poster nav as chips ---- */}
      {step === "adventure" && (
        <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
          <div className="start-card max-w-md mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-5 space-y-4">
            {vibeyBubble(VIBEY_LINES.adventure(name, adventure))}
            <div className="grid grid-cols-2 gap-2.5">
              {ADVENTURES.map((a) => (
                <button
                  key={a.key}
                  onClick={() => {
                    setAdventure(a.key);
                    setStep("name");
                  }}
                  className="rounded-2xl p-4 bg-white/[0.07] hover:bg-white/15 ring-1 ring-white/10 hover:ring-emerald-300/50 transition-all text-left"
                >
                  <div className="text-2xl">{a.icon}</div>
                  <div className="font-heading font-bold tracking-[0.18em] text-sm mt-1.5">{a.label}</div>
                  <div className="text-[11px] text-white/55">{a.blurb}</div>
                </button>
              ))}
            </div>
            {skipChip}
          </div>
        </div>
      )}

      {/* ---- name ---- */}
      {step === "name" && (
        <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
          <div className="start-card max-w-md mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-5 space-y-4">
            {vibeyBubble(VIBEY_LINES.name(name, adventure))}
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
                className="px-4 rounded-2xl bg-white/8 border border-white/15 hover:bg-white/15 text-xl"
                title="Roll a new name"
              >
                🎲
              </button>
            </div>
            <button
              onClick={() => name.trim() && setStep("char")}
              disabled={!name.trim()}
              className="w-full py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors disabled:opacity-40"
            >
              That's me →
            </button>
            {skipChip}
          </div>
        </div>
      )}

      {/* ---- character ---- */}
      {step === "char" && (
        <div className="absolute inset-x-0 bottom-0 top-14 flex flex-col justify-end p-5 pb-8">
          <div className="start-card max-w-md w-full mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-5 space-y-3.5 max-h-full overflow-hidden flex flex-col">
            {vibeyBubble(VIBEY_LINES.char(name.trim(), adventure))}
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
              className="w-full py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors"
            >
              {chosen.emoji} Let's go →
            </button>
          </div>
        </div>
      )}

      {/* ---- account (or guest) ---- */}
      {step === "account" && (
        <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
          <div className="start-card max-w-md mx-auto rounded-3xl bg-[#0d1524]/95 ring-1 ring-white/15 p-5 space-y-4">
            {vibeyBubble(VIBEY_LINES.account(name.trim(), adventure))}
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
                    className="flex-1 min-w-0 py-3.5 px-4 rounded-2xl border border-white/15 focus:border-emerald-300/70 outline-none text-white placeholder:text-white/40"
                    style={{ backgroundColor: "rgba(255,255,255,0.08)", caretColor: "#6ee7b7" }}
                  />
                  <button
                    onClick={() => void sendCode()}
                    disabled={busy || !email.trim()}
                    className="px-4 rounded-2xl bg-emerald-400 text-emerald-950 font-bold hover:bg-emerald-300 transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    {busy ? "…" : "Send it"}
                  </button>
                </div>
                <p className="text-[11px] text-white/45">
                  We'll email you a one-tap sign-in link — and if your email
                  shows a 6-digit code, that works here too.
                </p>
              </>
            ) : (
              <>
                <p className="text-[12px] text-emerald-200/90">
                  ✉️ Sent! Tap the link in the email — this page signs in by
                  itself. Got a 6-digit code instead? Type it here:
                </p>
                <input
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && void verifyCode()}
                  className="w-full h-14 rounded-2xl border border-white/15 focus:border-emerald-300/70 outline-none text-center text-2xl tracking-[0.5em] font-mono text-white placeholder:text-white/30"
                  style={{ backgroundColor: "rgba(255,255,255,0.08)", caretColor: "#6ee7b7" }}
                />
                <button
                  onClick={() => void verifyCode()}
                  disabled={busy || code.length < 6}
                  className="w-full py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors disabled:opacity-40"
                >
                  {busy ? "Checking…" : "Verify & enter the Vibe"}
                </button>
                <div className="flex justify-between text-[11px] text-white/45">
                  <button onClick={() => setCodeSent(false)} className="hover:text-white">different email</button>
                  <button onClick={() => void sendCode()} disabled={busy} className="hover:text-white">resend</button>
                </div>
              </>
            )}
            <button
              onClick={finish}
              className="w-full py-3.5 rounded-2xl bg-white/10 ring-1 ring-white/20 font-semibold text-white/90 hover:bg-white/15 transition-colors"
            >
              🎮 Continue as guest
            </button>
            <p className="text-[10px] text-white/35 text-center">
              guests keep their vibe on this device — add an email later from the top-right chip
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
