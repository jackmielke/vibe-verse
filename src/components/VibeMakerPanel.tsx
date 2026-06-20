/**
 * VibeMakerPanel — the dialog that opens when a player walks up to the
 * Vibe Maker portal on Cardboard Island. Pick a shape, a color, type
 * an optional vibe, and spawn it. Spawns save to public.island_spawns
 * and appear for every player on the island via realtime.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  SPAWN_KINDS,
  SPAWN_PALETTE,
  parsePrompt,
  pickSpawnOffset,
  type IslandSpawnRow,
  type SpawnKind,
} from "@/components/city/islandSpawns";

interface Props {
  open: boolean;
  onClose: () => void;
  /** All spawns currently on the island, freshest first. */
  spawns: IslandSpawnRow[];
  /** The signed-in user's id, or null when unauthenticated. */
  authUserId: string | null;
}

export default function VibeMakerPanel({ open, onClose, spawns, authUserId }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"shape" | "meshy">("shape");
  const [kind, setKind] = useState<SpawnKind>("cube");
  const [color, setColor] = useState<string>("#2dd4a8");
  const [prompt, setPrompt] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Meshy tab state
  const [meshyPrompt, setMeshyPrompt] = useState<string>("");
  const [meshyImage, setMeshyImage] = useState<string | null>(null); // data URL
  const [meshyBusy, setMeshyBusy] = useState(false);
  const [meshyStatus, setMeshyStatus] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);

  // Reset prompt when reopening so people don't accidentally re-spawn.
  useEffect(() => {
    if (open) {
      setPrompt("");
      setMeshyPrompt("");
      setMeshyImage(null);
      setMeshyStatus("");
    }
  }, [open]);

  if (!open) return null;

  const myCount = authUserId ? spawns.filter((s) => s.user_id === authUserId).length : 0;
  const mine = authUserId ? spawns.filter((s) => s.user_id === authUserId) : [];

  async function handleSpawn() {
    if (!authUserId) {
      toast({
        title: "Sign in to spawn",
        description: "Connect with Vibe to leave creations on the island.",
      });
      return;
    }
    setBusy(true);
    try {
      const parsed = parsePrompt(prompt, kind, color);
      const offset = pickSpawnOffset();
      const { error } = await supabase.from("island_spawns").insert({
        user_id: authUserId,
        kind: parsed.kind,
        color: parsed.color,
        label: parsed.label,
        ...offset,
        scale: 1,
      });
      if (error) throw error;
      toast({ title: "Spawned ✨", description: parsed.label ?? `${parsed.kind} dropped` });
      setPrompt("");
    } catch (e) {
      toast({
        title: "Couldn't spawn",
        description: e instanceof Error ? e.message : "unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleMeshyGenerate() {
    if (!authUserId) {
      toast({ title: "Sign in to generate", description: "Connect with Vibe first." });
      return;
    }
    if (!meshyPrompt.trim() && !meshyImage) {
      toast({ title: "Add a prompt or image", description: "Describe what to build, or upload a reference photo." });
      return;
    }
    setMeshyBusy(true);
    setMeshyStatus("Sending to Meshy…");
    try {
      // Phase 1: start the task (fast — returns a task_id).
      const startRes = await supabase.functions.invoke("meshy-generate", {
        body: {
          action: "start",
          prompt: meshyPrompt.trim() || undefined,
          image_url: meshyImage || undefined,
        },
      });
      if (startRes.error) throw startRes.error;
      const taskId: string | undefined = startRes.data?.task_id;
      const mode: string | undefined = startRes.data?.mode;
      if (!taskId || !mode) throw new Error("Meshy did not return a task id");

      // Phase 2: poll status every 4s up to ~5 min — dodges the 150s edge timeout.
      const deadline = Date.now() + 5 * 60 * 1000;
      let data: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const poll = await supabase.functions.invoke("meshy-generate", {
          body: { action: "status", task_id: taskId, mode },
        });
        if (poll.error) throw poll.error;
        const s = poll.data?.status;
        if (s === "SUCCEEDED") { data = poll.data; break; }
        if (s === "FAILED" || s === "CANCELED") {
          throw new Error(poll.data?.error ?? `Meshy ${s}`);
        }
        const pct = typeof poll.data?.progress === "number" ? ` ${poll.data.progress}%` : "";
        setMeshyStatus(`Meshy is sculpting…${pct}`);
      }
      if (!data?.model_url) throw new Error("Meshy timed out — try again");
      setMeshyStatus("Spawning into the world…");


      const offset = pickSpawnOffset();
      const label = meshyPrompt.trim() ? meshyPrompt.trim().slice(0, 80) : "Meshy creation";
      const { error: insErr } = await supabase.from("island_spawns").insert({
        user_id: authUserId,
        kind: "meshy",
        color: "#2dd4a8",
        label,
        model_url: data.model_url,
        thumbnail_url: data.thumbnail_url ?? null,
        ...offset,
        scale: 1.4,
      });
      if (insErr) throw insErr;

      toast({ title: "Generated ✨", description: label });
      setMeshyPrompt("");
      setMeshyImage(null);
      setMeshyStatus("");
    } catch (e) {
      toast({
        title: "Meshy failed",
        description: e instanceof Error ? e.message : "unknown error",
        variant: "destructive",
      });
      setMeshyStatus("");
    } finally {
      setMeshyBusy(false);
    }
  }

  async function handleImagePick(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Not an image", description: "Drop a PNG, JPG, or WebP.", variant: "destructive" });
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Keep it under 4MB.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setMeshyImage(typeof reader.result === "string" ? reader.result : null);
      setTab("meshy"); // auto-switch so the user sees the dropped image
    };
    reader.readAsDataURL(file);
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from("island_spawns").delete().eq("id", id);
    if (error) {
      toast({ title: "Couldn't delete", description: error.message, variant: "destructive" });
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-3 sm:p-6 bg-background/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`glass-panel rounded-2xl w-full max-w-md p-4 space-y-3 max-h-[90dvh] overflow-y-auto transition-all relative ${
          dragOver ? "ring-2 ring-primary shadow-[0_0_32px_hsl(var(--primary)/0.6)]" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={(e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleImagePick(f);
        }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 backdrop-blur-sm">
            <div className="font-heading font-bold text-primary text-sm tracking-wider">
              📥 DROP IMAGE TO GENERATE 3D
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div>
            <div className="font-heading font-bold text-base tracking-wide text-primary">
              ✨ VIBE MAKER
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Spawn 3D · everyone sees it
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none px-2"
            aria-label="Close vibe maker"
          >
            ✕
          </button>
        </div>

        {/* Tab switcher: classic primitives vs Meshy AI generation. */}
        <div className="flex gap-1 rounded-xl bg-muted/30 p-1">
          <button
            onClick={() => setTab("shape")}
            className={`flex-1 rounded-lg px-3 py-1.5 text-[11px] font-heading font-semibold tracking-wider transition-all ${
              tab === "shape" ? "bg-primary/25 text-primary" : "text-foreground/60 hover:text-foreground"
            }`}
          >
            🟦 SHAPES
          </button>
          <button
            onClick={() => setTab("meshy")}
            className={`flex-1 rounded-lg px-3 py-1.5 text-[11px] font-heading font-semibold tracking-wider transition-all ${
              tab === "meshy" ? "bg-primary/25 text-primary" : "text-foreground/60 hover:text-foreground"
            }`}
          >
            🪄 AI 3D
          </button>
        </div>

        {tab === "shape" && (
          <>
            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                SHAPE
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {SPAWN_KINDS.map((k) => {
                  const eq = kind === k.id;
                  return (
                    <button
                      key={k.id}
                      onClick={() => setKind(k.id)}
                      className={`rounded-lg p-2 flex flex-col items-center gap-0.5 transition-all ${
                        eq
                          ? "bg-primary/25 ring-1 ring-primary text-primary"
                          : "bg-muted/30 hover:bg-muted/60 text-foreground/80"
                      }`}
                    >
                      <span className="text-xl leading-none">{k.emoji}</span>
                      <span className="text-[9px] text-center leading-tight">{k.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                COLOR
              </div>
              <div className="flex items-center gap-2">
                <div className="grid grid-cols-8 gap-1.5 flex-1">
                  {SPAWN_PALETTE.map((c) => {
                    const eq = color.toLowerCase() === c.toLowerCase();
                    return (
                      <button
                        key={c}
                        onClick={() => setColor(c)}
                        className={`aspect-square rounded-md transition-all ${
                          eq ? "ring-2 ring-primary scale-110" : "ring-1 ring-foreground/10"
                        }`}
                        style={{ background: c, boxShadow: `0 0 12px ${c}55` }}
                        aria-label={`color ${c}`}
                      />
                    );
                  })}
                </div>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  aria-label="custom color"
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                VIBE PROMPT (optional)
              </div>
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSpawn();
                  }
                }}
                placeholder="e.g. glowing purple donut for my friend"
                className="w-full rounded-lg bg-muted/40 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                maxLength={80}
              />
              <div className="text-[9px] text-muted-foreground mt-1">
                Mention a shape or color word and we'll honor it (overrides picks above).
              </div>
            </div>

            <button
              onClick={handleSpawn}
              disabled={busy}
              className="w-full rounded-xl bg-primary text-primary-foreground font-heading font-bold tracking-wider py-2.5 text-sm shadow-[0_0_24px_hsl(var(--primary)/0.45)] disabled:opacity-50"
            >
              {busy ? "Spawning…" : "✨ Spawn it"}
            </button>
          </>
        )}

        {tab === "meshy" && (
          <div className="space-y-3">
            <div className="text-[10px] text-muted-foreground leading-relaxed">
              Type what you want, or upload a reference photo. Meshy AI builds a
              real 3D model and drops it into the world for everyone.
              <span className="text-amber-300/80"> Soon: costs Vibecoin.</span>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                DESCRIBE IT
              </div>
              <textarea
                value={meshyPrompt}
                onChange={(e) => setMeshyPrompt(e.target.value)}
                placeholder="a cozy mushroom house with glowing windows"
                rows={2}
                maxLength={240}
                className="w-full rounded-lg bg-muted/40 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                OR UPLOAD AN IMAGE
              </div>
              {meshyImage ? (
                <div className="flex items-center gap-2 rounded-lg bg-muted/30 p-2">
                  <img src={meshyImage} alt="reference" className="w-14 h-14 rounded object-cover" />
                  <div className="text-[11px] text-foreground/70 flex-1">Image ready ✓</div>
                  <button
                    onClick={() => setMeshyImage(null)}
                    className="text-xs text-muted-foreground hover:text-destructive px-2"
                  >
                    remove
                  </button>
                </div>
              ) : (
                <label className="block rounded-lg bg-muted/30 hover:bg-muted/50 cursor-pointer text-center py-3 text-[11px] text-foreground/70 transition-all">
                  📷 Tap to upload (PNG/JPG, ≤4MB)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImagePick(f);
                    }}
                  />
                </label>
              )}
            </div>

            <button
              onClick={handleMeshyGenerate}
              disabled={meshyBusy || (!meshyPrompt.trim() && !meshyImage)}
              className="w-full rounded-xl bg-primary text-primary-foreground font-heading font-bold tracking-wider py-2.5 text-sm shadow-[0_0_24px_hsl(var(--primary)/0.45)] disabled:opacity-50"
            >
              {meshyBusy ? "Generating… (30–90s)" : "🪄 Generate 3D"}
            </button>
            {meshyStatus && (
              <div className="text-[10px] text-primary/80 text-center animate-pulse">
                {meshyStatus}
              </div>
            )}
          </div>
        )}

        {!authUserId && (
          <div className="text-[10px] text-amber-300/90 text-center">
            Sign in with Vibe (top-right) to leave your mark on the island.
          </div>
        )}

        {mine.length > 0 && (
          <div className="pt-1">
            <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
              YOUR SPAWNS · {myCount}
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {mine.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg bg-muted/30 px-2 py-1.5"
                >
                  <span
                    className="w-3 h-3 rounded-sm shrink-0"
                    style={{ background: s.color, boxShadow: `0 0 8px ${s.color}` }}
                  />
                  <span className="text-[11px] text-foreground/80 truncate flex-1">
                    {s.label ?? s.kind}
                  </span>
                  <span className="text-[9px] text-muted-foreground capitalize">{s.kind}</span>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="text-muted-foreground hover:text-destructive text-xs px-1"
                    aria-label="delete spawn"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground text-center pt-1">
          {spawns.length} thing{spawns.length === 1 ? "" : "s"} on the island right now.
        </div>
      </div>
    </div>
  );
}
