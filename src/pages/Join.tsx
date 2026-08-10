/**
 * /join/:code — the front door of the event.
 *
 * Somebody has been handed a link. This page has about four seconds to make
 * them want to be here, and then it has to get out of the way. Everything about
 * its shape follows from that:
 *
 * - **The coins land before anything is asked of them.** Claiming works as a
 *   guest, because a sign-in wall in front of a gift is how you lose eight of
 *   the ten people you invited. The account and the wallet are offered *after*,
 *   as ways to keep what they now have.
 * - **The code is the only secret.** `vibe_invites` has no read policy at all,
 *   so the page asks the server what the link is worth rather than reading the
 *   table. Anyone without a link learns nothing.
 * - **One button at the end.** The whole point is to get them into ORBIT with a
 *   stake in the pot, so the page ends with exactly that and nothing competing.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWink from "@/components/VibeWink";
import VibeWalletConnect from "@/components/VibeWalletConnect";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import {
  claimInvite,
  countdown,
  fetchRound,
  hasClaimedLocally,
  markClaimed,
  peekInvite,
  type InvitePeek,
  type RoundView,
} from "@/lib/rounds";

export default function Join() {
  const { code = "" } = useParams();
  const upper = code.trim().toUpperCase();
  const { balance } = useVibecoin();
  const { isGuest, displayName } = useVibeIdentity();

  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [claimed, setClaimed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState<RoundView["round"]>(null);
  const [authOpen, setAuthOpen] = useState(false);

  const load = useCallback(async () => {
    setPeek(await peekInvite(upper));
    try {
      setRound((await fetchRound()).round);
    } catch {
      /* The round is a nice-to-have on this page; the gift is the point. */
    }
  }, [upper]);

  useEffect(() => {
    void load();
  }, [load]);

  const onClaim = async () => {
    setBusy(true);
    try {
      const r = await claimInvite(upper);
      markClaimed(upper);
      setClaimed(r.granted);
      void load();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/already claimed/i.test(msg)) {
        markClaimed(upper);
        setClaimed(0);
      }
      toast.error("Could not claim that", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const alreadyLocally = hasClaimedLocally(upper);
  const gone = peek && !peek.valid && !peek.expired && peek.remaining === 0;

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#03050c] text-foreground">
      {/* The sky. Same family as ORBIT so the link and the game feel like one
          place rather than a landing page bolted onto a game. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(75% 55% at 50% -12%, hsl(200 92% 55% / 0.20), transparent 62%)," +
            "radial-gradient(55% 45% at 86% 16%, hsl(268 88% 62% / 0.18), transparent 68%)," +
            "radial-gradient(60% 45% at 10% 92%, hsl(160 88% 52% / 0.13), transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-[100dvh] max-w-lg flex-col justify-center px-5 py-16">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55 }}
          className="text-center"
        >
          {/* The wink, at the top of the one page every guest sees first. It
              was written months ago and imported by nothing — an emblem that
              only exists in the source is not a brand. */}
          <div className="flex justify-center">
            <VibeWink size={112} speed={0.85} />
          </div>
          <p className="mt-1 font-heading text-[9px] font-bold uppercase tracking-[0.44em] text-[#8fb4ff]">
            You have been invited
          </p>
          <h1
            className="mt-3 font-heading text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl"
            style={{
              color: "#eafff8",
              textShadow: "0 0 18px hsl(170 90% 60% / 0.5), 0 0 60px hsl(200 90% 60% / 0.35)",
            }}
          >
            THE VIBEVERSE
          </h1>
          <p className="mx-auto mt-3.5 max-w-sm text-[13.5px] leading-relaxed text-muted-foreground">
            Forty-odd worlds in one browser tab, a currency that runs through all of
            them, and a pot on the table tonight.
          </p>
        </motion.div>

        {/* ---- the gift ---- */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.12 }}
          className="mt-8"
        >
          <AnimatePresence mode="wait">
            {claimed != null ? (
              <motion.div
                key="claimed"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-3xl border border-[#7dffd4]/40 bg-[#7dffd4]/[0.07] p-6 text-center"
              >
                <div className="flex items-center justify-center gap-3">
                  <VibeCoinMark size={44} />
                  <span className="font-heading text-4xl font-black tabular-nums text-[#7dffd4]">
                    {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
                  </span>
                </div>
                <p className="mt-2 font-heading text-[9px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                  Vibey Coins · yours
                </p>
                <p className="mt-3 text-[12.5px] leading-relaxed text-foreground/80">
                  {claimed > 0
                    ? `${claimed} ${VIBECOIN_GLYPH} landed. Spend it in the shop, or stake it on ORBIT and try to take the pot.`
                    : "You had already claimed this link — your balance is above."}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="offer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="rounded-3xl border border-border/50 bg-black/35 p-6 text-center backdrop-blur-sm"
              >
                {peek === null ? (
                  <p className="py-6 text-[12.5px] text-muted-foreground">Checking the link…</p>
                ) : peek.expired ? (
                  <p className="py-4 text-[13px] text-amber-300/90">
                    This link has expired. Ask for a fresh one.
                  </p>
                ) : gone ? (
                  <p className="py-4 text-[13px] text-amber-300/90">
                    Every slot on this link has been taken. You can still play — you
                    just start with the standard hundred.
                  </p>
                ) : !peek.valid ? (
                  <p className="py-4 text-[13px] text-amber-300/90">
                    That code does not look right. Check the link you were sent.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-center gap-3">
                      <VibeCoinMark size={44} />
                      <span className="font-heading text-4xl font-black tabular-nums text-[#7dffd4]">
                        {peek.grant}
                      </span>
                    </div>
                    <p className="mt-2 font-heading text-[9px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                      Vibey Coins, waiting for you
                    </p>
                    {peek.note && (
                      <p className="mt-2.5 text-[12px] text-foreground/70">{peek.note}</p>
                    )}
                    <button
                      onClick={() => void onClaim()}
                      disabled={busy || alreadyLocally}
                      className="mt-5 w-full rounded-2xl bg-[#7dffd4] px-4 py-3.5 font-heading text-[12px] font-black uppercase tracking-[0.18em] text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {busy ? "Claiming…" : alreadyLocally ? "Already claimed" : "Claim it"}
                    </button>
                    <p className="mt-2.5 text-[11px] text-muted-foreground/70">
                      {peek.remaining} of these left · no account needed
                    </p>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ---- what to do with it ---- */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-5 flex flex-col gap-3"
        >
          {round && round.status === "open" && (
            <Link
              to="/orbit"
              className="group flex items-center gap-3 rounded-2xl border border-[#8fb4ff]/35 bg-[#8fb4ff]/[0.07] p-4 transition-colors hover:border-[#8fb4ff]/60"
            >
              <span className="text-2xl leading-none">🛰️</span>
              <div className="min-w-0 flex-1">
                <p className="font-heading text-[12px] font-black uppercase tracking-wider text-[#8fb4ff]">
                  {round.title}
                </p>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {round.pot} {VIBECOIN_GLYPH} in the pot · {round.entries} flying ·
                  closes in {countdown(round.closesAt)}
                </p>
              </div>
              <span className="shrink-0 font-heading text-[10px] font-black uppercase tracking-wider text-[#8fb4ff] transition-transform group-hover:translate-x-0.5">
                Play →
              </span>
            </Link>
          )}

          {/* Sign-in comes AFTER the gift, framed as keeping it rather than as a
              gate in front of it. */}
          {isGuest && (
            <div className="rounded-2xl border border-border/50 bg-black/28 p-4">
              <p className="font-heading text-[11px] font-black uppercase tracking-wider text-foreground/85">
                Keep it across devices
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Right now your coins live in this browser. Make an account and they
                come with you — everything you have already earned moves across.
              </p>
              {/* Not `LogInWithVibe` — that is a 28px round chip sized for the
                  nav, and a bare "?" circle is not a call to action inside a
                  card that has just asked somebody to make an account. Same
                  dialog, a button that says what it does. */}
              <button
                onClick={() => setAuthOpen(true)}
                className="mt-3 w-full rounded-xl border border-[#8fb4ff]/40 bg-[#8fb4ff]/[0.10] px-4 py-2.5 font-heading text-[10px] font-black uppercase tracking-[0.16em] text-[#8fb4ff] transition-colors hover:border-[#8fb4ff]/70 hover:bg-[#8fb4ff]/[0.16]"
              >
                Make an account
              </button>
            </div>
          )}

          <VibeWalletConnect displayName={isGuest ? undefined : displayName} />
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-7 text-center text-[10.5px] leading-relaxed text-muted-foreground/55"
        >
          Vibey Coins are play money that run across the whole vibeverse. Vibecoin ($VIBE) is a
          real token on Base and this app never sends a transaction — linking a
          wallet only tells us where to post a drop.{" "}
          <Link to="/" className="underline underline-offset-2 hover:text-muted-foreground">
            Look around first
          </Link>
          .
        </motion.p>
      </div>

      <VibeAuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  );
}
