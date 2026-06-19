/**
 * meshy-generate — generate a 3D GLB from a text prompt or an image
 * via the Meshy API, then upload it to Supabase Storage and return
 * the public URL. The client inserts an `island_spawns` row pointing
 * to the model_url so every player on the island sees it spawn live.
 *
 * Body (JSON):
 *   { prompt: string }                       -> text-to-3d
 *   { image_url: string, prompt?: string }   -> image-to-3d
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

async function pollTask(taskId: string, mode: "text" | "image"): Promise<any> {
  const url = mode === "text"
    ? `https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`
    : `https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`;
  const start = Date.now();
  // Meshy preview typically finishes in 30–90s; cap at 4 min.
  while (Date.now() - start < 4 * 60 * 1000) {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${MESHY_API_KEY}` },
    });
    if (!r.ok) throw new Error(`Meshy poll failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    if (j.status === "SUCCEEDED") return j;
    if (j.status === "FAILED" || j.status === "CANCELED") {
      throw new Error(`Meshy task ${j.status}: ${j.task_error?.message ?? "unknown"}`);
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error("Meshy task timed out");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!MESHY_API_KEY) throw new Error("MESHY_API_KEY not configured");

    // Require an authenticated user so we can attribute the model.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claims, error: authErr } = await userClient.auth.getClaims(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userSub = claims.claims.sub as string;

    const body = await req.json().catch(() => ({}));
    const prompt: string | undefined = typeof body.prompt === "string" ? body.prompt.trim() : undefined;
    const imageUrl: string | undefined = typeof body.image_url === "string" ? body.image_url : undefined;

    if (!prompt && !imageUrl) {
      return new Response(JSON.stringify({ error: "Provide `prompt` or `image_url`" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (prompt && prompt.length > 280) {
      return new Response(JSON.stringify({ error: "prompt too long (max 280)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    await ensureBucket(admin);

    // ---- 1. Create the Meshy task (preview only — fast, cheap) -----
    let taskId: string;
    let mode: "text" | "image";
    if (imageUrl) {
      mode = "image";
      const r = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MESHY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageUrl,
          enable_pbr: true,
          ai_model: "meshy-6",
        }),
      });
      if (!r.ok) throw new Error(`Meshy image-to-3d failed: ${r.status} ${await r.text()}`);
      taskId = (await r.json()).result;
    } else {
      mode = "text";
      const r = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MESHY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "preview",
          prompt,
          art_style: "realistic",
          ai_model: "meshy-6",
        }),
      });
      if (!r.ok) throw new Error(`Meshy text-to-3d failed: ${r.status} ${await r.text()}`);
      taskId = (await r.json()).result;
    }

    // ---- 2. Poll until finished -----------------------------------
    const task = await pollTask(taskId, mode);
    const glbUrl: string | undefined = task.model_urls?.glb;
    const thumbUrl: string | undefined = task.thumbnail_url;
    if (!glbUrl) throw new Error("Meshy task succeeded but returned no GLB url");

    // ---- 3. Download GLB + thumbnail, upload to our storage -------
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
      } catch (_) { /* thumbnail is best-effort */ }
    }

    return new Response(
      JSON.stringify({
        model_url: publicGlb,
        thumbnail_url: publicThumb,
        task_id: taskId,
        mode,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("meshy-generate error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
