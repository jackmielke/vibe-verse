import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation, type Conversation as ElevenLabsConversation } from "@elevenlabs/client";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Subtle in-chat voice toggle for an AI agent. Uses the server-configured
 * ELEVENLABS_AGENT_ID by default; falls back to a per-agent override later
 * if we add one to world_agents.
 */
export function AgentVoiceButton({ agentName }: { agentName: string }) {
  const [status, setStatus] = useState<"idle" | "connecting" | "live">("idle");
  const [speaking, setSpeaking] = useState(false);
  const ref = useRef<ElevenLabsConversation | null>(null);

  const stop = useCallback(async () => {
    try { await ref.current?.endSession(); } catch { /* ignore */ }
    ref.current = null;
    setStatus("idle");
    setSpeaking(false);
  }, []);

  useEffect(() => () => { void stop(); }, [stop]);

  const start = useCallback(async () => {
    setStatus("connecting");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { data, error } = await supabase.functions.invoke(
        "elevenlabs-conversation-token",
        { body: {} },
      );
      if (error) throw error;
      if (!data?.token) throw new Error("no token");
      const conv = await Conversation.startSession({
        conversationToken: data.token,
        connectionType: "webrtc",
        onConnect: () => setStatus("live"),
        onDisconnect: () => { ref.current = null; setStatus("idle"); setSpeaking(false); },
        onError: (m) => toast.error(m || "voice error"),
        onModeChange: ({ mode }) => setSpeaking(mode === "speaking"),
      });
      ref.current = conv;
    } catch (e: any) {
      console.warn("[voice] start failed", e);
      toast.error(e?.message ?? "voice unavailable");
      setStatus("idle");
    }
  }, []);

  const live = status === "live";
  const connecting = status === "connecting";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => (live ? void stop() : void start())}
      disabled={connecting}
      title={live ? `End voice call with ${agentName}` : `Voice call ${agentName}`}
      className={`h-7 px-2 gap-1 text-xs ${
        live ? "text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {connecting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : live ? (
        <MicOff className="h-3.5 w-3.5" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
      <span>{live ? (speaking ? "speaking…" : "listening…") : "voice"}</span>
    </Button>
  );
}
