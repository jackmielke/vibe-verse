/**
 * PersonChatPanel — in-world 1:1 chat with another player or with one of
 * the AI agent residents. Messages persist to `public.island_dms` and
 * stream back through Supabase realtime. When the target is an agent,
 * the `agent-reply` edge function generates an in-character reply.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, User } from "lucide-react";
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
// Stored once in localStorage; matches the uuid shape from_ref expects.
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Use the signed-in user id when available, else a stable guest id so
  // anonymous visitors can still send/receive messages on the island.
  const meRef = useMemo(() => authUserId ?? getGuestId(), [authUserId]);

  const threadKey = useMemo(
    () => (target ? threadKeyFor(meRef, target) : null),
    [meRef, target],
  );

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
  }, [messages, open]);

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

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
    // For agents, kick off the AI reply.
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

  if (!target) return null;
  const isAgent = target.kind === "agent";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            {isAgent ? (
              <Sparkles className="h-4 w-4 text-primary" />
            ) : (
              <User className="h-4 w-4 text-primary" />
            )}
            <span className="truncate">{target.name}</span>
            <span className="text-xs text-muted-foreground font-normal">
              {isAgent ? "AI agent" : "player"}
            </span>
            {isAgent && (
              <span className="ml-auto">
                <AgentVoiceButton agentName={target.name} />
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div ref={scrollRef} className="max-h-[55vh] min-h-[260px] overflow-y-auto px-4 py-3 space-y-2 bg-background/40">
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
              <div
                key={m.id}
                className={`flex ${mine ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-snug break-words ${
                    mine
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
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
      </DialogContent>
    </Dialog>
  );
}
