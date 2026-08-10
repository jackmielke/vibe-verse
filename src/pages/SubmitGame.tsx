/**
 * `/submit-game` — one field, and everything else is our job.
 *
 * The page `/build` explains the deal and prints the SDK snippet. This is the
 * part where somebody actually hands their game over, and the whole design goal
 * is that they should be able to do it without reading `/build` at all.
 *
 * Hence one input. Not a form with title, tagline, author, category, tags and a
 * screenshot upload — every one of those is a thing we can work out from a link
 * and a thing a person can get bored of typing. A repository knows its own name,
 * its own description, its own owner and its own licence. Asking for them again
 * is asking somebody to do our data entry.
 *
 * The other design goal is that a failure is never a shrug. Every refusal on
 * this page has to end in a next step, because the common failure — a repo that
 * holds source rather than a built site — is not the submitter doing anything
 * wrong, and "no" without "try this instead" is how you lose the person who was
 * about to give you a game.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Github,
  Globe,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  myPortalSubmissions,
  submitPortalGame,
  type PortalSubmission,
  type SubmitResult,
} from "@/portal/api";
import { VIBECOIN_NAME } from "@/lib/vibecoin";

export default function SubmitGame() {
  /* No passport stamp. The Portal is one world and it is stamped at `/build`;
     this is a form inside it, and a second stamp for the same place would be
     the passport counting a door twice. `worlds-registry.test.ts` enforces the
     pairing in both directions, which is how this comment came to exist. */

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [mine, setMine] = useState<PortalSubmission[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void supabase.auth.getUser().then(({ data }) => live && setSignedIn(!!data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (live) setSignedIn(!!session?.user);
    });
    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const refresh = useCallback(() => {
    void myPortalSubmissions()
      .then((r) => setMine(r.submissions))
      .catch(() => setMine([]));
  }, []);

  useEffect(() => {
    if (signedIn) refresh();
  }, [signedIn, refresh]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await submitPortalGame(url.trim(), label.trim() || undefined);
      setResult(r);
      if (r.failed) {
        // Not a toast.error: the submitter did nothing wrong, and the card
        // below says what to do next. A red banner would suggest otherwise.
        toast("We could not use that one — see the note below.");
      } else if (r.alreadyKnown) {
        toast("Already on the desk.");
      } else {
        toast.success("Filed. It is playable right now.");
        setUrl("");
      }
      refresh();
    } catch (err) {
      toast.error("Could not read that link", { description: (err as Error).message });
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-24 pt-20">
      <div className="mx-auto w-full max-w-3xl px-5">
        <Link
          to="/build"
          className="inline-flex items-center gap-1.5 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          The Portal
        </Link>

        <header className="mt-6">
          <div className="flex items-center gap-2 text-[#7dffd4]">
            <Sparkles className="h-4 w-4" />
            <p className="font-heading text-[10px] font-bold uppercase tracking-[0.3em]">
              Submit a game
            </p>
          </div>
          <h1 className="mt-3 font-heading text-4xl font-black leading-[1.05] tracking-tight text-foreground sm:text-5xl">
            Paste a link.
            <br />
            That is the form.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            A link to your deployed game, or a link to an open-source repository.
            We work out the rest — the name, the description, who made it, and
            whether a browser can actually run it.
          </p>
        </header>

        {/* ---- the field ---------------------------------------------- */}
        <form onSubmit={onSubmit} className="mt-8">
          <label className="block font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Link to your game
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/you/your-game  ·  https://your-game.lovable.app"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-xl border border-border/60 bg-[#070c16] px-4 py-3 text-[13.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-[#7dffd4]/60"
            />
            <button
              type="submit"
              disabled={busy || !url.trim() || signedIn === false}
              className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#7dffd4] px-5 py-3 font-heading text-[11px] font-bold uppercase tracking-wider text-[#04121c] transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Looking…" : "Submit"}
            </button>
          </div>

          <label className="mt-4 block font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Your name on the card{" "}
            <span className="font-body font-normal normal-case tracking-normal text-muted-foreground/60">
              — optional, defaults to the repo owner
            </span>
          </label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Leo"
            maxLength={80}
            className="mt-2 w-full rounded-xl border border-border/60 bg-[#070c16] px-4 py-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-[#7dffd4]/60 sm:max-w-xs"
          />

          {signedIn === false && (
            <p className="mt-4 rounded-xl border border-border/40 bg-white/[0.02] p-4 text-[13px] leading-relaxed text-muted-foreground">
              You need a Vibe account to submit — a game goes on the shelf with
              somebody's name on it.{" "}
              <Link to="/welcome" className="text-[#7dffd4] hover:underline">
                Sign in
              </Link>{" "}
              and come back; the link will still be in your clipboard.
            </p>
          )}
        </form>

        {result && <ResultCard result={result} />}

        {/* ---- what happens next --------------------------------------- */}
        <section className="mt-12 grid gap-3 sm:grid-cols-2">
          <Card icon={<Github className="h-3.5 w-3.5" />} title="A repository">
            We read it, find the page a browser can open, and copy the static
            files at one exact commit onto our storage. Your repo is never
            changed and never depended on again — if you delete it tomorrow, the
            game keeps working. A new commit goes live when somebody presses
            resync, not on its own.
          </Card>
          <Card icon={<Globe className="h-3.5 w-3.5" />} title="A deployed link">
            Nothing is copied at all. We frame your site where it stands, so your
            deploys are live the moment you ship them. This is the right door if
            your game needs a build step — which most React, Vite and Lovable
            projects do.
          </Card>
        </section>

        <p className="mt-6 text-[12.5px] leading-relaxed text-muted-foreground">
          Either way your game runs sandboxed on its own origin, is never told
          who the player is, and can pay out {VIBECOIN_NAME} only from an
          allowance we hold —{" "}
          <Link to="/build" className="text-[#7dffd4] hover:underline">
            the deal is spelled out here
          </Link>
          , along with the four lines that let it pay anybody at all.
        </p>

        {/* ---- your submissions ---------------------------------------- */}
        {signedIn && mine && mine.length > 0 && (
          <section className="mt-12">
            <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              What you have sent
            </h2>
            <div className="mt-3 space-y-2">
              {mine.map((s) => (
                <SubmissionRow key={s.id} s={s} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-white/[0.02] p-4">
      <h3 className="flex items-center gap-1.5 font-heading text-[11px] font-bold uppercase tracking-[0.15em] text-[#7dffd4]">
        {icon}
        {title}
      </h3>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * What happened, immediately.
 *
 * The important element is the "play it now" link. A submission that sits in a
 * queue feels like shouting into a void; a submission you can click and play
 * thirty seconds later is obviously real, and it also means the submitter — not
 * a reviewer — is the first person to find out that the fonts did not copy.
 */
function ResultCard({ result }: { result: SubmitResult }) {
  const s = result.submission;
  const bad = result.failed || s.status === "failed";

  return (
    <div
      className={`mt-6 rounded-xl border p-4 ${
        bad ? "border-[#ffb86b]/40 bg-[#ffb86b]/[0.06]" : "border-[#7dffd4]/40 bg-[#7dffd4]/[0.06]"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {bad ? (
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#ffb86b]" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#7dffd4]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[13px] font-bold text-foreground">
            {bad
              ? "That one will not run as-is"
              : result.alreadyKnown
                ? "Already on the desk"
                : `${s.title ?? "Your game"} is in the queue`}
          </div>

          {s.status_note && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {s.status_note}
            </p>
          )}
          {result.note && result.note !== s.status_note && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {result.note}
            </p>
          )}

          {!bad && (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-4">
                {s.repo && <Fact label="Repo" value={s.repo} />}
                {s.repo_sha && <Fact label="Commit" value={s.repo_sha.slice(0, 7)} />}
                {s.file_count != null && <Fact label="Files" value={String(s.file_count)} />}
                {s.license && <Fact label="Licence" value={s.license} />}
              </dl>

              {result.preview && (
                <a
                  href={result.preview}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#7dffd4]/50 px-3 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-[#7dffd4] transition-colors hover:bg-[#7dffd4]/10"
                >
                  Play it now
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground/70">
                It is not on the arcade shelf yet — somebody has to look at it
                first. That link works in the meantime, and it is the same copy a
                reviewer sees.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-heading text-[9px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </dt>
      <dd className="truncate font-mono text-[11px] text-foreground/85">{value}</dd>
    </div>
  );
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  pending: { label: "Waiting", className: "text-[#8fb4ff] border-[#8fb4ff]/40" },
  approved: { label: "In the arcade", className: "text-[#7dffd4] border-[#7dffd4]/40" },
  rejected: { label: "Turned down", className: "text-muted-foreground border-border/60" },
  failed: { label: "Would not run", className: "text-[#ffb86b] border-[#ffb86b]/40" },
};

function SubmissionRow({ s }: { s: PortalSubmission }) {
  const style = STATUS_STYLE[s.status] ?? STATUS_STYLE.pending;
  return (
    <div className="rounded-xl border border-border/40 bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-heading text-[13px] font-bold text-foreground">
            {s.title ?? s.repo ?? s.submitted_url}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {s.repo ?? s.submitted_url}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 font-heading text-[9px] font-bold uppercase tracking-wider ${style.className}`}
        >
          {style.label}
        </span>
      </div>

      {s.status_note && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground/80">
          {s.status_note}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {s.status === "approved" && s.slug && (
          <Link
            to={`/play/${s.slug}`}
            className="font-heading text-[10px] font-bold uppercase tracking-wider text-[#7dffd4] hover:underline"
          >
            Play it →
          </Link>
        )}
        {s.status !== "approved" && s.embed_url && (
          <a
            href={s.embed_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Preview <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
        {!s.uses_sdk && s.status !== "failed" && (
          <span className="text-[10.5px] text-muted-foreground/60">
            No SDK yet — playable, but cannot pay.
          </span>
        )}
      </div>
    </div>
  );
}
