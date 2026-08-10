/**
 * `/admin/games` — the queue, and the one decision that is still a person's.
 *
 * Everything mechanical about a submission has already happened by the time a
 * row appears here: the repo was read, the files were copied, the entry page
 * was checked, and there is a URL that plays. What is left is the judgement no
 * budget can make — *is this a game, and do we want it on the shelf* — which is
 * why this page leads with a play link and not with a form.
 *
 * The four numbers are the second decision, and they are pre-filled precisely
 * so that most of the time nobody touches them. Approving is meant to be a
 * glance and a click. If it is not, the defaults are wrong and should be
 * changed in the function, not agonised over here every time.
 *
 * Access is enforced by `vibe-portal-submit`, which checks `has_role` on the
 * caller before it answers `queue`, `review` or `resync`. This page showing an
 * empty state to a non-admin is a courtesy, not the lock.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Github,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  portalQueue,
  resyncPortalGame,
  reviewPortalSubmission,
  type PortalGameAdminRow,
  type PortalSubmission,
  type SubmissionStatus,
} from "@/portal/api";

type Filter = SubmissionStatus | "all";
const FILTERS: Filter[] = ["pending", "approved", "failed", "rejected", "all"];

export default function AdminGames() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [rows, setRows] = useState<PortalSubmission[]>([]);
  const [games, setGames] = useState<PortalGameAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await portalQueue(filter);
      setRows(r.submissions);
      setGames(r.games);
      setDenied(false);
    } catch (e) {
      // "That is an admin action" is the expected answer for most visitors and
      // is not worth a red toast.
      setRows([]);
      setGames([]);
      setDenied(/admin/i.test((e as Error).message));
      if (!/admin/i.test((e as Error).message)) {
        toast.error("Could not load the queue", { description: (e as Error).message });
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (
    s: PortalSubmission,
    action: "approve" | "reject",
    budgets?: Record<string, number>,
  ) => {
    setBusyId(s.id);
    try {
      const r = await reviewPortalSubmission(s.id, action, budgets ?? {});
      toast.success(
        action === "approve" ? `${s.title ?? s.slug} is live at ${r.route}` : "Turned down",
      );
      await load();
    } catch (e) {
      toast.error("That did not work", { description: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const resync = async (slug: string) => {
    setBusyId(slug);
    try {
      const r = await resyncPortalGame(slug);
      toast.success(
        r.changed
          ? `${slug} moved to ${r.sha.slice(0, 7)} (${r.uploaded} files)`
          : r.note ?? "Already current",
      );
      await load();
    } catch (e) {
      toast.error("Resync failed", { description: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-24 pt-20">
      <div className="mx-auto w-full max-w-4xl px-5">
        <Link
          to="/arcade"
          className="inline-flex items-center gap-1.5 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Arcade
        </Link>

        <header className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-3xl font-black tracking-tight text-foreground">
              The submission desk
            </h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Play it, then decide what it is worth a day.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Reload
          </button>
        </header>

        <div className="mt-6 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1.5 font-heading text-[10px] font-bold uppercase tracking-wider transition-colors ${
                filter === f
                  ? "border-[#7dffd4]/60 bg-[#7dffd4]/10 text-[#7dffd4]"
                  : "border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {denied ? (
          <p className="mt-10 rounded-xl border border-border/40 bg-white/[0.02] p-5 text-[13px] text-muted-foreground">
            This desk is for admins. If you have sent a game in, it is on{" "}
            <Link to="/submit-game" className="text-[#7dffd4] hover:underline">
              your submissions page
            </Link>
            .
          </p>
        ) : loading ? (
          <p className="mt-10 text-[13px] text-muted-foreground/60">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="mt-10 text-[13px] text-muted-foreground/60">
            Nothing {filter === "all" ? "at all" : filter} right now.
          </p>
        ) : (
          <div className="mt-6 space-y-3">
            {rows.map((s) => (
              <SubmissionCard
                key={s.id}
                s={s}
                busy={busyId === s.id}
                onDecide={(action, budgets) => void decide(s, action, budgets)}
              />
            ))}
          </div>
        )}

        {!denied && games.length > 0 && (
          <section className="mt-14">
            <h2 className="font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              On the shelf
            </h2>
            <div className="mt-3 space-y-2">
              {games.map((g) => (
                <div
                  key={g.slug}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border/40 bg-white/[0.02] px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/play/${g.slug}`}
                        className="truncate font-heading text-[13px] font-bold text-foreground hover:text-[#7dffd4]"
                      >
                        {g.title}
                      </Link>
                      {!g.active && (
                        <span className="rounded border border-border/60 px-1.5 py-0.5 font-heading text-[8.5px] uppercase tracking-wider text-muted-foreground">
                          off
                        </span>
                      )}
                      {!g.uses_sdk && (
                        <span className="rounded border border-border/60 px-1.5 py-0.5 font-heading text-[8.5px] uppercase tracking-wider text-muted-foreground/70">
                          no sdk
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {g.repo ? `${g.repo}@${(g.repo_sha ?? "").slice(0, 7)}` : g.source_kind}
                      {" · "}
                      {g.max_award}/award · {g.daily_budget}/day
                    </div>
                  </div>
                  {g.source_kind === "github" && (
                    <button
                      onClick={() => void resync(g.slug)}
                      disabled={busyId === g.slug}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                    >
                      {busyId === g.slug ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Resync
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SubmissionCard({
  s,
  busy,
  onDecide,
}: {
  s: PortalSubmission;
  busy: boolean;
  onDecide: (action: "approve" | "reject", budgets?: Record<string, number>) => void;
}) {
  const [maxAward, setMaxAward] = useState(String(s.max_award ?? 10));
  const [sessionBudget, setSessionBudget] = useState(String(s.session_budget ?? 50));
  const [playerDaily, setPlayerDaily] = useState(String(s.player_daily ?? 100));
  const [dailyBudget, setDailyBudget] = useState(String(s.daily_budget ?? 800));

  const reviewable = s.status === "pending" && !!s.embed_url;

  return (
    <div className="rounded-xl border border-border/40 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {s.kind === "github" ? (
              <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <h3 className="truncate font-heading text-[15px] font-bold text-foreground">
              {s.title ?? s.repo ?? s.submitted_url}
            </h3>
            <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-heading text-[8.5px] uppercase tracking-wider text-muted-foreground">
              {s.status}
            </span>
          </div>
          {s.tagline && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.tagline}</p>
          )}
          <p className="mt-1 truncate text-[11px] text-muted-foreground/70">
            {s.author ? `${s.author} · ` : ""}
            <a
              href={s.submitted_url}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground"
            >
              {s.submitted_url}
            </a>
          </p>
        </div>

        {s.embed_url && (
          <a
            href={s.embed_url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#7dffd4]/50 px-3 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-[#7dffd4] transition-colors hover:bg-[#7dffd4]/10"
          >
            Play it
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {s.status_note && (
        <p className="mt-3 rounded-lg border border-border/30 bg-black/20 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {s.status_note}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-5">
        {s.repo_sha && <Fact label="Commit" value={s.repo_sha.slice(0, 7)} />}
        {s.repo_ref && <Fact label="Branch" value={s.repo_ref} />}
        {s.file_count != null && <Fact label="Files" value={String(s.file_count)} />}
        {s.total_bytes != null && (
          <Fact label="Size" value={`${Math.round(Number(s.total_bytes) / 1024)} KB`} />
        )}
        <Fact label="SDK" value={s.uses_sdk ? "yes" : "no"} />
      </dl>

      {reviewable && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Budget label="Per award" value={maxAward} onChange={setMaxAward} />
            <Budget label="Per visit" value={sessionBudget} onChange={setSessionBudget} />
            <Budget label="Player/day" value={playerDaily} onChange={setPlayerDaily} />
            <Budget label="Total/day" value={dailyBudget} onChange={setDailyBudget} />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() =>
                onDecide("approve", {
                  maxAward: Number(maxAward),
                  sessionBudget: Number(sessionBudget),
                  playerDaily: Number(playerDaily),
                  dailyBudget: Number(dailyBudget),
                })
              }
              className="flex items-center gap-1.5 rounded-lg bg-[#7dffd4] px-4 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-[#04121c] disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => onDecide("reject")}
              className="flex items-center gap-1.5 rounded-lg border border-border/60 px-4 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <X className="h-3 w-3" />
              Reject
            </button>
            {!s.uses_sdk && (
              <span className="text-[10.5px] text-muted-foreground/60">
                No SDK — the budgets will not be spent until it has one.
              </span>
            )}
          </div>
        </>
      )}
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

function Budget({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-heading text-[9px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border/60 bg-[#070c16] px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-[#7dffd4]/60"
      />
    </label>
  );
}
