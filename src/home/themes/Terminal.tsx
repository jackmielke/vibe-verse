/**
 * Terminal — the whole vibeverse as a directory listing.
 *
 * Monospace, phosphor green, one column, and every world a row with its size
 * and date like `ls -l`. The pictures are gone entirely, which is the argument:
 * fifty-odd worlds is a lot to scan visually, and a list you can read top to
 * bottom in ten seconds may genuinely be the fastest front door here.
 *
 * The rows highlight on hover the way a selected line does in a real terminal —
 * inverted, not tinted. Tinting is a web idea; inversion is what the thing this
 * is imitating actually does.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Scanlines, useHomeData } from "@/home/kit";

const P = "#7dffd4";

export default function Terminal() {
  const d = useHomeData();
  const rows = [...d.featured, ...d.rest];
  const [caret, setCaret] = useState(true);

  useEffect(() => {
    const t = window.setInterval(() => setCaret((c) => !c), 560);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div
      className="relative min-h-[100dvh] w-full bg-[#020604] font-mono text-[13px] leading-[1.55]"
      style={{ color: P }}
    >
      <Scanlines opacity={0.18} />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{ background: "radial-gradient(80% 60% at 50% 40%, transparent 40%, rgba(0,0,0,0.65) 100%)" }}
      />

      <div className="relative z-10 mx-auto max-w-4xl px-4 pb-24 pt-8 sm:px-8">
        <pre className="whitespace-pre-wrap text-[11.5px] opacity-70">{`vibeverse 1.0 — ${d.counts.worlds} worlds mounted
passport ${d.passport.visited}/${d.passport.total}`}</pre>
        {/* A balance of `—` is what every other theme printed before it learned
            to offer a way in. A shell would tell you why it is empty. */}
        <p className="text-[11.5px] opacity-70">
          {d.coin.signedIn ? (
            <>balance {d.coin.display}</>
          ) : (
            <>
              balance —{" "}
              <Link to="/profile" className="underline underline-offset-2 hover:bg-[#7dffd4] hover:text-[#020604]">
                sign in
              </Link>{" "}
              to earn
            </>
          )}
        </p>

        <h1 className="mt-6 text-[15px] font-bold">
          <span className="opacity-60">visitor@vibeverse</span>
          <span className="opacity-40">:~$ </span>
          ls -l /worlds
          <span className={caret ? "opacity-100" : "opacity-0"}>▊</span>
        </h1>

        <p className="mt-3 max-w-xl text-[12px] opacity-60">
          {/* The pitch, as a comment. It is the one place on this page where a
              sentence is allowed to be a sentence. */}
          # a massive collection of AI-coded games. no install, no account,
          <br />
          # no launcher — pick a line and you are in it in a few seconds.
        </p>

        <div className="mt-7 border-t pt-1" style={{ borderColor: `${P}22` }}>
          {rows.map((w, i) => (
            <Link
              key={w.key}
              to={w.route}
              className="group flex items-baseline gap-3 px-2 py-[3px] transition-none hover:bg-[#7dffd4] hover:text-[#020604]"
            >
              <span className="w-8 shrink-0 tabular-nums opacity-40 group-hover:opacity-70">
                {String(i + 1).padStart(3, "0")}
              </span>
              <span className="w-[7.5rem] shrink-0 truncate">{w.name}</span>
              <span className="hidden flex-1 truncate opacity-55 group-hover:opacity-80 sm:block">
                {w.blurb}
              </span>
              <span className="ml-auto shrink-0 tabular-nums opacity-40 group-hover:opacity-70">
                {d.freshness(w.key) ?? "—"}
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-[12px] opacity-60">
          <Link to="/game" className="hover:underline">cd /game</Link>
          <Link to="/arcade" className="hover:underline">cd /arcade</Link>
          <Link to="/chronicle" className="hover:underline">cat /chronicle</Link>
          <Link to="/submit-game" className="hover:underline">./submit-a-game</Link>
        </div>

        <p className="mt-8 text-[11.5px] opacity-35">
          {rows.length} entries · read from the registry, not typed here
        </p>
      </div>
    </div>
  );
}
