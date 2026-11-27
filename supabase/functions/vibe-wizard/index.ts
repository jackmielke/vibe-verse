/**
 * vibe-wizard — the Wizard of Vibe Island grants wishes into a shared world.
 *
 * POST { action: "wish",  world, device, author, text, here: {x,y,z,yaw}, tier?: "fast"|"smart", history? }
 * POST { action: "fork",  world, device, author, name? }      → a new world you own, copied from `world`
 * POST { action: "undo",  edit, device }                       → takes one of your wishes back
 *
 * A wish becomes data, never code (see spec.ts), and lands as a row in
 * `wizard_edits`. Every browser on that world is subscribed to the table and
 * folds the rows into what is standing, so a wish appears for everybody at
 * once, and survives a reload because it is the database.
 *
 * Two minds. A fast model hears every wish and either grants it, refuses it
 * in character, or says it is too big; the client then asks again with
 * tier "smart" and a slower, cleverer model builds it with a bigger budget
 * while the Wizard "consults the ancient scrolls". The refusal is two
 * layers: OpenAI's moderation endpoint first (free, and not something a
 * clever prompt talks its way past), then the Wizard's own judgement.
 *
 * The device id is a capability for undo and for editing a fork, so only its
 * SHA-256 is stored and the tables are public to read.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import {
  cleanOps, fold, LIMITS, placeOps, snapshotOps, toLocal, WISH_SCHEMA_HELP,
  type EditRow, type Here, type Op, type Thing,
} from "./spec.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PER_HOUR = { fast: 40, smart: 10 };
const PER_DAY_ALL = 4000;

const FAST: Array<{ model: string; extra: Record<string, unknown> }> = [
  { model: "gpt-5.4-mini", extra: { reasoning_effort: "low" } },
  { model: "gpt-5-mini", extra: { reasoning_effort: "minimal" } },
  { model: "gpt-4.1-mini", extra: {} },
];
const SMART: Array<{ via: "openrouter" | "openai"; model: string; extra: Record<string, unknown> }> = [
  { via: "openrouter", model: "anthropic/claude-opus-4.5", extra: {} },
  { via: "openrouter", model: "anthropic/claude-sonnet-4.5", extra: {} },
  { via: "openai", model: "gpt-5.4", extra: { reasoning_effort: "low" } },
  { via: "openai", model: "gpt-5", extra: { reasoning_effort: "low" } },
];

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wizard:" + s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const slug = () => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(7))) s += a[b % a.length];
  return s;
};

function persona(tier: "fast" | "smart", admin: boolean) {
  const lim = LIMITS[tier];
  return `You are the Wizard of Vibe Island, a warm, theatrical, slightly silly old wizard in a starry hat.
Players walk up and ask you for things, and you conjure them into the world in front of them. You love saying yes.

What you grant: almost anything. Creatures, buildings, statues, vehicles to look at, food, plants, signs, art,
silly things, magical things, cartoon pirate ships and castles and cannons and knights and dragons. Playful
cartoon peril and storybook adventure are fine: a knight facing a dragon, pirates with cannons, a wizard duel,
a snowball fight, laser tag, a monster truck rally. When an ask is a game mechanic you cannot make from shapes (scoring, driving, physics),
conjure the best-looking version of it and say in one cheerful sentence that the moving parts are beyond your
staff for now${admin ? ", and that the Archmage in Build mode (the Build pill) can write the real spell" : ""}.

What you refuse, always in character and kindly, offering a gentler alternative: gore, blood, torture, cruelty,
killing or hurting people, realistic weapons aimed at people, anything sexual, hateful symbols or slurs, and
anything mocking a real person. "Too violent" is your main line, and it means gory or cruel, not adventurous:
a cartoon cannon or a knight with a sword is fine, a pile of bodies is not. When unsure, grant a playful version.
Never use em dashes or en dashes in what you say; use commas or full stops.

${tier === "fast"
    ? `Your budget for one wish is ${lim.things} things and about ${lim.parts} parts each. If the wish is clearly
bigger than that (a whole village, a castle complex, a racetrack, a roller coaster, a city block, a fleet) reply
with verdict "escalate" and a line like "Ooh, that needs the ancient scrolls. Give me a moment!" and no ops.
Do not escalate ordinary single creatures, buildings or props; just build them.`
    : `You have consulted the ancient scrolls: this is a big wish and you have a big budget, up to ${lim.things}
things with up to ${lim.parts} parts each. Build something impressive, detailed and well composed. Never escalate.`}

You may also change or remove things already near the player when they ask ("make it blue", "bigger", "get rid
of the dragon"): use their ids from NEARBY. Never remove things the player did not ask about.
Reply in English unless the player wrote in another language.
${WISH_SCHEMA_HELP}`;
}

function extractJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* nope */ } }
  return null;
}

