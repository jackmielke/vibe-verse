/**
 * vibe-magician-voice — the door between the browser and OpenAI's voice APIs.
 *
 * The Magician (`/magician`) is a world you talk to. The talking happens over
 * WebRTC straight from the browser to OpenAI; nothing spoken passes through
 * here. What this function holds is the one thing the browser must never see,
 * the API key, and it spends it in two ways depending on `action`:
 *
 *  - `realtime`  Mint a short-lived client secret (`ek_…`) for the Realtime API
 *                with the session — model, voice, instructions, tools — baked
 *                in. The browser then posts its SDP offer to
 *                `/v1/realtime/calls` with that secret and is on the wire.
 *                (Model: `gpt-realtime-2.1`, falling back down the family if
 *                the account has not been given the newest one yet.)
 *
 *  - `live`      The Live API (`gpt-live-1`, September 2026) has no ephemeral
 *                keys: the SDP exchange itself is the authenticated call. So
 *                the browser sends its offer here, this function posts it to
 *                `/v1/live/sessions` with the key, and returns the answer.
 *                Tools go through the session's Responses delegation.
 *
 *  - `status`    Whether an OPENAI_API_KEY is configured at all, so the page
 *                can say "Vibe has no voice yet" instead of failing on the
 *                first tap of the microphone.
 *
 * The instructions and the tool list come from the client. That is on
 * purpose: they are the game's script, they live next to the world code that
 * executes them, and there is no secret in them. The budget is the thing that
 * is enforced here — a session secret lives ten minutes and a Live session
 * is whatever OpenAI's own cap is — not the prompt.
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

const REALTIME_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2", "gpt-realtime-1.5", "gpt-realtime"];
const LIVE_MODEL = "gpt-live-1";
/** The model that does the thinking behind a Live session's tool calls. */
const LIVE_BACKEND_MODELS = ["gpt-5.4-mini", "gpt-5.2", "gpt-5-mini"];

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function looksLikeMissingModel(status: number, text: string): boolean {
  if (status !== 400 && status !== 404 && status !== 403) return false;
  return /model|does not exist|not found|not available|access|permission/i.test(text);
}

interface RealtimeBody {
  action: "realtime";
  instructions?: string;
  tools?: unknown[];
  voice?: string;
  model?: string;
}

interface LiveBody {
  action: "live";
  sdp: string;
  instructions?: string;
  backendInstructions?: string;
  tools?: unknown[];
  voice?: string;
  model?: string;
  backendModel?: string;
}

async function mintRealtime(apiKey: string, body: RealtimeBody): Promise<Response> {
  const candidates = body.model ? [body.model, ...REALTIME_MODELS] : REALTIME_MODELS;
  let lastText = "";
  let lastStatus = 500;
  for (const model of candidates) {
    const session = {
      type: "realtime",
      model,
      instructions: body.instructions ?? "",
      tools: Array.isArray(body.tools) ? body.tools : [],
      tool_choice: "auto",
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: body.voice ?? "marin" },
      },
    };
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
    });
    const text = await resp.text();
    if (resp.ok) {
      const data = JSON.parse(text);
      return reply(200, { engine: "realtime", model, value: data.value, expires_at: data.expires_at });
    }
    lastText = text;
    lastStatus = resp.status;
    if (!looksLikeMissingModel(resp.status, text)) break;
  }
  return reply(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, {
    error: `OpenAI refused to open a realtime session: ${lastStatus} ${lastText.slice(0, 600)}`,
  });
}

async function openLive(apiKey: string, body: LiveBody): Promise<Response> {
  if (typeof body.sdp !== "string" || !body.sdp.includes("v=0")) {
    return reply(400, { error: "A WebRTC SDP offer is required for a live session" });
  }
  const backendCandidates = body.backendModel ? [body.backendModel, ...LIVE_BACKEND_MODELS] : LIVE_BACKEND_MODELS;
  let lastText = "";
  let lastStatus = 500;
  for (const backendModel of backendCandidates) {
    const session = {
      model: body.model ?? LIVE_MODEL,
      instructions: body.instructions ?? "",
      audio: { output: { voice: body.voice ?? "marin" } },
      delegation: {
        type: "responses",
        responses: {
          model: backendModel,
          instructions: body.backendInstructions ?? body.instructions ?? "",
          tools: Array.isArray(body.tools) ? body.tools : [],
          tool_choice: "auto",
          parallel_tool_calls: true,
          reasoning: { effort: "low" },
        },
      },
      // The browser is the only client. It needs to hear tool calls and answer
      // them, so the data channel is left with the default allow-all.
    };
    const resp = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp: body.sdp } }),
    });
    const text = await resp.text();
    if (resp.ok) {
      const data = JSON.parse(text);
      return reply(200, {
        engine: "live",
        model: session.model,
        backendModel,
        sessionId: data.session?.id ?? null,
        sdp: data.transport?.sdp ?? null,
      });
    }
    lastText = text;
    lastStatus = resp.status;
    // Only the backend model is worth retrying; a missing Live model is final.
    if (!looksLikeMissingModel(resp.status, text) || /gpt-live/i.test(text)) break;
  }
  return reply(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, {
    error: `OpenAI refused to open a live session: ${lastStatus} ${lastText.slice(0, 600)}`,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Body must be JSON" });
  }
  const action = typeof body.action === "string" ? body.action : "status";

  if (action === "status") {
    return reply(200, { configured: Boolean(apiKey), engines: apiKey ? ["realtime", "live"] : [] });
  }
  if (!apiKey) {
    return reply(500, {
      error: "OpenAI is not connected to this project (OPENAI_API_KEY is not set)",
      code: "no_key",
    });
  }
  try {
    if (action === "realtime") return await mintRealtime(apiKey, body as unknown as RealtimeBody);
    if (action === "live") return await openLive(apiKey, body as unknown as LiveBody);
    return reply(400, { error: `Unknown action ${action}` });
  } catch (err) {
    return reply(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
