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
 *                can say "Vibey has no voice yet" instead of failing on the
 *                first tap of the microphone. Also how many free seconds the
 *                caller has left.
 *
 *  - `heartbeat` The client's "still talking" tick, every thirty seconds.
 *  - `end`       The client hung up; settle the session in flight.
 *
 * The instructions and the tool list come from the client. That is on
 * purpose: they are the game's script, they live next to the world code that
 * executes them, and there is no secret in them.
 *
 * ## The budget
 *
 * Every minute of this costs real money, and the link is going to be posted
 * in public. So every device gets FREE_SECONDS (ten minutes) of talking,
 * counted here against `vibe_magician_usage`, and then a 402 with a message
 * the page turns into an "out of minutes" screen. The count is kept on the
 * server clock: a session is charged from the moment it is minted until the
 * last heartbeat, and a client that stops reporting is charged for its whole
 * session (up to SESSION_CAP_SECONDS) the next time it asks for one. The
 * device id is whatever the browser says it is, which a determined person
 * can reset; this is a spending guard, not a paywall, and the IP is kept so
 * a flood from one place is visible.
 *
 * Signed-in admins (ADMIN_EMAILS, plus the MAGICIAN_ADMIN_EMAILS secret) are
 * exempt, so the demo can run all day. `seconds_granted` is how a purchase,
 * or a top-up by hand in SQL, adds time; MAGICIAN_PAY_URL, if set, is
 * offered on the out-of-minutes screen.
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const FREE_SECONDS = 600;
const SESSION_CAP_SECONDS = 600;
const ADMIN_EMAILS = ["jackcmielke@gmail.com"];

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

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

interface Usage {
  device_id: string;
  seconds_used: number;
  seconds_granted: number;
  sessions: number;
  session_started_at: string | null;
  session_last_seen_at: string | null;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

/** Who is calling, if they are signed in. */
async function callerEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false } });
    const { data } = await anon.auth.getUser(token);
    return data.user?.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function isAdmin(email: string | null): boolean {
  if (!email) return false;
  const extra = (Deno.env.get("MAGICIAN_ADMIN_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...ADMIN_EMAILS, ...extra].includes(email);
}

function cleanDevice(v: unknown): string | null {
  return typeof v === "string" && /^[a-z0-9-]{8,64}$/i.test(v) ? v : null;
}

/** Charge the session in flight up to now (or up to the cap), and clear it. */
function settle(u: Usage, now: Date): Usage {
  if (!u.session_started_at) return u;
  const started = new Date(u.session_started_at).getTime();
  const seen = u.session_last_seen_at ? new Date(u.session_last_seen_at).getTime() : started;
  // Trust the heartbeat trail; a client that went quiet pays for the gap it
  // could have talked through, capped.
  const quiet = Math.max(0, now.getTime() - seen);
  const ran = Math.max(0, seen - started) + Math.min(quiet, 45_000);
  const charge = Math.min(SESSION_CAP_SECONDS, Math.round(ran / 1000));
  return { ...u, seconds_used: u.seconds_used + charge, session_started_at: null, session_last_seen_at: null };
}

async function loadUsage(device: string): Promise<Usage> {
  const db = admin();
  const { data } = await db.from("vibe_magician_usage").select("device_id, seconds_used, seconds_granted, sessions, session_started_at, session_last_seen_at").eq("device_id", device).maybeSingle();
  return (data as Usage | null) ?? { device_id: device, seconds_used: 0, seconds_granted: 0, sessions: 0, session_started_at: null, session_last_seen_at: null };
}

async function saveUsage(u: Usage, ip: string | null): Promise<void> {
  const db = admin();
  await db.from("vibe_magician_usage").upsert({ ...u, last_ip: ip, updated_at: new Date().toISOString() }, { onConflict: "device_id" });
}

function secondsLeft(u: Usage): number {
  return Math.max(0, FREE_SECONDS + u.seconds_granted - u.seconds_used);
}

function limitReply(u: Usage): Response {
  return reply(402, {
    error: "Out of free minutes",
    code: "limit",
    secondsUsed: u.seconds_used,
    secondsFree: FREE_SECONDS + u.seconds_granted,
    payUrl: Deno.env.get("MAGICIAN_PAY_URL") ?? null,
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
  const device = cleanDevice(body.device);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const email = await callerEmail(req);
  const exempt = isAdmin(email);
  const now = new Date();

  if (action === "status") {
    let left: number | null = null;
    if (device && !exempt) {
      try { left = secondsLeft(settle(await loadUsage(device), now)); } catch { left = null; }
    }
    return reply(200, {
      configured: Boolean(apiKey),
      engines: apiKey ? ["realtime", "live"] : [],
      secondsLeft: exempt ? null : left,
      secondsFree: FREE_SECONDS,
      unlimited: exempt,
      payUrl: Deno.env.get("MAGICIAN_PAY_URL") ?? null,
    });
  }
  if (action === "heartbeat") {
    if (!device || exempt) return reply(200, { ok: true, secondsLeft: null });
    try {
      const u = await loadUsage(device);
      if (!u.session_started_at) return reply(200, { ok: true, secondsLeft: secondsLeft(u) });
      const started = new Date(u.session_started_at).getTime();
      const running = Math.round((now.getTime() - started) / 1000);
      const left = Math.max(0, FREE_SECONDS + u.seconds_granted - u.seconds_used - running);
      await saveUsage({ ...u, session_last_seen_at: now.toISOString() }, ip);
      if (left <= 0) return limitReply({ ...u, seconds_used: u.seconds_used + running });
      return reply(200, { ok: true, secondsLeft: left });
    } catch (err) {
      return reply(200, { ok: true, secondsLeft: null, note: err instanceof Error ? err.message : String(err) });
    }
  }
  if (action === "end") {
    if (device && !exempt) {
      try { await saveUsage(settle(await loadUsage(device), now), ip); } catch { /* charged next time */ }
    }
    return reply(200, { ok: true });
  }
  if (!apiKey) {
    return reply(500, {
      error: "OpenAI is not connected to this project (OPENAI_API_KEY is not set)",
      code: "no_key",
    });
  }
  if (action !== "realtime" && action !== "live") return reply(400, { error: `Unknown action ${action}` });

  // The budget, unless the caller is exempt. No device id means no budget to
  // count against, which is not a free pass: it is refused.
  let usage: Usage | null = null;
  if (!exempt) {
    if (!device) return reply(400, { error: "A device id is required", code: "no_device" });
    try {
      usage = settle(await loadUsage(device), now);
      if (secondsLeft(usage) <= 0) { await saveUsage(usage, ip); return limitReply(usage); }
    } catch (err) {
      // If the ledger is unreachable, fail closed: the key is the expensive thing.
      return reply(503, { error: `The minute ledger is unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  try {
    const res = action === "realtime" ? await mintRealtime(apiKey, body as unknown as RealtimeBody) : await openLive(apiKey, body as unknown as LiveBody);
    if (res.ok && usage) {
      await saveUsage({ ...usage, sessions: usage.sessions + 1, session_started_at: now.toISOString(), session_last_seen_at: now.toISOString() }, ip);
      // Tell the client how long it has, so it can count down and stop itself.
      const data = await res.json();
      return reply(200, { ...data, secondsLeft: secondsLeft(usage) });
    }
    return res;
  } catch (err) {
    return reply(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
