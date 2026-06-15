/**
 * SubmitWorld — community world submission form.
 *
 * Anyone signed in can submit. Submissions land as `status = 'pending'`
 * and surface on the hub once an admin approves them at /admin/worlds.
 *
 * Login is encouraged but not enforced at the page level — if the user
 * isn't signed in we show a hint pointing them to /welcome where the
 * Vibe account card lives. Auth is enforced server-side by RLS.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { ArrowLeft, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const schema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  blurb: z.string().trim().min(10, "Add a short description (10+ chars)").max(280),
  route: z
    .string()
    .trim()
    .min(1, "Where does this world live?")
    .max(500)
    .refine(
      (v) => v.startsWith("/") || v.startsWith("http://") || v.startsWith("https://"),
      "Must start with / (internal route) or http(s)://",
    ),
  github_url: z
    .string()
    .trim()
    .max(300)
    .optional()
    .refine(
      (v) => !v || /^https?:\/\//.test(v),
      "GitHub URL must start with http(s)://",
    ),
  preview_url: z
    .string()
    .trim()
    .max(500)
    .optional()
    .refine(
      (v) => !v || /^https?:\/\//.test(v),
      "Preview URL must start with http(s)://",
    ),
  tags: z.string().trim().max(120).optional(),
});

type FormState = z.input<typeof schema>;

const initial: FormState = {
  name: "",
  blurb: "",
  route: "",
  github_url: "",
  preview_url: "",
  tags: "",
};

export default function SubmitWorld() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(initial);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAuthUserId(data.user?.id ?? null);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthUserId(session?.user?.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const update = (k: keyof FormState, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v && v[0]) flat[k] = v[0];
      }
      setErrors(flat);
      return;
    }

    if (!authUserId) {
      toast.error("Please sign in first", {
        description: "World submissions are tied to your Vibe profile.",
      });
      return;
    }

    setSubmitting(true);
    try {
      // Look up the public.users.id for this auth user.
      const { data: userRow, error: userErr } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();

      if (userErr || !userRow) {
        toast.error("Could not find your Vibe profile", {
          description: "Try signing out and back in.",
        });
        setSubmitting(false);
        return;
      }

      const data = parsed.data;
      const slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) + "-" + Math.random().toString(36).slice(2, 6);

      const tagsArr = (data.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8);

      const { error } = await supabase.from("worlds").insert({
        slug,
        name: data.name,
        blurb: data.blurb,
        route: data.route,
        github_url: data.github_url || null,
        preview_url: data.preview_url || null,
        tags: tagsArr,
        status: "pending",
        creator_id: userRow.id,
      });

      if (error) {
        toast.error("Submission failed", { description: error.message });
        setSubmitting(false);
        return;
      }

      toast.success("World submitted!", {
        description: "An admin will review it and it'll appear in the hub once approved.",
      });
      setForm(initial);
      setTimeout(() => navigate("/"), 800);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-4 pt-20 pb-24 sm:pt-24">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Back to hub
        </Link>

        <div className="flex items-center gap-2 text-primary mb-2">
          <Sparkles className="w-5 h-5" />
          <p className="text-[10px] sm:text-xs tracking-[0.4em] uppercase">Submit a world</p>
        </div>
        <h1 className="font-heading text-3xl sm:text-4xl font-bold tracking-tight">
          Add your world to the VibeVerse
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          Build something cool? Paste a link and we'll feature it in the hub
          carousel once approved. Submissions are tied to your Vibe profile.
        </p>

        {!authLoading && !authUserId && (
          <div className="mt-6 glass-panel rounded-xl p-4 text-sm">
            You need a Vibe profile to submit. Head to the{" "}
            <Link to="/welcome" className="text-primary underline">
              welcome page
            </Link>{" "}
            to sign in, then come back.
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-8 space-y-5">
          <Field
            label="Name"
            value={form.name}
            error={errors.name}
            onChange={(v) => update("name", v)}
            placeholder="Crystal Cavern"
            maxLength={80}
          />

          <Field
            label="Short blurb"
            value={form.blurb}
            error={errors.blurb}
            onChange={(v) => update("blurb", v)}
            placeholder="A bioluminescent cave you can fly through"
            maxLength={280}
            multiline
          />

          <Field
            label="Route or external URL"
            hint='Internal route like "/my-world" or a full https:// URL'
            value={form.route}
            error={errors.route}
            onChange={(v) => update("route", v)}
            placeholder="/my-world or https://my-world.example.com"
          />

          <Field
            label="GitHub URL"
            hint="Optional — link the open-source repo"
            value={form.github_url ?? ""}
            error={errors.github_url}
            onChange={(v) => update("github_url", v)}
            placeholder="https://github.com/you/your-world"
          />

          <Field
            label="Preview image URL"
            hint="Optional — square-ish image used as the planet texture. Paste a public image link (Imgur, your CDN, etc.)."
            value={form.preview_url ?? ""}
            error={errors.preview_url}
            onChange={(v) => update("preview_url", v)}
            placeholder="https://i.imgur.com/yourimage.jpg"
          />

          <Field
            label="Tags"
            hint="Comma-separated, e.g. multiplayer, 3d, voxel"
            value={form.tags ?? ""}
            error={errors.tags}
            onChange={(v) => update("tags", v)}
            placeholder="multiplayer, 3d"
          />

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || authLoading || !authUserId}
              className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground font-heading font-bold text-sm px-6 py-3 shadow-[0_0_30px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_40px_hsl(var(--primary)/0.8)] hover:scale-[1.02] transition-all disabled:opacity-50 disabled:hover:scale-100"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? "Submitting…" : "Submit for review"}
            </button>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              Need a repo? <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  error,
  onChange,
  placeholder,
  maxLength,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={3}
          className="w-full rounded-xl bg-background/40 border border-border/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="w-full rounded-xl bg-background/40 border border-border/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        />
      )}
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </label>
  );
}
