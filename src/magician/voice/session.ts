/**
 * The voice session: a microphone, a speaker, and a channel for tool calls.
 *
 * Two engines behind one interface, both WebRTC straight to OpenAI:
 *
 *  - `realtime` — the Realtime API (`gpt-realtime-2.1`). The edge function
 *    mints a ten-minute client secret with the session baked in; the browser
 *    posts its SDP offer to `/v1/realtime/calls` with it. Function calls
 *    arrive as `response.function_call_arguments.done`; the answer goes back
 *    as a `function_call_output` item and a `response.create`.
 *
 *  - `live` — the Live API (`gpt-live-1`, September 2026). No client secret:
 *    the edge function relays the SDP offer to `/v1/live/sessions` with the
 *    key and returns the answer. The Live model talks; a Responses model
 *    behind it (`delegation: responses`) calls the tools, and those calls
 *    reach the browser wrapped in `response.event`. The reply is a
 *    `response.item.create` with a `function_call_output`.
 *
 * Everything the world needs is the same for both: text from the visitor,
 * text from Vibey, a tool call to run, and a "Vibey is speaking" level that
 * is measured off the incoming audio track rather than trusted from events,
 * so the character's mouth follows the actual sound.
 */
import { supabase } from "@/integrations/supabase/client";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../tools";
import { VIBEY_BACKEND_PROMPT, VIBEY_GREETING, VIBEY_REALTIME_PROMPT, VIBEY_VOICE_PROMPT } from "../prompt";

export type Engine = "realtime" | "live";
export type VoiceStatus = "idle" | "connecting" | "live" | "error" | "closed";

export interface VoiceHandlers {
  onStatus(status: VoiceStatus, detail?: string): void;
  /** Visitor speech, transcribed. `final` when the turn is complete. */
  onUserText(text: string, final: boolean): void;
  /** Vibey's words, accumulated per turn. */
  onAssistantText(text: string, final: boolean): void;
  /** Execute a tool and return what the model should read. */
  onToolCall(name: string, args: unknown): string | Promise<string>;
  /** 0–1, from the incoming audio. */
  onSpeaking(level: number): void;
  onListening(active: boolean): void;
}

export interface VoiceSession {
  engine: Engine;
  connect(): Promise<void>;
  disconnect(): void;
  /** Send a typed message as if spoken. */
  sendText(text: string): void;
  /**
   * Tell Vibey something the world did on its own (a fireball landed, the
   * rain put the fire out) so it can react. Not shown as the visitor's words.
   */
  notify(text: string): void;
  setMuted(m: boolean): void;
  status(): VoiceStatus;
}

export interface VoiceOptions {
  engine: Engine;
  voice?: string;
  tools?: ToolDefinition[];
  handlers: VoiceHandlers;
}

const FUNCTION_NAME = "vibe-magician-voice";

interface FnResponse {
  engine?: string;
  model?: string;
  value?: string;
  sdp?: string;
  sessionId?: string;
  error?: string;
  code?: string;
}

