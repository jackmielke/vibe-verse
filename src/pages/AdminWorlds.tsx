/**
 * AdminWorlds — admin moderation queue for community world submissions.
 *
 * Only users with the 'admin' role can view/use this page. Non-admins
 * see an empty state. RLS enforces the actual access; the UI just
 * mirrors that.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ExternalLink, Loader2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface WorldRow {
  id: string;
  name: string;
  blurb: string | null;
  route: string;
  github_url: string | null;
  preview_url: string | null;
  tags: string[];
  status: "pending" | "approved" | "rejected";
  is_featured: boolean;
  sort_order: number;
  created_at: string;
  creator_id: string | null;
}

export default function AdminWorlds() {
  const [rows, setRows] = useState<WorldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">(
    "pending",
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from("worlds")
      .select(
        "id,name,blurb,route,github_url,preview_url,tags,status,is_featured,sort_order,created_at,creator_id",
      )
      .order("created_at", { ascending: false });
    if (filter !== "all") q = q.eq("status", filter);
    const { data, error } = await q;
    if (error) {
      toast.error("Failed to load worlds", { description: error.message });
      setRows([]);
    } else {
      setRows((data ?? []) as WorldRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const setStatus = async (id: string, status: WorldRow["status"]) => {
    setBusyId(id);
    const { error } = await supabase.from("worlds").update({ status }).eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error("Update failed", { description: error.message });
      return;
    }
    toast.success(`Marked ${status}`);
    load();
  };

  const toggleFeatured = async (row: WorldRow) => {
    setBusyId(row.id);
    const { error } = await supabase
      .from("worlds")
      .update({ is_featured: !row.is_featured })
      .eq("id", row.id);
    setBusyId(null);
    if (error) {
      toast.error("Update failed", { description: error.message });
      return;
    }
    load();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-4 pt-20 pb-24 sm:pt-24">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Back to hub
        </Link>

        <h1 className="font-heading text-3xl sm:text-4xl font-bold tracking-tight">
          World submissions
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          Approve community-submitted worlds to feature them in the hub. Only
          admins can view this page (enforced by RLS).
        </p>

        <div className="flex gap-2 mt-6">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "bg-background/40 border border-border/60 hover:bg-primary/10"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="glass-panel rounded-xl p-6 text-sm text-muted-foreground text-center">
              Nothing to show. Either there are no {filter} submissions, or
              you're not an admin.
            </div>
          )}

          {rows.map((row) => (
            <div
              key={row.id}
              className="glass-panel rounded-xl p-4 flex flex-col sm:flex-row gap-4"
            >
              <div className="w-full sm:w-32 aspect-square rounded-lg bg-background/40 border border-border/60 overflow-hidden flex-shrink-0">
                {row.preview_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.preview_url}
                    alt={row.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">
                    no preview
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-heading font-bold text-lg truncate">
                    {row.name}
                  </h3>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider ${
                      row.status === "approved"
                        ? "bg-primary/20 text-primary"
                        : row.status === "rejected"
                          ? "bg-destructive/20 text-destructive"
                          : "bg-muted-foreground/15 text-muted-foreground"
                    }`}
                  >
                    {row.status}
                  </span>
                  {row.is_featured && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wider">
                      featured
                    </span>
                  )}
                </div>
                {row.blurb && (
                  <p className="text-sm text-muted-foreground mt-1">{row.blurb}</p>
                )}
                <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                  <div>
                    Route: <span className="font-mono">{row.route}</span>
                  </div>
                  {row.github_url && (
                    <a
                      href={row.github_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {row.github_url} <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {row.tags.length > 0 && (
                    <div>Tags: {row.tags.join(", ")}</div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 mt-3">
                  {row.status !== "approved" && (
                    <button
                      onClick={() => setStatus(row.id, "approved")}
                      disabled={busyId === row.id}
                      className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="w-3 h-3" /> Approve
                    </button>
                  )}
                  {row.status !== "rejected" && (
                    <button
                      onClick={() => setStatus(row.id, "rejected")}
                      disabled={busyId === row.id}
                      className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      <X className="w-3 h-3" /> Reject
                    </button>
                  )}
                  {row.status === "approved" && (
                    <button
                      onClick={() => toggleFeatured(row)}
                      disabled={busyId === row.id}
                      className="text-xs px-3 py-1.5 rounded-full bg-background/40 border border-border/60 hover:bg-primary/10 disabled:opacity-50"
                    >
                      {row.is_featured ? "Unfeature" : "Feature"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
