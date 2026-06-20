import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Echo — experimental voice-to-voice NPC powered by ElevenLabs Conversational AI.
 *
 * Floating HUD button → dialog with agent ID input (cached in localStorage),
 * mic permission + WebRTC voice session, live status, and recent transcripts.
 *
 * You must create the agent in the ElevenLabs dashboard first
 * (https://elevenlabs.io/app/conversational-ai) and paste its Agent ID here.
 * Any client tools and overrides must also be enabled there.
 */

type Msg = { who: "you" | "echo"; text: string };

const AGENT_ID_KEY = "city.elevenlabs.agentId";

export function EchoVoiceAgent() {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string>(
    () => localStorage.getItem(AGENT_ID_KEY) ?? "",
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useConversation({
    onConnect: () => setError(null),
    onDisconnect: () => setConnecting(false),
    onError: (e) => setError(typeof e === "string" ? e : (e as Error)?.message ?? "voice error"),
    onMessage: (msg: any) => {
      // The SDK emits varied shapes depending on event; normalize what we can.
      if (!msg || typeof msg !== "object") return;
      const source = msg.source ?? msg.type;
      const text =
        msg.message ??
        msg.text ??
        msg.user_transcription_event?.user_transcript ??
        msg.agent_response_event?.agent_response;
      if (typeof text === "string" && text.trim()) {
        const who: "you" | "echo" =
          source === "user" || msg.type === "user_transcript" ? "you" : "echo";
        setMessages((m) => [...m, { who, text }].slice(-20));
      }
      if (msg.type === "client_tool_call" || msg.client_tool_call) {
        const name = msg.client_tool_call?.tool_name ?? msg.tool_name ?? "tool";
        setToolCalls((t) => [...t, name].slice(-10));
      }
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const start = useCallback(async () => {
    setError(null);
    const id = agentId.trim();
    if (!id) {
      setError("Paste an ElevenLabs Agent ID first.");
      return;
    }
    setConnecting(true);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { data, error: fnErr } = await supabase.functions.invoke(
        "elevenlabs-conversation-token",
        { body: { agentId: id } },
      );
      if (fnErr) throw fnErr;
      if (!data?.token) throw new Error("No token returned");
      localStorage.setItem(AGENT_ID_KEY, id);
      await conversation.startSession({
        conversationToken: data.token,
        connectionType: "webrtc",
      });
    } catch (e: any) {
      setError(e?.message ?? "failed to start");
      setConnecting(false);
    }
  }, [agentId, conversation]);

  const stop = useCallback(async () => {
    try {
      await conversation.endSession();
    } catch {
      // ignore
    }
  }, [conversation]);

  const status = conversation.status; // 'connected' | 'disconnected' | ...
  const isLive = status === "connected";
  const speaking = conversation.isSpeaking;

  return (
    <>
      {/* Floating launcher button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="absolute top-4 right-4 z-30 glass-panel rounded-full px-3 py-2 text-[11px] font-heading tracking-wider text-primary hover:bg-primary/15 transition-colors flex items-center gap-1.5"
        title="Voice Lab — talk to an ElevenLabs voice agent"
      >
        <span className={isLive ? "animate-pulse" : ""}>🎙️</span>
        <span>VOICE LAB{isLive ? " · LIVE" : ""}</span>
      </button>

      {open && (
        <div className="absolute top-16 right-4 z-30 glass-panel rounded-2xl p-3 w-[min(92vw,22rem)] flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-heading font-semibold tracking-wider text-primary">
              ECHO · voice agent (experimental)
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground px-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            ElevenLabs Agent ID
          </label>
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="agent_xxxxxxxxxxxxxxxxxxxx"
            disabled={isLive}
            className="bg-muted/40 border border-border/40 rounded-lg px-2 py-1.5 outline-none focus:border-primary/60 disabled:opacity-60"
          />
          <div className="text-[10px] text-muted-foreground">
            Create an agent at{" "}
            <a
              href="https://elevenlabs.io/app/conversational-ai"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              elevenlabs.io
            </a>
            , then paste its ID.
          </div>

          <div className="flex items-center gap-2">
            {!isLive ? (
              <button
                onClick={start}
                disabled={connecting || !agentId.trim()}
                className="rounded-full bg-primary/25 text-primary px-3 py-1.5 hover:bg-primary/35 transition-colors disabled:opacity-50"
              >
                {connecting ? "connecting…" : "📞 start voice call"}
              </button>
            ) : (
              <>
                <button
                  onClick={stop}
                  className="rounded-full bg-destructive/25 text-destructive px-3 py-1.5 hover:bg-destructive/35 transition-colors"
                >
                  ⏹ end call
                </button>
                <span className={speaking ? "text-primary animate-pulse" : "text-muted-foreground"}>
                  {speaking ? "🔊 Echo speaking…" : "🎙️ listening — just talk"}
                </span>
              </>
            )}
          </div>

          {error && (
            <div className="text-[11px] text-destructive bg-destructive/10 rounded-lg px-2 py-1.5">
              {error}
            </div>
          )}

          <div
            ref={scrollRef}
            className="max-h-[26dvh] overflow-y-auto space-y-1 bg-muted/20 rounded-lg p-2"
          >
            {messages.length === 0 ? (
              <div className="text-muted-foreground">
                Start the call and just talk. Transcripts will appear here.
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i}>
                  <span className={m.who === "echo" ? "text-primary" : "text-amber-300"}>
                    {m.who === "echo" ? "Echo" : "you"}
                  </span>{" "}
                  <span className="text-foreground/90">{m.text}</span>
                </div>
              ))
            )}
          </div>

          {toolCalls.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              tools called: {toolCalls.join(" · ")}
            </div>
          )}
        </div>
      )}
    </>
  );
}
