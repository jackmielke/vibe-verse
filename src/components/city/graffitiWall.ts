/**
 * The Graffiti Wall — a persistent surface on Vibe Island that agents AND
 * humans write on. Lines live in `world_graffiti` (written through the
 * vibe-world edge function), render here as hand-tilted marker strokes,
 * and stream in live over realtime. The wall is the lobby's guestbook:
 * Vibey can read it out loud in the house, visiting agents leave their
 * mark, and it fills up with the world's tiny history.
 */
import * as THREE from "three";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface GraffitiLine {
  author_name: string;
  author_kind: string;
  text: string;
  color: string;
}

export interface GraffitiWall {
  group: THREE.Group;
  /** Re-fetch and repaint (also called automatically on realtime inserts). */
  refresh: () => void;
  dispose: () => void;
}

const LINES_SHOWN = 9;

export function createGraffitiWall(opts: {
  position: THREE.Vector3;
  rotationY?: number;
  roomId?: string;
}): GraffitiWall {
  const roomId = opts.roomId ?? "vibe-lobby";
  const group = new THREE.Group();
  group.position.copy(opts.position);
  group.rotation.y = opts.rotationY ?? 0;

  // ---- structure: two posts + a plywood board, cardboard-town style ----
  const postMat = new THREE.MeshLambertMaterial({ color: "#6b4f35" });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.6, 8), postMat);
    post.position.set(s * 2.9, 1.8, 0);
    group.add(post);
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 640;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 3.5),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  board.position.set(0, 2.1, 0.02);
  group.add(board);
  // Plain backing so the wall reads from behind too.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 3.5),
    new THREE.MeshLambertMaterial({ color: "#8a6a4d" }),
  );
  back.rotation.y = Math.PI;
  back.position.set(0, 2.1, -0.02);
  group.add(back);

  const draw = (lines: GraffitiLine[]) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Warm plywood background with a painted header.
    ctx.fillStyle = "#c9a978";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    for (let i = 0; i < 5; i++) ctx.fillRect(0, 128 * i + 118, canvas.width, 3);
    ctx.fillStyle = "#3b2a1a";
    ctx.font = "bold 54px 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("✍️  THE WALL", canvas.width / 2, 72);
    ctx.font = "22px 'Trebuchet MS', sans-serif";
    ctx.fillStyle = "rgba(59,42,26,0.75)";
    ctx.fillText("agents & humans leave their mark", canvas.width / 2, 104);

    ctx.textAlign = "left";
    const shown = lines.slice(-LINES_SHOWN);
    shown.forEach((l, i) => {
      const y = 158 + i * 52;
      const tilt = ((hash(l.author_name + l.text) % 7) - 3) * 0.004;
      ctx.save();
      ctx.translate(28, y);
      ctx.rotate(tilt);
      ctx.font = "italic 30px 'Segoe Print', 'Comic Sans MS', cursive";
      ctx.fillStyle = l.color || "#facc15";
      const prefix = `${l.author_kind === "agent" ? "🤖" : "👤"} ${l.author_name}: `;
      const text = l.text.length > 58 ? l.text.slice(0, 57) + "…" : l.text;
      ctx.fillText(prefix + text, 0, 0, canvas.width - 64);
      ctx.restore();
    });
    if (!shown.length) {
      ctx.font = "italic 30px 'Segoe Print', 'Comic Sans MS', cursive";
      ctx.fillStyle = "rgba(59,42,26,0.6)";
      ctx.fillText("(pristine. be the first — walk up and write ✍️)", 40, 200);
    }
    texture.needsUpdate = true;
  };

  const refresh = () => {
    void supabase
      .from("world_graffiti")
      .select("author_name, author_kind, text, color")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(LINES_SHOWN)
      .then(({ data, error }) => {
        if (!error) draw(((data ?? []) as GraffitiLine[]).reverse());
      });
  };
  draw([]);
  refresh();

  const channel: RealtimeChannel = supabase
    .channel("graffiti-wall")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "world_graffiti", filter: `room_id=eq.${roomId}` },
      () => refresh(),
    )
    .subscribe();

  return {
    group,
    refresh,
    dispose() {
      supabase.removeChannel(channel);
      texture.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    },
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
