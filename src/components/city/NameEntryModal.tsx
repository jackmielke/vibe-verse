/**
 * NameEntryModal — first-time "What should people call you?" prompt.
 * Shows once per browser when no display name has been set. Writes
 * localStorage `city.displayName` + `city.playerName`, and if the user
 * is signed in, updates `users.name` for the auth_user_id.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  open: boolean;
  initialName: string;
  authUserId: string | null;
  onSubmit: (name: string) => void;
  onSkip: () => void;
  avatarLabel?: string; // e.g. current character name for preview
}

export default function NameEntryModal({
  open,
  initialName,
  authUserId,
  onSubmit,
  onSkip,
  avatarLabel,
}: Props) {
  const [value, setValue] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValue(initialName);
  }, [open, initialName]);

  if (!open) return null;

  async function commit(name: string) {
    const cleaned = name.trim().slice(0, 32);
    if (!cleaned) return;
    setSaving(true);
    try {
      localStorage.setItem("city.displayName", cleaned);
      localStorage.setItem("city.playerName", cleaned);
      if (authUserId) {
        // best-effort; don't block on it
        await supabase
          .from("users")
          .update({ name: cleaned })
          .eq("auth_user_id", authUserId);
      }
      onSubmit(cleaned);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-background/85 backdrop-blur-md">
      <div className="glass-panel rounded-3xl w-full max-w-sm p-6 space-y-5 shadow-[0_0_64px_hsl(var(--primary)/0.35)]">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-20 h-20 rounded-full bg-primary/15 ring-2 ring-primary/40 flex items-center justify-center text-4xl shadow-[0_0_24px_hsl(var(--primary)/0.5)]">
            🪩
          </div>
          {avatarLabel && (
            <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              as {avatarLabel.replace(/_/g, " ")}
            </div>
          )}
        </div>

        <div className="text-center space-y-1">
          <div className="font-heading font-bold text-lg tracking-wide text-primary">
            What should people call you?
          </div>
          <div className="text-xs text-muted-foreground">
            This shows up in chat, on the roster, and over your head.
          </div>
        </div>

        <input
          autoFocus
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(value);
            }
          }}
          maxLength={32}
          placeholder="Your name"
          className="w-full rounded-xl bg-muted/40 px-4 py-3 text-base text-center focus:outline-none focus:ring-2 focus:ring-primary"
        />

        <button
          onClick={() => void commit(value)}
          disabled={saving || !value.trim()}
          className="w-full rounded-xl bg-primary text-primary-foreground font-heading font-bold tracking-wider py-3 text-sm shadow-[0_0_24px_hsl(var(--primary)/0.55)] disabled:opacity-50"
        >
          {saving ? "Saving…" : "✨ Enter Vibe City"}
        </button>

        <button
          onClick={() => {
            localStorage.setItem("city.displayName", initialName);
            onSkip();
          }}
          className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          skip — keep <span className="text-foreground/80">{initialName}</span>
        </button>
      </div>
    </div>
  );
}
