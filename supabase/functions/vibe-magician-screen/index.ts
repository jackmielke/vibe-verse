/**
 * vibe-magician-screen: writes programs for the Magic Screen in /magician.
 *
 * Somebody says "put a game of snake on the screen" and the voice agent
 * calls `program_screen`. The page sends the request here (and the code the
 * screen is running now, when it is a change rather than a new program), and
 * this function asks a fast OpenAI model to write it, streaming the code
 * straight back as plain text so the screen can show it being written.
 *
 * What comes back is only ever text. It runs in the page's sandbox (an
 * opaque-origin iframe with a no-network CSP, and a worker inside it), so
 * the worst a bad program can do is draw something ugly on one screen.
 *
 * Budget: SCREEN_PER_DEVICE programs per device and SCREEN_PER_DAY across
 * the valley in a rolling 24 hours, counted in `vibe_magician_screen`.
 * Signed-in admins are exempt. A program costs well under a cent.
 *
 *   POST { action: "write", request, previous?, error?, device }  -> text/plain stream
 *   POST { action: "status", device }                               -> { configured, left }
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const SCREEN_PER_DEVICE = 40;
const SCREEN_PER_DAY = 600;
const ADMIN_EMAILS = ["jackcmielke@gmail.com"];
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

/** Tried in order; a model the account does not have falls through to the next. */
const ATTEMPTS: Array<{ model: string; extra: Record<string, unknown> }> = [
  { model: "gpt-5.4-mini", extra: { reasoning_effort: "low" } },
  { model: "gpt-5.4-mini", extra: {} },
  { model: "gpt-5-mini", extra: { reasoning_effort: "minimal" } },
  { model: "gpt-4.1-mini", extra: {} },
];

const SYSTEM = `You write small JavaScript programs for the Magic Screen: a big glowing screen in a carved wooden frame standing in the square of Hoshimura, a peaceful valley village in rural Japan inside a 3D world. People stand 5 to 20 metres away and watch it together; everyone in the valley sees the same program.

The program runs in a Web Worker drawing on an OffscreenCanvas. These already exist; never redeclare them:
- ctx: a CanvasRenderingContext2D for a W by H canvas. W = 480, H = 270.
- input: { left, right, up, down, a, b, pressed } booleans and { x, y } numbers 0..1, the live controls of whoever is playing (arrow keys, WASD or a joystick; a = space or the A button; b = enter; x, y, pressed = where they point on the screen). It is replaced each frame; read it, never write it.
- rand(): seeded random 0..1, the same sequence for every viewer. Math.random is fine for pure decoration.
- beep(freq, seconds, type, volume): a short synth sound. type is "sine", "square", "triangle" or "sawtooth"; volume 0..1. Use sparingly, a few per second at most.
- state: an empty object you may keep things on (top-level let and const work too).

Define function draw(t, dt). It is called about 24 times a second: t is seconds since the program started (the same for every viewer), dt is seconds since the last frame. Optionally define function setup(), called once before the first draw.

Rules:
- No DOM, no document, no window, no fetch or any network, no eval, no import, no requestAnimationFrame (draw is called for you), no images or fonts to load: draw everything with the canvas 2D API.
- Repaint the whole canvas every frame unless trails are the point.
- It must read well from a distance: bold shapes, rich colour, text at least 14px. The valley's taste is soft, magical and warm; Japanese touches are welcome when they fit.
- Games: show the controls briefly in small text, keep score, and restart on their own after game over. Controls come only from input.
- Every loop must be bounded; each frame must finish quickly.
- Keep it under 220 lines.

Output ONLY the JavaScript source. No markdown fences, no explanation before or after. The first line must be a comment naming it, for example: // Title: Koi Pond`;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

async function callerEmail(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
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

async function counts(device: string): Promise<{ device: number; day: number }> {
  const db = admin();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [d, all] = await Promise.all([
    db.from("vibe_magician_screen").select("id", { count: "exact", head: true }).eq("device_id", device).gte("created_at", since),
    db.from("vibe_magician_screen").select("id", { count: "exact", head: true }).gte("created_at", since),
  ]);
  return { device: d.count ?? 0, day: all.count ?? 0 };
}

function userMessage(request: string, previous: string | null, error: string | null): string {
  if (previous && error) {
    return `The screen is running this program:\n\n${previous}\n\nIt crashed with this error:\n${error}\n\nFix it so it runs, keeping what it does. ${request ? `(It was asked for: ${request})` : ""}`;
  }
  if (previous) {
    return `The screen is running this program:\n\n${previous}\n\nChange it as asked, keeping everything that is not mentioned. The request: ${request}`;
  }
  return `Make this for the screen: ${request}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return reply(400, { error: "JSON body required" }); }
  const device = cleanDevice(body.device);
  const email = await callerEmail(req);
  const unlimited = isAdmin(email);

  if (body.action === "status") {
    if (!device) return reply(200, { configured: !!apiKey, left: null });
    const c = await counts(device).catch(() => ({ device: 0, day: 0 }));
    return reply(200, { configured: !!apiKey, left: unlimited ? null : Math.max(0, SCREEN_PER_DEVICE - c.device), unlimited });
  }
  if (body.action !== "write") return reply(400, { error: "Unknown action" });
  if (!apiKey) return reply(503, { error: "The screen has no coder yet (no OPENAI_API_KEY).", code: "unconfigured" });
  if (!device) return reply(400, { error: "A device id is required" });

  const request = String(body.request ?? "").trim().slice(0, 500);
  const previous = typeof body.previous === "string" && body.previous.trim() ? body.previous.slice(0, 20000) : null;
  const error = typeof body.error === "string" && body.error.trim() ? body.error.slice(0, 600) : null;
  if (!request && !error) return reply(400, { error: "Say what the screen should show" });

  if (!unlimited) {
    const c = await counts(device).catch(() => ({ device: 0, day: 0 }));
    if (c.day >= SCREEN_PER_DAY) return reply(402, { error: "The screen has made enough magic for one day.", code: "daycap" });
    if (c.device >= SCREEN_PER_DEVICE) return reply(402, { error: "You have made a lot of screens today. More tomorrow!", code: "devicecap" });
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userMessage(request, previous, error) },
  ];
  let upstream: Response | null = null;
  let model = "";
  let lastText = "";
  let lastStatus = 502;
  for (const a of ATTEMPTS) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: a.model, messages, stream: true, max_completion_tokens: 7000, ...a.extra }),
    });
    if (r.ok && r.body) { upstream = r; model = a.model; break; }
    lastStatus = r.status;
    lastText = await r.text().catch(() => "");
    if (r.status !== 400 && r.status !== 404 && r.status !== 403) break;
  }
  if (!upstream || !upstream.body) {
    return reply(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, { error: `The coder refused: ${lastStatus} ${lastText.slice(0, 400)}` });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let chars = 0;
  let full = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              const delta = j.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) { chars += delta.length; if (full.length < 40000) full += delta; controller.enqueue(encoder.encode(delta)); }
            } catch { /* a partial line; the next read completes it */ }
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`\n// stream broke: ${String(e).slice(0, 120)}\n`));
      } finally {
        controller.close();
        await admin().from("vibe_magician_screen").insert({ device_id: device, ip, request: (error ? `[fix] ${request}` : request).slice(0, 500), model, chars, code: full }).then(() => undefined, () => undefined);
      }
    },
  });
  return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Model": model, "Access-Control-Expose-Headers": "X-Model" } });
});
