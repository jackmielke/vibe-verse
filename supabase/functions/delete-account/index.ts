/**
 * delete-account: a signed-in player deletes their own account (App Store
 * Guideline 5.1.1(v): an app that lets you make an account must let you
 * delete it, in the app).
 *
 * The caller's own JWT says who they are; nobody can delete anyone else.
 * Deleting the auth user cascades to `users` and their sessions. If the
 * database refuses (a row somewhere still points at them), the player is
 * signed out everywhere, Jack is DM'd to finish it by hand, and the reply
 * says it will be done within 24 hours — which Apple accepts.
 *
 *   POST (Authorization: Bearer <user jwt>) -> { ok: true, pending?: true }
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const SLACK_SEND = "https://cjjapnirqwzhnvvrslhn.supabase.co/functions/v1/radish-slack-send";
const RADISH_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqamFwbmlycXd6aG52dnJzbGhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY2NzU2MTAsImV4cCI6MjA2MjI1MTYxMH0.l0dkt26GjyEA1EbsC8XCaaqQ4vuxdK8wItOZitMCSyw";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return reply({ error: "not signed in" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: who, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !who.user) return reply({ error: "not signed in" }, 401);
  const user = who.user;

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (!error) return reply({ ok: true });

  console.error("deleteUser failed", error);
  await admin.auth.admin.signOut(jwt, "global").catch(() => {});
  await fetch(SLACK_SEND, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RADISH_ANON}` },
    body: JSON.stringify({
      recipients: ["jackcmielke@gmail.com"],
      message: `🗑️ Vibe Verse account deletion needs a hand: ${user.email ?? user.id} (${user.id}). deleteUser said: ${error.message}. Apple expects it done within 24 hours.`,
    }),
  }).catch(() => {});
  return reply({ ok: true, pending: true });
});
