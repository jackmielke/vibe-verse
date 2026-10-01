/**
 * ugc-report: a player reported or blocked somebody (src/safety/safety.ts).
 *
 * Stores the row in `ugc_reports` and DMs Jack in Slack through the Radish
 * Hub's bot, because Apple asks that reports be acted on within 24 hours and
 * that the developer hears about every block. Reports DM immediately; blocks
 * are stored and DM'd too, but quietly labelled, since a block alone needs no
 * action.
 *
 *   POST { kind: "report"|"block", reason?, world?, path?, target_name?,
 *          target_id?, content?, device?, user_id? } -> { ok: true }
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

// The Radish Hub's slack-send function and its public anon key (the same one its website ships).
const SLACK_SEND = "https://cjjapnirqwzhnvvrslhn.supabase.co/functions/v1/radish-slack-send";
const RADISH_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqamFwbmlycXd6aG52dnJzbGhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY2NzU2MTAsImV4cCI6MjA2MjI1MTYxMH0.l0dkt26GjyEA1EbsC8XCaaqQ4vuxdK8wItOZitMCSyw";
const NOTIFY = "jackcmielke@gmail.com";

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: JSON_HEADERS });
  }
  const kind = body.kind === "block" ? "block" : body.kind === "report" ? "report" : null;
  if (!kind) return new Response(JSON.stringify({ error: "kind" }), { status: 400, headers: JSON_HEADERS });

  const row = {
    kind,
    reason: str(body.reason, 120),
    world: str(body.world, 80),
    path: str(body.path, 200),
    target_name: str(body.target_name, 80),
    target_id: str(body.target_id, 120),
    content: str(body.content, 1000),
    reporter_device: str(body.device, 64),
    reporter_user: uuid(body.user_id),
  };
  if (!row.target_name && !row.target_id && !row.content) {
    return new Response(JSON.stringify({ error: "nothing to report" }), { status: 400, headers: JSON_HEADERS });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await db.from("ugc_reports").insert(row).select("id").single();
  if (error) {
    console.error("insert failed", error);
    return new Response(JSON.stringify({ error: "store failed" }), { status: 500, headers: JSON_HEADERS });
  }

  const lines = [
    kind === "report" ? `🚩 *Vibe Verse report*: ${row.reason ?? "no reason"}` : `🚫 Vibe Verse block (no action needed)`,
    `Player: ${row.target_name ?? "?"}${row.target_id ? ` (${row.target_id})` : ""}`,
    row.content ? `Content: “${row.content}”` : null,
    `Where: ${row.world ?? "?"} ${row.path ?? ""}`,
    `Report id: ${data.id}`,
    kind === "report" ? "Apple requires action within 24 hours." : null,
  ].filter(Boolean);

  try {
    await fetch(SLACK_SEND, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RADISH_ANON}` },
      body: JSON.stringify({ recipients: [NOTIFY], message: lines.join("\n") }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("slack failed", e); // the row is stored either way
  }

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
});
