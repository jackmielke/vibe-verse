/**
 * vibeyVoice — talk to Vibey out loud.
 *
 * Real-time voice conversation through ElevenLabs Conversational AI:
 * the `elevenlabs-session` edge function mints a signed WebSocket URL
 * for Vibey's agent (key stays server-side), and the @elevenlabs/client
 * SDK handles the microphone, streaming, and playback.
 *
 * Vibey's agent id lives in the `agents` table; we look it up at call
 * time and fall back to the known production id if the row isn't
 * readable from the client.
 */
import { Conversation } from "@elevenlabs/client";
import { supabase } from "@/integrations/supabase/client";

// Vibey's production agent (agents table, name = "Vibey").
const FALLBACK_AGENT_ID = "agent_8801kq9f9072fgytesm2dvz4m70j";

export interface VibeyVoiceSession {
  end(): Promise<void>;
}

export async function startVibeyVoice(handlers: {
  onMode(mode: "speaking" | "listening"): void;
  onMessage(source: "user" | "ai", text: string): void;
  onEnd(): void;
  onError(message: string): void;
}): Promise<VibeyVoiceSession> {
  // Ask for the mic up front so permission errors surface clearly
  // before we burn a session.
  await navigator.mediaDevices.getUserMedia({ audio: true });

  let agentId = FALLBACK_AGENT_ID;
  try {
    const { data } = await supabase
      .from("agents")
      .select("elevenlabs_agent_id")
      .eq("name", "Vibey")
      .not("elevenlabs_agent_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.elevenlabs_agent_id) agentId = data.elevenlabs_agent_id;
  } catch {
    // Table not readable from the client — the fallback id is fine.
  }

  const { data, error } = await supabase.functions.invoke("elevenlabs-session", {
    body: { agentId },
  });
  const signedUrl = (data as { signed_url?: string } | null)?.signed_url;
  if (error || !signedUrl) {
    throw new Error("Couldn't open a voice line to Vibey.");
  }

  const conversation = await Conversation.startSession({
    signedUrl,
    onModeChange: ({ mode }) => handlers.onMode(mode),
    onMessage: ({ message, source }) =>
      handlers.onMessage(source === "user" ? "user" : "ai", message),
    onDisconnect: () => handlers.onEnd(),
    onError: (message) => handlers.onError(String(message)),
  });

  return {
    end: () => conversation.endSession(),
  };
}
