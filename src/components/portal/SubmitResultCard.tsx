/**
 * What we worked out from the link you pasted.
 *
 * This is the payoff of the one-field form: the name, who made it, the exact
 * commit, how many files came across, the licence — none of which anybody typed
 * in. It is shared between `/submit-game` and the dialog because it is the half
 * of the interaction that actually answers "did that work?", and a submitter
 * seeing a different answer depending on which surface they used would be worse
 * than either version.
 *
 * A failure is styled amber rather than red, and says what to do next. The
 * common one is a repo that needs a build step, and the submitter has not done
 * anything wrong — they have picked the wrong one of two correct doors.
 */
import { AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";

import type { SubmitResult } from "@/portal/api";

export default function SubmitResultCard({ result }: { result: SubmitResult }) {
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
        {/* The cover, once it is real. Same picture the shelf will show. */}
        {!bad && s.cover_url && (
          <img
            src={s.cover_url}
            alt=""
            className="h-14 w-20 shrink-0 rounded-lg border border-border/40 object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[13px] font-bold text-foreground">
            {bad
              ? "That one will not run as-is"
              : result.alreadyKnown
                ? "Already on the desk"
                : `${s.title ?? "Your game"} is in the queue`}
          </div>

          {/* The description, read off the repo or the page. Nobody typed it. */}
          {!bad && s.tagline && (
            <p className="mt-1 text-[12.5px] italic leading-relaxed text-foreground/70">
              {s.tagline}
            </p>
          )}

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
                {s.author && <Fact label="By" value={s.author} />}
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