async function think(tier: "fast" | "smart", system: string, user: string): Promise<{ out: Record<string, unknown>; model: string }> {
  const openai = Deno.env.get("OPENAI_API_KEY");
  const router = Deno.env.get("OPENROUTER_API_KEY");
  const tries = tier === "fast" ? FAST.map((f) => ({ via: "openai" as const, ...f })) : SMART;
  let last = "no model available";
  for (const t of tries) {
    const key = t.via === "openai" ? openai : router;
    if (!key) continue;
    const url = t.via === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
    const body: Record<string, unknown> = {
      model: t.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...t.extra,
    };
    if (t.via === "openai") {
      body.response_format = { type: "json_object" };
      body.max_completion_tokens = tier === "fast" ? 9000 : 24000;
    } else {
      body.max_tokens = 14000;
    }
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(tier === "fast" ? 50000 : 110000),
      });
      if (!r.ok) { last = `${t.model} ${r.status} ${(await r.text()).slice(0, 200)}`; continue; }
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      const out = extractJson(typeof text === "string" ? text : "");
      if (out) return { out, model: t.model };
      last = `${t.model} returned no JSON`;
    } catch (e) {
      last = `${t.model} ${String(e).slice(0, 200)}`;
    }
  }
  throw new Error(last);
}

const REFUSE_CATEGORIES = ["violence/graphic", "sexual", "sexual/minors", "hate", "hate/threatening", "self-harm", "self-harm/intent", "self-harm/instructions", "harassment/threatening"];
async function moderate(text: string): Promise<string | null> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.results?.[0];
    if (!res) return null;
    for (const c of REFUSE_CATEGORIES) if (res.categories?.[c]) return c;
    if ((res.category_scores?.violence ?? 0) > 0.9) return "violence";
    return null;
  } catch {
    return null; // the Wizard's own judgement is the second layer
  }
}

