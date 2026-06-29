/**
 * PersonChatPanel — in-world 1:1 chat with another player or with one of
 * the AI agent residents. Messages persist to `public.island_dms` and
 * stream back through Supabase realtime. When the target is an agent,
 * the `agent-reply` edge function generates an in-character reply.
 *
 * Renders as a compact corner widget by default so the player can keep
 * watching the agent move in the 3D world, with an expand toggle that
 * opens a full chat view (including the agent economy strip).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, User, Maximize2, Minimize2, X } from "lucide-react";
import { AgentVoiceButton } from "@/components/city/AgentVoiceButton";
import AgentEconomyStrip from "@/components/city/AgentEconomyStrip";

export interface PersonTarget {
  kind: "player" | "agent";
  /** auth user_id for players, world_agents.id for agents */
  ref: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  target: PersonTarget | null;
  authUserId: string | null;
  myName: string;
}

interface DmRow {
  id: string;
  thread_key: string;
  from_kind: "user" | "agent";
  from_ref: string;
  from_name: string;
  to_kind: "user" | "agent";
  to_ref: string;
  body: string;
  created_at: string;
}

function threadKeyFor(meRef: string, target: PersonTarget): string {
  const me = `user:${meRef}`;
  const them = `${target.kind}:${target.ref}`;
  return [me, them].sort().join("|");
}

// Stable per-browser guest id so visitors can chat without signing in.
function getGuestId(): string {
  if (typeof window === "undefined") return "guest";
  const KEY = "city.guestId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `guest-${Math.random().toString(36).slice(2)}-${Date.now()}`);
    localStorage.setItem(KEY, id);
  }
  return id;
}

export default function PersonChatPanel({ open, onClose, target, authUserId, myName }: Props) {
  const [messages, setMessages] = useState<DmRow[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Default to the compact widget so the player can still see the agent
  // walk around. Toggle to expanded for the full chat + economy strip.
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const meRef = useMemo(() => authUserId ?? getGuestId(), [authUserId]);

  const threadKey = useMemo(
    () => (target ? threadKeyFor(meRef, target) : null),
    [meRef, target],
  );

  // Reset to mini mode whenever the panel opens for a new target.
  useEffect(() => {
    if (open) setExpanded(false);
  }, [open, target?.ref]);

  // Load history + realtime
  useEffect(() => {
    if (!open || !threadKey) return;
    let cancelled = false;
    void supabase
      .from("island_dms")
      .select("*")
      .eq("thread_key", threadKey)
      .order("created_at", { ascending: true })
      .limit(200)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setMessages(data as DmRow[]);
      });
    const channel = supabase
      .channel(`island_dms_${threadKey}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "island_dms", filter: `thread_key=eq.${threadKey}` },
        (payload) => {
          const row = payload.new as DmRow;
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [open, threadKey]);

  // Autoscroll on new messages
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, expanded]);

  // Focus input on open / mode change
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open, expanded]);

  // Esc closes (only when expanded, so mini mode doesn't fight game input)
  useEffect(() => {
    if (!open || !expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, expanded]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !target || !threadKey || sending) return;
    setSending(true);
    const insertRow = {
      thread_key: threadKey,
      from_kind: "user" as const,
      from_ref: meRef,
      from_name: myName || "pilot",
      to_kind: target.kind,
      to_ref: target.ref,
      body: text.slice(0, 1000),
    };
    setDraft("");
    const { error } = await supabase.from("island_dms").insert(insertRow);
    if (error) {
      toast.error(error.message);
      setSending(false);
      return;
    }
    if (target.kind === "agent") {
      try {
        await supabase.functions.invoke("agent-reply", {
          body: {
            agentId: target.ref,
            threadKey,
            userId: meRef,
            body: insertRow.body,
          },
        });
      } catch (e) {
        console.warn("[agent-reply] failed", e);
      }
    }
    setSending(false);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  if (!open || !target) return null;
  const isAgent = target.kind === "agent";

  // Show the last few messages in mini mode so the widget stays compact.
  const recent = messages.slice(-3);

  // ---- MINI WIDGET (default) ----------------------------------------
  // Floating bottom-right card. No backdrop, no economy strip — the
  // 3D world stays fully visible so you can watch the agent move.
  if (!expanded) {
    return (
      <div
        className="fixed z-50 bottom-3 right-3 w-[min(360px,calc(100vw-1.5rem))] rounded-xl border border-border/70 bg-background/95 backdrop-blur shadow-2xl pointer-events-auto flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-background/70">
          {isAgent ? (
            <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-primary shrink-0" />
          )}
          <span className="text-sm font-medium truncate">{target.name}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {isAgent ? "agent" : "player"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {isAgent && <AgentVoiceButton agentName={target.name} />}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Expand"
              aria-label="Expand chat"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Close"
              aria-label="Close chat"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {recent.length > 0 && (
          <div
            ref={scrollRef}
            className="max-h-32 overflow-y-auto px-3 py-2 space-y-1.5 text-xs"
          >
            {recent.map((m) => {
              const mine = m.from_kind === "user" && m.from_ref === meRef;
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-2 py-1 leading-snug break-words ${
                      mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {m.body}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <form
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          className="flex gap-1.5 px-2 py-2 border-t border-border/60 bg-background"
        >
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={isAgent ? `Ask ${target.name} to move…` : `Message ${target.name}…`}
            maxLength={1000}
            disabled={sending}
            className="flex-1 h-8 text-sm"
          />
          <Button type="submit" size="sm" className="h-8 px-3" disabled={!draft.trim() || sending}>
            Send
          </Button>
        </form>
      </div>
    );
  }

  // ---- EXPANDED VIEW ------------------------------------------------
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => setExpanded(false)}
    >
      <div
        className="w-full max-w-md max-h-[90vh] rounded-xl border border-border/70 bg-background shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          {isAgent ? (
            <Sparkles className="h-4 w-4 text-primary" />
          ) : (
            <User className="h-4 w-4 text-primary" />
          )}
          <span className="text-base font-medium truncate">{target.name}</span>
          <span className="text-xs text-muted-foreground">
            {isAgent ? "AI agent" : "player"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {isAgent && <AgentVoiceButton agentName={target.name} />}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Minimize"
              aria-label="Minimize chat"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Close"
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {isAgent && (
          <AgentEconomyStrip
            agentId={target.ref}
            ownerKind="user"
            ownerRef={meRef}
          />
        )}

        <div ref={scrollRef} className="flex-1 max-h-[55vh] min-h-[260px] overflow-y-auto px-4 py-3 space-y-2 bg-background/40">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              {isAgent
                ? `Say hi to ${target.name} — they're an AI agent living here.`
                : `No messages yet. Say something to ${target.name}!`}
            </p>
          )}
          {messages.map((m) => {
            const mine = m.from_kind === "user" && m.from_ref === meRef;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-snug break-words ${
                    mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                  }`}
                >
                  {!mine && (
                    <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">
                      {m.from_name}
                    </div>
                  )}
                  {m.body}
                </div>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          className="border-t border-border/60 px-3 py-2 flex gap-2 bg-background"
        >
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${target.name}…`}
            maxLength={1000}
            disabled={sending}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={!draft.trim() || sending}>
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}
