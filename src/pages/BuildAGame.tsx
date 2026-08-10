/**
 * `/build` — the page you send somebody who says "I made a game".
 *
 * It is deliberately one screen and mostly code. The audience is a person who
 * has already built something and wants to know two things: what do I add, and
 * what are you going to do with my game. Everything else — the architecture,
 * the reasoning, the budgets table — is downstream of those, and a page that
 * leads with architecture loses the eight-year-old.
 *
 * The honest bits are not buried. What we can see (nothing), what we can do
 * (nothing), and what the ceiling is (a number) are all above the fold of the
 * second section, because those are the questions somebody sensible asks
 * second and the answers are good.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { listPortalGames, type PortalGameListing } from "@/portal/api";
import { VIBECOIN_GLYPH, VIBECOIN_NAME } from "@/lib/vibecoin";

/**
 * The snippet, with the SDK's real URL in it.
 *
 * Derived from wherever this page is being served rather than typed in as a
 * constant. The first cut hard-coded a domain that did not exist, which makes
 * the one thing on the page somebody is guaranteed to copy the one thing that
 * cannot work — and nothing in a build or a test would ever have caught it.
 */
function snippet(origin: string): string {
  return `<script src="${origin}/vibeverse.js"></script>
<script>
  // 1. say hello — tells you what a coin is called and what you can pay
  const vibe = await Vibeverse.ready();

  // 2. …your game…

  // 3. pay the player. This is a REQUEST: check what came back.
  const paid = await Vibeverse.award(5, "cleared level 2");
  hud.show(paid.amount);          // what actually landed, not the 5

  // 4. a way out, if you want one of your own
  Vibeverse.exit();
</script>`;
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-border/50 bg-[#070c16] p-4 text-[11.5px] leading-relaxed text-foreground/90">
        <code>{text}</code>
      </pre>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          });
        }}
        className="absolute right-2 top-2 flex items-center gap-1.5 rounded-lg border border-border/50 bg-[#0d1524] px-2.5 py-1.5 font-heading text-[9px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        {done ? <Check className="h-3 w-3 text-[#7dffd4]" /> : <Copy className="h-3 w-3" />}
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Rule({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/40 bg-white/[0.02] p-4">
      <h3 className="font-heading text-[11px] font-bold uppercase tracking-[0.15em] text-[#7dffd4]">
        {title}
      </h3>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export default function BuildAGame() {
  useWorldStamp("/build", "The Portal");
  const [games, setGames] = useState<PortalGameListing[] | null>(null);
  const code = snippet(window.location.origin);

  useEffect(() => {
    let live = true;
    void listPortalGames()
      .then((r) => live && setGames(r.games))
      .catch(() => live && setGames([]));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background pb-24 pt-20">
      <div className="mx-auto w-full max-w-3xl px-5">
        <Link
          to="/arcade"
          className="inline-flex items-center gap-1.5 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Arcade
        </Link>

        <header className="mt-6">
          <h1 className="font-heading text-4xl font-black leading-[1.05] tracking-tight text-foreground sm:text-5xl">
            Put your game in
            <br />
            the vibeverse.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Your game stays yours. It lives on your domain, in your repo, under
            your name. Add four lines and it can pay the people who play it in{" "}
            {VIBECOIN_NAME} — the same coins as everywhere else in here.
          </p>
        </header>

        {/* The code first. Somebody who builds things wants to see the shape of
            it before they want to read your reasoning about it. */}
        <section className="mt-10">
          <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            The whole API
          </h2>
          <div className="mt-3">
            <Copyable text={code} />
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            That is all of it. No build step, no npm install, no key, no
            account. Open your game outside the vibeverse and every call still
            resolves — <code className="text-foreground/80">Vibeverse.inVibeverse</code>{" "}
            is false and <code className="text-foreground/80">award()</code>{" "}
            reports zero paid — so you can build the whole thing on localhost
            first.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            The deal, in four lines
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Rule title="You cannot mint">
              <code className="text-foreground/80">award(5)</code> asks for
              five. What you get back is what was actually paid, which is the
              smallest of your ask, a per-award cap, and three budgets that run
              down through the day. When they hit zero it returns zero — and
              your game should still be fun. Show the number that came back,
              never the one you asked for.
            </Rule>
            <Rule title="You see nothing about the player">
              No name, no email, no wallet, no balance, no id. The handshake
              hands you what a coin is called and what you may pay. There is
              nothing else in it, so there is nothing for you to leak.
            </Rule>
            <Rule title="You are in a sandbox">
              No camera, no microphone, no location, no popups, and no ability
              to navigate the player anywhere. That is the browser enforcing it,
              not us trusting you — which is what makes it possible to say yes
              to a stranger.
            </Rule>
            <Rule title="Batch your awards">
              One award per point scored will hit the request ceiling long
              before it hits a budget. Keep a running total in your game and
              flush it at the end of a round, or every few seconds.
            </Rule>
          </div>
        </section>

        <section className="mt-12">
          <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Getting listed
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
            <Link to="/submit-game" className="text-[#7dffd4] hover:underline">
              Paste your link into the form
            </Link>
            . A deployed URL gets framed where it stands; an open-source
            repository gets its static files copied at one exact commit, so it
            works even if you delete the repo tomorrow. Either way it is playable
            within about a minute, on a link only you and a reviewer have.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
            Then a person plays it and gives it a row: a slug, the URL, the one
            origin allowed to talk to us, and four numbers that bound what it can
            cost. Those numbers are the reason this can be open — approving a
            game is deciding what it is worth per day, not deciding whether to
            trust you.
          </p>
          <Link
            to="/submit-game"
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#7dffd4] px-5 py-3 font-heading text-[11px] font-bold uppercase tracking-wider text-[#04121c]"
          >
            Submit a game
          </Link>
        </section>

        <section className="mt-12">
          <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Already in
          </h2>
          <div className="mt-3 space-y-2">
            {games == null ? (
              <p className="text-[13px] text-muted-foreground/60">Looking…</p>
            ) : games.length === 0 ? (
              <p className="text-[13px] text-muted-foreground/60">
                Nothing yet. Yours could be the first.
              </p>
            ) : (
              games.map((g) => (
                <Link
                  key={g.slug}
                  to={`/play/${g.slug}`}
                  className="flex items-center gap-3 rounded-xl border border-border/40 bg-white/[0.02] px-4 py-3 transition-colors hover:border-border hover:bg-white/[0.05]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading text-[13px] font-bold text-foreground">
                      {g.title}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {g.tagline}
                      {g.author ? ` · ${g.author}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="flex items-center justify-end gap-1 font-heading text-[12px] font-bold tabular-nums text-[#7dffd4]">
                      <VibeCoinMark size={12} />
                      {g.remainingToday}
                    </div>
                    <div className="text-[9px] leading-none text-muted-foreground/60">
                      left today
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>

        <p className="mt-12 border-t border-border/30 pt-6 text-[12px] leading-relaxed text-muted-foreground/70">
          The reference game,{" "}
          <Link to="/play/coin-drop" className="text-[#7dffd4] hover:underline">
            Coin Drop
          </Link>
          , is about two hundred lines of plain HTML with no framework and no
          build step, and it uses exactly the four calls above. It is served
          from this site but goes through the same sandbox, the same bridge and
          the same budgets as anybody else's — so if it works, the path works.
          Read it at{" "}
          <code className="text-foreground/70">public/games/coin-drop/index.html</code>.
          <span className="mt-2 block">
            {VIBECOIN_GLYPH} {VIBECOIN_NAME} are play money, and the ledger is
            ours. Nothing here touches anyone's chain wallet.
          </span>
        </p>
      </div>
    </div>
  );
}
