/**
 * The plaza newsstand — today's front page of The Vibe Times, in-world.
 * Reads the same issue the /times page prints (live from the presses, or
 * the committed copy if they are unreachable), so each morning's edition
 * shows up here on its own. Walk up to read.
 */
import * as THREE from "three";
import { loadCurrentIssue } from "@/lib/vibeTimes";

export interface Newsstand {
  group: THREE.Group;
  dispose: () => void;
}

export function createNewsstand(opts: { position: THREE.Vector3; rotationY?: number }): Newsstand {
  const group = new THREE.Group();
  group.position.copy(opts.position);
  group.rotation.y = opts.rotationY ?? 0;

  // Kiosk body: a little wooden stand with a slanted display board.
  const wood = new THREE.MeshLambertMaterial({ color: "#7a5433" });
  const woodDark = new THREE.MeshLambertMaterial({ color: "#5d3f26" });
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 0.9), wood);
  base.position.y = 0.5;
  group.add(base);
  const roofPost = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.4, 0.14), woodDark);
  for (const s of [-1, 1]) {
    const p = roofPost.clone();
    p.position.set(s * 1.15, 1.2, -0.3);
    group.add(p);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.12, 1.5), new THREE.MeshLambertMaterial({ color: "#c0392b" }));
  roof.position.set(0, 2.45, -0.1);
  roof.rotation.x = -0.12;
  group.add(roof);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 768;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 2.28),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  board.position.set(0, 1.62, 0.47);
  board.rotation.x = -0.16;
  group.add(board);

  const draw = (issue: {
    issue?: number;
    date?: string;
    motto?: string;
    headlines?: { emoji: string; headline: string }[];
  } | null) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#efe8d8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2a2118";
    ctx.textAlign = "center";
    ctx.font = "bold 64px Georgia, serif";
    ctx.fillText("The Vibe Times", canvas.width / 2, 88);
    ctx.font = "italic 24px Georgia, serif";
    // The motto is written fresh for each edition; the old one is the
    // fallback for the frame drawn before the paper has arrived.
    ctx.fillText(issue?.motto ?? "all the news that fits the sky", canvas.width / 2, 126);
    ctx.strokeStyle = "#2a2118";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(40, 150); ctx.lineTo(600, 150); ctx.stroke();
    ctx.font = "20px Georgia, serif";
    ctx.fillText(`Issue №${issue?.issue ?? "—"} · ${issue?.date ?? ""}`, canvas.width / 2, 184);

    ctx.textAlign = "left";
    const heads = (issue?.headlines ?? []).slice(0, 4);
    let y = 250;
    for (const h of heads) {
      ctx.font = "bold 30px Georgia, serif";
      const words = `${h.emoji} ${h.headline}`.split(" ");
      let line = "";
      for (const w of words) {
        if (ctx.measureText(line + w).width > 540 && line) {
          ctx.fillText(line.trim(), 48, y);
          y += 38;
          line = "";
        }
        line += w + " ";
      }
      ctx.fillText(line.trim(), 48, y);
      y += 56;
      if (y > canvas.height - 90) break;
    }
    ctx.textAlign = "center";
    ctx.font = "italic 24px Georgia, serif";
    ctx.fillText("— walk up to read the full issue —", canvas.width / 2, canvas.height - 40);
    texture.needsUpdate = true;
  };

  draw(null);
  loadCurrentIssue()
    .then(draw)
    .catch(() => {});

  return {
    group,
    dispose() {
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
