/**
 * meshy-generate — two-phase async pattern to dodge the 150s edge timeout.
 *
 * Body (JSON):
 *   { action: "start", prompt }                  -> { task_id, mode }
 *   { action: "start", image_url, prompt? }      -> { task_id, mode }
 *   { action: "status", task_id, mode }          -> { status, progress?,
 *                                                     model_url?, thumbnail_url? }
 *
 * The client polls "status" until status === "SUCCEEDED". On success the
 * function downloads the GLB + thumbnail and uploads them to our public
 * `meshy-models` bucket, returning the public URLs.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const MESHY_API_KEY = Deno.env.get("MESHY_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "meshy-models";

async function ensureBucket(admin: ReturnType<typeof createClient>) {
  const { data: buckets } = await admin.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    await admin.storage.createBucket(BUCKET, { public: true });
  }
}

function taskUrl(taskId: string, mode: "text" | "image") {
  return mode === "text"
    ? `https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`
    : `https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!MESHY_API_KEY) throw new Error("MESHY_API_KEY not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claims, error: authErr } = await userClient.auth.getClaims(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !claims?.claims?.sub) return jsonResponse({ error: "Unauthorized" }, 401);
    const userSub = claims.claims.sub as string;

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action: string = typeof body.action === "string" ? body.action : "start";

    // -------- START: create the Meshy task and return its id ----------
    if (action === "start") {
      const prompt: string | undefined = typeof body.prompt === "string" ? body.prompt.trim() : undefined;
      const imageUrl: string | undefined = typeof body.image_url === "string" ? body.image_url : undefined;

      if (!prompt && !imageUrl) return jsonResponse({ error: "Provide `prompt` or `image_url`" }, 400);
      if (prompt && prompt.length > 280) return jsonResponse({ error: "prompt too long (max 280)" }, 400);

      let taskId: string;
      let mode: "text" | "image";
      if (imageUrl) {
        mode = "image";
        const r = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
          method: "POST",
          headers: { Authorization: `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: imageUrl, enable_pbr: true, ai_model: "meshy-6" }),
        });
        if (!r.ok) throw new Error(`Meshy image-to-3d failed: ${r.status} ${await r.text()}`);
        taskId = (await r.json()).result;
      } else {
        mode = "text";
        const r = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
          method: "POST",
          headers: { Authorization: `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "preview", prompt, art_style: "realistic", ai_model: "meshy-6" }),
        });
        if (!r.ok) throw new Error(`Meshy text-to-3d failed: ${r.status} ${await r.text()}`);
        taskId = (await r.json()).result;
      }

      return jsonResponse({ task_id: taskId, mode, status: "PENDING" });
    }

    // -------- STATUS: poll once; if SUCCEEDED, upload to storage -------
    if (action === "status") {
      const taskId: string | undefined = typeof body.task_id === "string" ? body.task_id : undefined;
      const mode: "text" | "image" = body.mode === "image" ? "image" : "text";
      if (!taskId) return jsonResponse({ error: "Missing task_id" }, 400);

      const r = await fetch(taskUrl(taskId, mode), {
        headers: { Authorization: `Bearer ${MESHY_API_KEY}` },
      });
      if (!r.ok) throw new Error(`Meshy poll failed: ${r.status} ${await r.text()}`);
      const task = await r.json();

      if (task.status === "FAILED" || task.status === "CANCELED") {
        return jsonResponse({
          status: task.status,
          error: task.task_error?.message ?? "Meshy task failed",
        }, 200);
      }

      if (task.status !== "SUCCEEDED") {
        return jsonResponse({ status: task.status ?? "PENDING", progress: task.progress ?? null });
      }

      const glbUrl: string | undefined = task.model_urls?.glb;
      const thumbUrl: string | undefined = task.thumbnail_url;
      if (!glbUrl) throw new Error("Meshy task succeeded but returned no GLB url");

      const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
      await ensureBucket(admin);

      const glbResp = await fetch(glbUrl);
      if (!glbResp.ok) throw new Error(`Download GLB failed: ${glbResp.status}`);
      const glbBytes = new Uint8Array(await glbResp.arrayBuffer());

      const stamp = Date.now();
      const glbPath = `${userSub}/${stamp}-${taskId}.glb`;
      const glbUpload = await admin.storage.from(BUCKET).upload(glbPath, glbBytes, {
        contentType: "model/gltf-binary",
        upsert: false,
      });
      if (glbUpload.error) throw new Error(`Upload GLB failed: ${glbUpload.error.message}`);
      const publicGlb = admin.storage.from(BUCKET).getPublicUrl(glbPath).data.publicUrl;

      let publicThumb: string | null = null;
      if (thumbUrl) {
        try {
          const t = await fetch(thumbUrl);
          if (t.ok) {
            const tb = new Uint8Array(await t.arrayBuffer());
            const ext = thumbUrl.split("?")[0].split(".").pop()?.toLowerCase() || "png";
            const thumbPath = `${userSub}/${stamp}-${taskId}.${ext}`;
            const up = await admin.storage.from(BUCKET).upload(thumbPath, tb, {
              contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
              upsert: false,
            });
            if (!up.error) {
              publicThumb = admin.storage.from(BUCKET).getPublicUrl(thumbPath).data.publicUrl;
            }
          }
        } catch (_) { /* thumbnail best-effort */ }
      }

      return jsonResponse({
        status: "SUCCEEDED",
        model_url: publicGlb,
        thumbnail_url: publicThumb,
        task_id: taskId,
        mode,
      });
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("meshy-generate error:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown error" }, 500);
  }
});
