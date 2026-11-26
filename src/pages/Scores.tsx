/**
 * /scores: every world, scored on lore, fun and smooth, with hours played.
 *
 * Rows come from the registry (so a world nobody has played yet still shows,
 * at zero) joined to `world_stats`. Everything on this page is a total; there
 * is nothing per player to show, because nothing per player is kept.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { PLAYABLE } from "@/worlds/registry";
import { RatingRows } from "@/components/RatePrompt";
import {
  avg,
  fetchStats,
  formatHours,
  hasPlayed,
  hasRated,
  overall,
  sendRating,
  type Rating,
  type WorldStatsRow,
} from "@/lib/worldStats";

/**
 * Pinned to the top of the board whatever the sort, in this order. Jack's
 * call (Nov 2026): these are the two flagship worlds right now. Edit here.
 */
export const FEATURED_KEYS = ["cannon-run", "island"];

type SortKey = "overall" | "lore" | "fun" | "smooth" | "fps" | "hours" | "players" | "sessions" | "name";

const EMPTY = (key: string): WorldStatsRow => ({
  world_key: key,
  play_seconds: 0,
  players: 0,
  sessions: 0,
  fps_sum: 0,
  fps_n: 0,
  lore_sum: 0,
  lore_n: 0,
  fun_sum: 0,
  fun_n: 0,
  smooth_sum: 0,
  smooth_n: 0,
});

function Score({ v, n }: { v: number | null; n?: number }) {
  if (v === null) return <span className="text-white/25">–</span>;
  const tone = v >= 4 ? "text-emerald-300" : v >= 3 ? "text-amber-200" : "text-rose-300";
  return (
    <span className={tone} title={n !== undefined ? `${n} vote${n === 1 ? "" : "s"}` : undefined}>
      {v.toFixed(1)}
    </span>
  );
}