const REFUSALS = [
  "Hmm, no no no. My staff only does gentle magic. How about something wonderful instead?",
  "That spell is far too grim for this island! Ask me for something delightful.",
  "My hat wilts at the very thought. Let's conjure something kinder.",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "wish");
    const device = String(body.device ?? "").slice(0, 80);
    if (device.length < 8) return json({ ok: false, error: "device required" }, 400);
    const deviceHash = await sha(device);
    const author = String(body.author ?? "a traveller").trim().slice(0, 32) || "a traveller";

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Signed-in admins skip the hourly limit and hear about Build mode.
    let admin = false;
    const auth = req.headers.get("Authorization") ?? "";
    if (auth.startsWith("Bearer ") && auth.split(".").length === 3) {
      const { data } = await db.auth.getUser(auth.slice(7)).catch(() => ({ data: null }));
      const uid = data?.user?.id;
      if (uid) {
        const { data: ok } = await db.rpc("has_role", { _user_id: uid, _role: "admin" });
        admin = !!ok;
      }
    }

    const loadWorld = async (id: string) => {
      const { data: w } = await db.from("wizard_worlds").select("*").eq("id", id).maybeSingle();
      if (!w) return null;
      const { data: rows } = await db
        .from("wizard_edits").select("id, ops, undone").eq("world_id", id).order("id", { ascending: true }).limit(2000);
      return { world: w, state: fold((rows ?? []) as EditRow[]) };
    };

    if (action === "undo") {
      const editId = Number(body.edit);
      const { data: e } = await db.from("wizard_edits").select("id, world_id, device_hash, undone").eq("id", editId).maybeSingle();
      if (!e) return json({ ok: false, error: "no such wish" }, 404);
      const { data: w } = await db.from("wizard_worlds").select("owner_hash").eq("id", e.world_id).maybeSingle();
      if (e.device_hash !== deviceHash && w?.owner_hash !== deviceHash && !admin) {
        return json({ ok: false, error: "only the wisher can take it back" }, 403);
      }
      await db.from("wizard_edits").update({ undone: !body.redo ? true : false }).eq("id", editId);
      return json({ ok: true });
    }

    const worldId = String(body.world ?? "commons").slice(0, 40);

    if (action === "fork") {
      const src = await loadWorld(worldId);
      if (!src) return json({ ok: false, error: "no such world" }, 404);
      const { count } = await db.from("wizard_worlds").select("id", { count: "exact", head: true })
        .eq("owner_hash", deviceHash).gte("created_at", new Date(Date.now() - 86400000).toISOString());
      if ((count ?? 0) >= 20 && !admin) return json({ ok: false, error: "That's a lot of worlds for one day! Try again tomorrow." }, 429);
      const id = slug();
      const name = String(body.name ?? `${author}'s world`).trim().slice(0, 48) || `${author}'s world`;
      const { error } = await db.from("wizard_worlds").insert({ id, name, parent_id: worldId, owner_hash: deviceHash, owner_name: author });
      if (error) throw error;
      const ops = snapshotOps(src.state);
      if (ops.length) {
        await db.from("wizard_edits").insert({
          world_id: id, device_hash: deviceHash, author, prompt: `remix of ${src.world.name}`, reply: null, ops, tier: "fork",
        });
      }
      return json({ ok: true, world: { id, name, parent_id: worldId, owner_name: author } });
    }

    if (action !== "wish") return json({ ok: false, error: "unknown action" }, 400);

    const text = String(body.text ?? "").trim().slice(0, 600);
    if (!text) return json({ ok: false, error: "say something to the Wizard" }, 400);
    const tier: "fast" | "smart" = body.tier === "smart" ? "smart" : "fast";
    const h = body.here ?? {};
    const here: Here = {
      x: Number(h.x) || 0, y: Number(h.y) || 0, z: Number(h.z) || 0, yaw: Number(h.yaw) || 0,
    };

    const loaded = await loadWorld(worldId);
    if (!loaded) return json({ ok: false, error: "no such world" }, 404);
    if (loaded.world.owner_hash && loaded.world.owner_hash !== deviceHash && !admin) {
      return json({ ok: false, error: "This world belongs to somebody else. Remix it to make your own!", code: "not_owner" }, 403);
    }

    // Every wish is logged, granted or not: the rate limit counts asks, not
    // grants, and it is where to read what people want and what got refused.
    const started = Date.now();
    const logWish = (verdict: string, reply: string, model?: string, why?: string) =>
      db.from("wizard_requests").insert({
        world_id: worldId, device_hash: deviceHash, author, prompt: text, tier, verdict, reply, model, why, ms: Date.now() - started,
      }).then(() => {}, () => {});

    if (!admin) {
      const since = new Date(Date.now() - 3600000).toISOString();
      const { count } = await db.from("wizard_requests").select("id", { count: "exact", head: true })
        .eq("device_hash", deviceHash).eq("tier", tier).gte("created_at", since);
      if ((count ?? 0) >= PER_HOUR[tier]) {
        return json({ ok: true, verdict: "tired", say: "Phew, my staff needs a rest. Come back in a little while!" });
      }
      const { count: all } = await db.from("wizard_requests").select("id", { count: "exact", head: true })
        .gte("created_at", new Date(Date.now() - 86400000).toISOString());
      if ((all ?? 0) >= PER_DAY_ALL) {
        return json({ ok: true, verdict: "tired", say: "The whole island has worn me out today. The magic returns tomorrow!" });
      }
    }

    const flagged = await moderate(text);
    if (flagged) {
      await logWish("refuse", "", "moderation", flagged);
      return json({ ok: true, verdict: "refuse", say: REFUSALS[Math.floor(Math.random() * REFUSALS.length)], why: flagged });
    }

    // What is standing near the wisher, in their own frame, so "make it blue" has a referent.
    const nearby = [...loaded.state.things.values()]
      .map((t: Thing) => ({ t, d: Math.hypot(t.at[0] - here.x, t.at[2] - here.z) }))
      .filter((n) => n.d < 70)
      .sort((a, b) => a.d - b.d)
      .slice(0, 24)
      .map(({ t }) => ({ id: t.id, name: t.name, at: toLocal(t.at, here), by: t.by, parts: t.parts.length }));
    const known = new Set(nearby.map((n) => n.id));

    const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
      .map((m: { who?: string; text?: string }) => `${m.who === "wizard" ? "Wizard" : "Player"}: ${String(m.text ?? "").slice(0, 300)}`)
      .join("\n");

    const user = JSON.stringify({ player: author, wish: text, nearby, recent_conversation: history || undefined });
    let out: Record<string, unknown>, model: string;
    try {
      ({ out, model } = await think(tier, persona(tier, admin), user));
    } catch (e) {
      await logWish("error", "", undefined, String((e as Error)?.message ?? e).slice(0, 300));
      throw e;
    }

    let verdict = String(out.verdict ?? "grant");
    let say = String(out.say ?? "").replace(/\s*[\u2014\u2013]\s*/g, ", ").slice(0, 400) || "Abracadabra!";
    if (verdict === "escalate" && tier === "fast") {
      await logWish("escalate", say, model);
      return json({ ok: true, verdict: "escalate", say, model });
    }
    if (verdict === "refuse") {
      await logWish("refuse", say, model, "wizard");
      return json({ ok: true, verdict: "refuse", say, model });
    }

    const lim = LIMITS[tier];
    const ops: Op[] = placeOps(cleanOps(out.ops, lim.parts), here, slug().slice(0, 4), author, tier, known);
    if (!ops.length) {
      verdict = "fizzle";
      if (!out.say) say = "Hmm, the spell fizzled. Try telling me a little more about it?";
      await logWish("fizzle", say, model);
      return json({ ok: true, verdict, say, model });
    }

    const { data: row, error } = await db.from("wizard_edits").insert({
      world_id: worldId, device_hash: deviceHash, author, prompt: text, reply: say, ops, tier, model,
    }).select("id, world_id, author, prompt, reply, ops, tier, model, undone, created_at").single();
    if (error) throw error;
    await logWish("grant", say, model);
    await db.from("wizard_worlds").update({ updated_at: new Date().toISOString() }).eq("id", worldId);

    return json({ ok: true, verdict: "grant", say, model, edit: row });
  } catch (e) {
    console.error("vibe-wizard", e);
    return json({ ok: false, error: "The spell backfired: " + String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
});