async function callFunction(body: Record<string, unknown>): Promise<FnResponse> {
  const { data, error } = await supabase.functions.invoke<FnResponse>(FUNCTION_NAME, { body });
  if (error) {
    // supabase-js hides the body of a non-2xx reply behind `context`.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const j = (await ctx.json()) as FnResponse;
        throw new Error(j.error ?? error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Empty reply from the voice function");
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Ask the function whether a key is configured at all. `null` means the
 * question could not be asked (offline, blocked), which is not the same as
 * "no": the page only warns on an explicit no.
 */
export async function voiceAvailable(): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.functions.invoke<{ configured?: boolean }>(FUNCTION_NAME, { body: { action: "status" } });
    if (error || !data || typeof data.configured !== "boolean") return null;
    return data.configured;
  } catch {
    return null;
  }
}

export function createVoiceSession(opts: VoiceOptions): VoiceSession {
  const { handlers } = opts;
  const tools = opts.tools ?? TOOL_DEFINITIONS;
  let status: VoiceStatus = "idle";
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let mic: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let raf = 0;
  let assistantBuffer = "";
  let userBuffer = "";
  let closed = false;

  const setStatus = (s: VoiceStatus, detail?: string) => { status = s; handlers.onStatus(s, detail); };

  function send(event: Record<string, unknown>) {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(event));
  }

  // ---- speaking level from the actual audio track ---------------------------
  function watchAudio(stream: MediaStream) {
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let smooth = 0;
      const tick = () => {
        if (!analyser || closed) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms * 6);
        smooth += (level - smooth) * 0.35;
        handlers.onSpeaking(smooth);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      /* no analyser, no mouth — the voice still plays */
    }
  }

  // ---- tool plumbing ---------------------------------------------------------
  async function handleToolCall(callId: string, name: string, argsJson: string, reply: (callId: string, output: string) => void) {
    let args: unknown = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }
    let output: string;
    try {
      output = await handlers.onToolCall(name, args);
    } catch (e) {
      output = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    reply(callId, output);
  }

  // ---- event handling: realtime ------------------------------------------------
  function onRealtimeEvent(ev: Record<string, unknown>) {
    const type = ev.type as string;
    switch (type) {
      case "input_audio_buffer.speech_started":
        handlers.onListening(true);
        break;
      case "input_audio_buffer.speech_stopped":
        handlers.onListening(false);
        break;
      case "conversation.item.input_audio_transcription.delta":
        userBuffer += String(ev.delta ?? "");
        handlers.onUserText(userBuffer, false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        userBuffer = String(ev.transcript ?? userBuffer);
        handlers.onUserText(userBuffer.trim(), true);
        userBuffer = "";
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        assistantBuffer += String(ev.delta ?? "");
        handlers.onAssistantText(assistantBuffer, false);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        assistantBuffer = String(ev.transcript ?? assistantBuffer);
        handlers.onAssistantText(assistantBuffer.trim(), true);
        assistantBuffer = "";
        break;
      case "response.function_call_arguments.done":
        void handleToolCall(String(ev.call_id), String(ev.name), String(ev.arguments ?? "{}"), (callId, output) => {
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
          send({ type: "response.create" });
        });
        break;
      case "error": {
        const err = ev.error as { message?: string } | undefined;
        console.warn("[magician/realtime]", err?.message ?? ev);
        break;
      }
    }
  }

  // ---- event handling: live ------------------------------------------------------
  const liveCalls = new Map<string, { name: string; args: string }>();
  function onLiveEvent(ev: Record<string, unknown>) {
    const type = ev.type as string;
    switch (type) {
      case "session.started":
        setStatus("live");
        break;
      case "session.input_transcript.delta":
        userBuffer += String(ev.delta ?? "");
        handlers.onUserText(userBuffer, false);
        handlers.onListening(true);
        break;
      case "session.output_transcript.delta":
        assistantBuffer += String(ev.delta ?? "");
        handlers.onAssistantText(assistantBuffer, false);
        if (userBuffer.trim()) { handlers.onUserText(userBuffer.trim(), true); userBuffer = ""; handlers.onListening(false); }
        break;
      case "session.delegation.created":
        // The thinking has started; flush what Vibey said so far as a turn.
        if (assistantBuffer.trim()) { handlers.onAssistantText(assistantBuffer.trim(), true); assistantBuffer = ""; }
        break;
      case "response.event": {
        const inner = ev.event as Record<string, unknown> | undefined;
        if (!inner) break;
        const it = inner.type as string;
        if (it === "response.output_item.added" || it === "response.output_item.done") {
          const item = inner.item as Record<string, unknown> | undefined;
          if (item && item.type === "function_call" && it === "response.output_item.done") {
            void handleToolCall(String(item.call_id), String(item.name), String(item.arguments ?? "{}"), (callId, output) => {
              send({ type: "response.item.create", item: { type: "function_call_output", call_id: callId, output } });
              send({ type: "response.create" });
            });
          }
        } else if (it === "response.function_call_arguments.done") {
          // Some streams only carry the arguments here; fall back if the item was never seen.
          const callId = String(inner.call_id ?? "");
          const known = liveCalls.get(callId);
          if (!known && inner.name) {
            void handleToolCall(callId, String(inner.name), String(inner.arguments ?? "{}"), (cid, output) => {
              send({ type: "response.item.create", item: { type: "function_call_output", call_id: cid, output } });
              send({ type: "response.create" });
            });
          }
        }
        break;
      }
      case "session.closed":
        if (!closed) setStatus("closed");
        break;
      case "error": {
        const err = ev.error as { message?: string } | undefined;
        console.warn("[magician/live]", err?.message ?? ev);
        break;
      }
    }
  }

  // ---- connection ---------------------------------------------------------------
  async function connect() {
    if (status === "connecting" || status === "live") return;
    closed = false;
    setStatus("connecting");
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setStatus("error", "Microphone permission is needed to talk to Vibey.");
      throw e;
    }
    try {
      pc = new RTCPeerConnection();
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "true");
      pc.ontrack = (e) => {
        if (!audioEl) return;
        audioEl.srcObject = e.streams[0];
        void audioEl.play().catch(() => undefined);
        watchAudio(e.streams[0]);
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);
      dc = pc.createDataChannel("oai-events");
      dc.onmessage = (m) => {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (opts.engine === "live") onLiveEvent(ev); else onRealtimeEvent(ev);
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          if (!closed) setStatus("error", "The voice connection dropped.");
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (opts.engine === "realtime") {
        const minted = await callFunction({ action: "realtime", instructions: VIBEY_REALTIME_PROMPT, tools, voice: opts.voice ?? "marin" });
        if (!minted.value) throw new Error("No client secret returned");
        const resp = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: { Authorization: `Bearer ${minted.value}`, "Content-Type": "application/sdp" },
          body: offer.sdp,
        });
        if (!resp.ok) throw new Error(`OpenAI refused the call: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
        const answer = await resp.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        dc.onopen = () => {
          setStatus("live", minted.model);
          // Say hello. The greeting is a one-off instruction on the first response.
          send({ type: "response.create", response: { instructions: VIBEY_GREETING } });
        };
      } else {
        const opened = await callFunction({
          action: "live",
          sdp: offer.sdp,
          instructions: VIBEY_VOICE_PROMPT,
          backendInstructions: VIBEY_BACKEND_PROMPT,
          tools,
          voice: opts.voice ?? "marin",
        });
        if (!opened.sdp) throw new Error("No SDP answer returned for the live session");
        await pc.setRemoteDescription({ type: "answer", sdp: opened.sdp });
        dc.onopen = () => {
          // session.started arrives on the channel and flips status to live.
          send({ type: "session.commentary.append", delegation_id: null, content: "A visitor has just arrived in the valley. Greet them warmly in one sentence, wave, and invite a wish." });
          setTimeout(() => { if (status === "connecting") setStatus("live", opened.model); }, 1500);
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      teardown();
      setStatus("error", msg);
      throw e;
    }
  }

  function teardown() {
    closed = true;
    cancelAnimationFrame(raf);
    analyser = null;
    if (audioCtx) { void audioCtx.close().catch(() => undefined); audioCtx = null; }
    if (dc) { try { dc.close(); } catch { /* fine */ } dc = null; }
    if (pc) { try { pc.close(); } catch { /* fine */ } pc = null; }
    if (mic) { for (const t of mic.getTracks()) t.stop(); mic = null; }
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); audioEl = null; }
    handlers.onSpeaking(0);
    handlers.onListening(false);
  }

  return {
    engine: opts.engine,
    connect,
    disconnect() {
      if (opts.engine === "live") send({ type: "session.close" });
      teardown();
      setStatus("closed");
    },
    sendText(text) {
      const t = text.trim();
      if (!t) return;
      handlers.onUserText(t, true);
      if (opts.engine === "realtime") {
        send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
        send({ type: "response.create" });
      } else {
        send({ type: "response.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
        send({ type: "response.create" });
      }
    },
    notify(text) {
      const t = text.trim();
      if (!t || status !== "live") return;
      if (opts.engine === "realtime") {
        send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `[world event] ${t}` }] } });
        send({ type: "response.create" });
      } else {
        send({ type: "session.commentary.append", delegation_id: null, content: t });
      }
    },
    setMuted(m) {
      if (mic) for (const t of mic.getAudioTracks()) t.enabled = !m;
    },
    status: () => status,
  };
}
