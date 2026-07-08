/**
 * roadmapBoard — 🛸 MISSION CONTROL: the living roadmap, in-world.
 *
 * A big billboard on the plaza that renders /roadmap.json — a snapshot
 * of the Notion "VibeVerse - Roadmap" database that Claude's recurring
 * Mission Control sweep regenerates on every run. Two columns: what
 * shipped, what's up next. The world literally displays its own
 * development loop.
 *
 * Data flow: Notion DB → (sweep) → public/roadmap.json → this board.
 * If the JSON is missing the board still stands, with a placeholder.
 */
import * as THREE from "three";

interface RoadmapItem {
  idea: string;
  status: string;
  area?: string;
}

export interface RoadmapBoard {
  group: THREE.Group;
  update(dt: number, now: number): void;
}

const W = 1024;
const H = 640;

function drawBoard(
  ctx: CanvasRenderingContext2D,
  items: RoadmapItem[] | null,
  generated: string | null,
) {
  // Backdrop: deep space glass.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#101726");
  bg.addColorStop(1, "#0a1020");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(122, 240, 255, 0.55)";
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // Header.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 54px 'Sora', system-ui, sans-serif";
  ctx.shadowColor = "#7af0ff";
  ctx.shadowBlur = 26;
  ctx.fillStyle = "#eafcff";
  ctx.fillText("🛸 MISSION CONTROL", W / 2, 56);
  ctx.shadowBlur = 0;
  ctx.font = "24px 'Manrope', sans-serif";
  ctx.fillStyle = "#7af0ff";
  ctx.fillText("the living roadmap · steered from Notion · built by Claude", W / 2, 104);

  if (!items || items.length === 0) {
    ctx.font = "28px 'Manrope', sans-serif";
    ctx.fillStyle = "#9fb2c4";
    ctx.fillText("tuning into mission control…", W / 2, H / 2);
    return;
  }

  const shipped = items.filter((i) => i.status === "Done").slice(-9).reverse();
  const next = items.filter((i) => i.status === "Not started").slice(0, 9);

  const drawColumn = (
    title: string,
    color: string,
    list: RoadmapItem[],
    x0: number,
    colW: number,
  ) => {
    ctx.textAlign = "left";
    ctx.font = "bold 30px 'Sora', system-ui, sans-serif";
    ctx.fillStyle = color;
    ctx.fillText(title, x0, 160);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x0, 180, colW - 40, 3);
    ctx.font = "23px 'Manrope', sans-serif";
    list.forEach((item, i) => {
      const y = 218 + i * 42;
      ctx.fillStyle = color;
      ctx.fillText(title.startsWith("✅") ? "✦" : "·", x0, y);
      ctx.fillStyle = "#dbe7f3";
      let label = item.idea;
      while (ctx.measureText(label).width > colW - 78 && label.length > 4) {
        label = label.slice(0, -2);
      }
      if (label !== item.idea) label += "…";
      ctx.fillText(label, x0 + 26, y);
    });
  };

  drawColumn("✅ SHIPPED", "#5fd068", shipped, 48, W / 2 - 48);
  drawColumn("🔜 UP NEXT", "#ffd166", next, W / 2 + 24, W / 2 - 48);

  // Footer.
  ctx.textAlign = "center";
  ctx.font = "20px 'Manrope', sans-serif";
  ctx.fillStyle = "#8fa3b8";
  ctx.fillText(
    `updated ${generated ?? "recently"} · wish new features into existence at the God Orb ✨`,
    W / 2,
    H - 30,
  );
}

export function buildRoadmapBoard(): RoadmapBoard {
  const group = new THREE.Group();

  // Two wooden posts + a slim frame, matching the city's signage.
  const postMat = new THREE.MeshStandardMaterial({ color: "#4a5462", roughness: 0.7, metalness: 0.3 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 4.4, 10), postMat);
    post.position.set(side * 4.4, 2.2, 0);
    group.add(post);
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  drawBoard(ctx, null, null);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(9.2, 5.75),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  panel.position.y = 3.3;
  group.add(panel);

  // Soft up-light so it reads at night.
  const glow = new THREE.PointLight(0x7af0ff, 5, 14, 1.8);
  glow.position.set(0, 1.2, 1.6);
  group.add(glow);

  // Load the live snapshot.
  fetch("/roadmap.json")
    .then((r) => r.json())
    .then((j: { generated?: string; items?: RoadmapItem[] }) => {
      drawBoard(ctx, Array.isArray(j?.items) ? j.items : [], j?.generated ?? null);
      tex.needsUpdate = true;
    })
    .catch(() => {
      /* board keeps its placeholder */
    });

  let t = 0;
  return {
    group,
    update(dt) {
      // Gentle attention-pulse on the up-light.
      t += dt;
      glow.intensity = 4.5 + Math.sin(t * 1.4) * 1.5;
    },
  };
}
