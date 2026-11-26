// gatch-clip — Supabase Edge Function
//
// One tap turns a Gatch News replay clip (Cannon Chase) into a link anybody
// can open. The clip is recorded in the player's browser (src/cannonrun/
// replay.ts) and stays there until they press Share; then it comes here.
//
// This is an upload endpoint anybody can call, so it is deliberately narrow:
// the body must start with WebM or MP4 magic bytes, be under 8 MB, and the
// headline is cut to length. Each sender (a salted hash of the IP, never the
// IP) gets 30 clips a day and the whole game 3000, so the worst case is a
// bounded bill rather than a free video host.
//
// Routes:
//   POST /gatch-clip?headline=..&sub=..   body: the video bytes → { id, url, video }
//   GET  /gatch-clip?id=abc123            → { id, headline, sub, video }
//
// Deploy:
//   supabase functions deploy gatch-clip --no-verify-jwt
// Needs the `gatch-clips` bucket and `gatch_clips` table
// (migrations/20261126210000_gatch_clips.sql).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "gatch-clips";
const MAX_BYTES = 8 * 1024 * 1024;
const PER_SENDER_DAY = 30;
const ALL_DAY = 3000;
const SITE = Deno.env.get("SITE_URL") ?? "https://myvibeverse.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clean = (s: string | null, n: number): string => (s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

function sniff(b: Uint8Array): string | null {
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4"; // ....ftyp
  return null;
}

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d).slice(0, 12)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, (x) => a[x % a.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const q = new URL(req.url).searchParams;
  const publicUrl = (path: string): string => `${url}/storage/v1/object/public/${BUCKET}/${path}`;

  if (req.method === "GET") {
    const id = clean(q.get("id"), 16).toLowerCase();
    if (!/^[a-z0-9]{8,16}$/.test(id)) return json({ error: "bad id" }, 400);
    const { data } = await sb.from("gatch_clips").select("id, path, headline, sub, type").eq("id", id).maybeSingle();
    if (!data) return json({ error: "not found" }, 404);
    return json({ id: data.id, headline: data.headline, sub: data.sub, type: data.type, video: publicUrl(data.path) });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return json({ error: "too big" }, 413);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length < 2000 || body.length > MAX_BYTES) return json({ error: "bad size" }, 413);
  const type = sniff(body);
  if (!type) return json({ error: "not a video" }, 415);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const sender = await hash(`gatch:${ip}:${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!.slice(-12)}`);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    sb.from("gatch_clips").select("id", { count: "exact", head: true }).eq("sender", sender).gt("created_at", since),
    sb.from("gatch_clips").select("id", { count: "exact", head: true }).gt("created_at", since),
  ]);
  if ((mine ?? 0) >= PER_SENDER_DAY || (all ?? 0) >= ALL_DAY) return json({ error: "That's a lot of news for one day. Try again tomorrow." }, 429);

  const id = newId();
  const path = `${id}.${type === "video/mp4" ? "mp4" : "webm"}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, body, { contentType: type, cacheControl: "31536000", upsert: false });
  if (upErr) return json({ error: "upload failed" }, 500);
  const { error: rowErr } = await sb.from("gatch_clips").insert({
    id, path, type, bytes: body.length, sender,
    headline: clean(q.get("headline"), 120), sub: clean(q.get("sub"), 160),
  });
  if (rowErr) { await sb.storage.from(BUCKET).remove([path]); return json({ error: "save failed" }, 500); }
  return json({ id, url: `${SITE}/gatch/${id}`, video: publicUrl(path) });
});