export default function Scores() {
  const [rows, setRows] = useState<WorldStatsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "hours", dir: -1 });
  const [rating, setRating] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rating>({});
  const [, bump] = useState(0);

  const load = () =>
    fetchStats()
      .then((r) => setRows(r))
      .catch((e) => {
        setError(String(e?.message ?? e));
        setRows([]);
      });

  useEffect(() => {
    document.title = "Scores · Vibe Verse";
    load();
  }, []);

  const table = useMemo(() => {
    const byKey = new Map((rows ?? []).map((r) => [r.world_key, r]));
    const list = PLAYABLE.map((w) => {
      const s = byKey.get(w.key) ?? EMPTY(w.key);
      return {
        w,
        s,
        overall: overall(s),
        lore: avg(s.lore_sum, s.lore_n),
        fun: avg(s.fun_sum, s.fun_n),
        smooth: avg(s.smooth_sum, s.smooth_n),
        fps: avg(s.fps_sum, s.fps_n),
        hours: s.play_seconds,
        players: s.players,
        sessions: s.sessions,
      };
    });
    const k = sort.key;
    const pin = (key: string) => {
      const i = FEATURED_KEYS.indexOf(key);
      return i === -1 ? FEATURED_KEYS.length : i;
    };
    return list.sort((a, b) => {
      const pa = pin(a.w.key);
      const pb = pin(b.w.key);
      if (pa !== pb) return pa - pb;
      if (k === "name") return a.w.name.localeCompare(b.w.name) * sort.dir;
      const av = a[k] ?? -1;
      const bv = b[k] ?? -1;
      return (av - bv) * sort.dir || b.hours - a.hours;
    });
  }, [rows, sort]);

  const totals = useMemo(() => {
    const r = rows ?? [];
    return {
      seconds: r.reduce((a, x) => a + x.play_seconds, 0),
      sessions: r.reduce((a, x) => a + x.sessions, 0),
      votes: r.reduce((a, x) => a + Math.max(x.lore_n, x.fun_n, x.smooth_n), 0),
    };
  }, [rows]);

  const head = (key: SortKey, label: string, cls = "") => (
    <th
      className={`cursor-pointer select-none whitespace-nowrap px-2 py-2 font-medium text-white/60 hover:text-white ${cls}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" ? 1 : -1 }))}
    >
      {label}
      {sort.key === key ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="min-h-screen bg-[#05060f] px-4 pb-16 pt-20 text-white">
      <div className="mx-auto max-w-5xl">
        <Link to="/" className="mb-6 inline-flex items-center gap-1 text-sm text-white/60 hover:text-white">
          <ArrowLeft size={14} /> All worlds
        </Link>
        <h1 className="text-3xl font-bold">Scores</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/60">
          Every world, scored by the people who played it on three things: does it have lore, is it fun, and does it
          run smooth. FPS is what players' browsers actually measured. Everything here is a total. Nobody's playtime
          is stored against them: each browser adds its minutes to the world's count and forgets them.
        </p>

        <div className="mt-6 grid grid-cols-3 gap-3 sm:max-w-lg">
          {[
            ["Played", formatHours(totals.seconds)],
            ["Visits", totals.sessions.toLocaleString()],
            ["Ratings", totals.votes.toLocaleString()],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <div className="text-xs text-white/50">{k}</div>
              <div className="text-lg font-semibold">{v}</div>
            </div>
          ))}
        </div>

        {error && <div className="mt-4 text-sm text-rose-300">Couldn't load the totals ({error}).</div>}

        {rows === null ? (
          <div className="mt-10 flex justify-center text-white/50">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-white/5 text-left">
                <tr>
                  {head("name", "World", "pl-3")}
                  {head("overall", "Overall")}
                  {head("lore", "Lore")}
                  {head("fun", "Fun")}
                  {head("smooth", "Smooth")}
                  {head("fps", "FPS")}
                  {head("hours", "Played")}
                  {head("players", "Players")}
                  {head("sessions", "Visits")}
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody>
                {table.map((r) => {
                  const canRate = hasPlayed(r.w.key) && !hasRated(r.w.key);
                  return (
                    <Fragment key={r.w.key}>
                      <tr
                        className={`border-t border-white/5 hover:bg-white/[0.03] ${
                          FEATURED_KEYS.includes(r.w.key) ? "bg-amber-300/[0.06]" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-3 py-2">
                          <Link to={r.w.route} className="hover:underline">
                            <span className="mr-1.5">{r.w.emoji}</span>
                            {r.w.name}
                          </Link>
                          {FEATURED_KEYS.includes(r.w.key) && (
                            <span className="ml-2 rounded-full border border-amber-300/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-amber-200">
                              Featured
                            </span>
                          )}
                        </td>
                        <td className="px-2 font-semibold">
                          <Score v={r.overall} />
                        </td>
                        <td className="px-2">
                          <Score v={r.lore} n={r.s.lore_n} />
                        </td>
                        <td className="px-2">
                          <Score v={r.fun} n={r.s.fun_n} />
                        </td>
                        <td className="px-2">
                          <Score v={r.smooth} n={r.s.smooth_n} />
                        </td>
                        <td className="px-2 tabular-nums text-white/70">{r.fps === null ? "–" : Math.round(r.fps)}</td>
                        <td className="px-2 tabular-nums">{formatHours(r.hours)}</td>
                        <td className="px-2 tabular-nums text-white/70">{r.players.toLocaleString()}</td>
                        <td className="px-2 tabular-nums text-white/70">{r.sessions.toLocaleString()}</td>
                        <td className="px-2 text-right">
                          {canRate && rating !== r.w.key && (
                            <button
                              onClick={() => {
                                setRating(r.w.key);
                                setDraft({});
                              }}
                              className="rounded-full border border-amber-300/50 px-2.5 py-0.5 text-xs text-amber-200 hover:bg-amber-300/10"
                            >
                              Rate
                            </button>
                          )}
                        </td>
                      </tr>
                      {rating === r.w.key && (
                        <tr className="bg-white/[0.03]">
                          <td colSpan={10} className="px-3 py-3">
                            <div className="flex flex-wrap items-end gap-6">
                              <div className="w-72">
                                <RatingRows value={draft} onChange={setDraft} />
                              </div>
                              <div className="flex gap-3">
                                <button onClick={() => setRating(null)} className="text-xs text-white/50 hover:text-white">
                                  Cancel
                                </button>
                                <button
                                  disabled={!(draft.lore || draft.fun || draft.smooth)}
                                  onClick={async () => {
                                    await sendRating(r.w.key, draft);
                                    setRating(null);
                                    bump((n) => n + 1);
                                    load();
                                  }}
                                  className="rounded-full bg-amber-300 px-4 py-1 text-sm font-semibold text-black disabled:opacity-30"
                                >
                                  Send
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-white/40">
          Players counts each device once per world. A Rate button appears next to any world you have played on this
          device and not scored yet.
        </p>
      </div>
    </div>
  );
}
