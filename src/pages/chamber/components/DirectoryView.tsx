import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { businesses, categories } from "../data/businesses";
import type { Business } from "../data/types";
import { janeScore } from "../data/types";
import { MemberDetail } from "./MemberDetail";
import { JaneMeter, Rise, SectionHeading, StatusPill } from "./shared";

type MemberFilter = "all" | "members" | "non-members";

const chip = (active: boolean) =>
  cn(
    "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors border",
    active
      ? "bg-primary text-primary-foreground border-primary shadow-sm"
      : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
  );

export const DirectoryView = () => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All categories");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [localOnly, setLocalOnly] = useState(false);
  const [selected, setSelected] = useState<Business | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return businesses.filter((b) => {
      if (q && !b.name.toLowerCase().includes(q) && !b.category.toLowerCase().includes(q)) return false;
      if (category !== "All categories" && b.category !== category) return false;
      if (memberFilter === "members" && !b.isMember) return false;
      if (memberFilter === "non-members" && b.isMember) return false;
      if (localOnly && !b.locallyOwned) return false;
      return true;
    });
  }, [query, category, memberFilter, localOnly]);

  return (
    <div>
      <SectionHeading
        title="Member Directory"
        subtitle="Every licensed business in town — members and the ones we haven't met yet — with a Jane Score for local authenticity."
      />

      {/* Filters — one row above the list */}
      <Rise className="flex flex-wrap items-center gap-2.5 mb-5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search businesses…"
            className="h-9 w-56 rounded-full border border-border bg-card pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 rounded-full border border-border bg-card px-3.5 text-xs font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option>All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        {(["all", "members", "non-members"] as const).map((f) => (
          <button key={f} className={chip(memberFilter === f)} onClick={() => setMemberFilter(f)}>
            {f === "all" ? "Everyone" : f === "members" ? "Members" : "Non-members"}
          </button>
        ))}
        <button className={chip(localOnly)} onClick={() => setLocalOnly((v) => !v)}>
          Locally owned
        </button>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">{filtered.length} businesses</span>
      </Rise>

      {/* Table */}
      <Rise delay={0.08}>
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-muted-foreground border-b border-border">
                <th className="px-5 py-3 font-semibold">Business</th>
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold">Membership</th>
                <th className="px-4 py-3 font-semibold">Dues</th>
                <th className="px-4 py-3 font-semibold">Jane Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setSelected(b)}
                  className="cursor-pointer transition-colors hover:bg-secondary/50"
                >
                  <td className="px-5 py-3">
                    <span className="font-medium text-foreground">{b.name}</span>
                    {b.locallyOwned && (
                      <span className="ml-2 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-semibold align-middle">
                        Local
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{b.category}</td>
                  <td className="px-4 py-3">
                    {b.isMember
                      ? <span className="text-foreground/90">Since {b.memberSince}</span>
                      : <span className="text-accent font-medium">Non-member</span>}
                  </td>
                  <td className="px-4 py-3">{b.duesStatus ? <StatusPill kind={b.duesStatus} /> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3"><JaneMeter score={janeScore(b.jane)} /></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                    No businesses match — try loosening a filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Rise>

      <MemberDetail business={selected} onClose={() => setSelected(null)} />
    </div>
  );
};
