/**
 * agentRosterBoard — a sleek scoreboard-style TV on Edge Island that
 * lists the agents currently in the `vibe-lobby` room and their tile
 * positions on the 12×8 lobby grid.
 *
 * Subscribes to `world_agents` realtime so the screen updates the
 * moment an agent joins, moves, or goes offline. Exposes a `position`
 * vector and `getAgents()` so City.tsx can wire a proximity click into
 * a fuller modal.
 *
 * Visual: tall dark monitor on chrome legs, mint LED bezel with a
 * scrolling "● LIVE" header, magenta accent strip on the antenna.
 */
import * as THREE from "three";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface RosterAgent {
  id: string;
  key: string;
  name: string;
  status: string;
  x: number | null;
  y: number | null;
  updatedAt: number; // ms epoch, local
}

export interface AgentRosterBoard {
  group: THREE.Group;
  /** World-space ground point right in front of the screen — used for
   *  proximity checks. */
  position: THREE.Vector3;
  /** Snapshot of the current roster (sorted by name). */
  getAgents(): RosterAgent[];
  /** Subscribe to roster changes (fires on any add/update/remove). */
  onUpdate(cb: (agents: RosterAgent[]) => void): () => void;
  /** Per-frame screen tick (animates the LED header). */
  update(dt: number): void;
  dispose(): void;
}

const SCREEN_W = 1024;
const SCREEN_H = 640;

export function createAgentRosterBoard(opts: {
  /** World-space position of the board base (feet of the stand). */
  position: THREE.Vector3;
  /** Yaw in radians — 0 means screen faces +Z. */
  rotationY?: number;
  /** Which `world_agents.room_id` to mirror. */
  roomId?: string;
}): AgentRosterBoard {
  const roomId = opts.roomId ?? "vibe-lobby";
  const group = new THREE.Group();
  group.position.copy(opts.position);
  group.rotation.y = opts.rotationY ?? 0;

  // ---- Canvas screen ----------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext("2d")!;
  const screenTex = new THREE.CanvasTexture(canvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.minFilter = THREE.LinearFilter;

  // ---- Frame ------------------------------------------------------------
  const darkMat = new THREE.MeshStandardMaterial({
    color: "#0d1118",
    roughness: 0.45,
    metalness: 0.55,
  });
  const bezelMat = new THREE.MeshStandardMaterial({
    color: "#1a1f2c",
    roughness: 0.4,
    metalness: 0.6,
  });
  const mintGlow = new THREE.MeshStandardMaterial({
    color: "#2dd4a8",
    emissive: "#2dd4a8",
    emissiveIntensity: 1.6,
    roughness: 0.3,
  });
  const magentaGlow = new THREE.MeshStandardMaterial({
    color: "#e85d75",
    emissive: "#e85d75",
    emissiveIntensity: 1.2,
    roughness: 0.3,
  });
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex });

  // Stand legs (two chrome legs + crossbar)
  const STAND_H = 2.1;
  [-1.6, 1.6].forEach((x) => {
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, STAND_H, 12),
      darkMat,
    );
    leg.position.set(x, STAND_H / 2, 0);
    group.add(leg);
    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.55, 0.18, 18),
      darkMat,
    );
    foot.position.set(x, 0.09, 0);
    group.add(foot);
  });
  const cross = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.18, 0.32), darkMat);
  cross.position.set(0, 0.6, 0);
  group.add(cross);

  // Main body
  const BODY_W = 6.2;
  const BODY_H = 4.0;
  const BODY_D = 0.55;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D),
    bezelMat,
  );
  body.position.set(0, STAND_H + BODY_H / 2 + 0.1, 0);
  group.add(body);

  // Inner dark bezel
  const inner = new THREE.Mesh(
    new THREE.BoxGeometry(BODY_W - 0.5, BODY_H - 0.5, 0.05),
    darkMat,
  );
  inner.position.set(0, body.position.y, BODY_D / 2 + 0.01);
  group.add(inner);

  // Screen plane
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(BODY_W - 0.7, BODY_H - 0.7),
    screenMat,
  );
  screen.position.set(0, body.position.y, BODY_D / 2 + 0.04);
  group.add(screen);

  // Mint edge ribbon (top + bottom of screen)
  [BODY_H / 2 - 0.25, -BODY_H / 2 + 0.25].forEach((dy) => {
    const ribbon = new THREE.Mesh(
      new THREE.BoxGeometry(BODY_W - 0.6, 0.06, 0.06),
      mintGlow,
    );
    ribbon.position.set(0, body.position.y + dy, BODY_D / 2 + 0.05);
    group.add(ribbon);
  });

  // Antenna with magenta tip
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8),
    darkMat,
  );
  antenna.position.set(0, body.position.y + BODY_H / 2 + 0.7, -BODY_D / 4);
  group.add(antenna);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), magentaGlow);
  tip.position.set(0, body.position.y + BODY_H / 2 + 1.45, -BODY_D / 4);
  group.add(tip);

  // Subtle backlight
  const back = new THREE.PointLight(0x2dd4a8, 14, 9, 2);
  back.position.set(0, body.position.y, BODY_D / 2 + 0.6);
  group.add(back);

  // ---- Roster state -----------------------------------------------------
  const agents = new Map<string, RosterAgent>();
  const subscribers = new Set<(a: RosterAgent[]) => void>();
  let ledPhase = 0;

  const snapshot = (): RosterAgent[] =>
    Array.from(agents.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  const notify = () => {
    const snap = snapshot();
    for (const cb of subscribers) cb(snap);
  };

  // ---- Drawing ----------------------------------------------------------
  const drawScreen = () => {
    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
    g.addColorStop(0, "#070a10");
    g.addColorStop(1, "#0d141d");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // Scanlines
    ctx.fillStyle = "rgba(45, 212, 168, 0.04)";
    for (let y = 0; y < SCREEN_H; y += 4) ctx.fillRect(0, y, SCREEN_W, 1);

    // Header bar
    ctx.fillStyle = "#0a1218";
    ctx.fillRect(0, 0, SCREEN_W, 88);
    ctx.fillStyle = "#2dd4a8";
    ctx.fillRect(0, 86, SCREEN_W, 2);
    // Pulsing LIVE dot
    const pulse = 0.55 + 0.45 * Math.sin(ledPhase * 4);
    ctx.fillStyle = `rgba(232, 93, 117, ${pulse})`;
    ctx.beginPath();
    ctx.arc(48, 44, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#baffe9";
    ctx.font = "bold 38px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText("LIVE ROSTER", 78, 44);
    // Count pill on the right
    const count = agents.size;
    ctx.font = "bold 30px ui-monospace, monospace";
    const label = `${count} ONLINE`;
    const labelW = ctx.measureText(label).width + 36;
    ctx.fillStyle = "#10241a";
    ctx.strokeStyle = "#2dd4a8";
    ctx.lineWidth = 2;
    const px = SCREEN_W - labelW - 24;
    const py = 22;
    const ph = 44;
    const rr = 22;
    ctx.beginPath();
    ctx.moveTo(px + rr, py);
    ctx.arcTo(px + labelW, py, px + labelW, py + ph, rr);
    ctx.arcTo(px + labelW, py + ph, px, py + ph, rr);
    ctx.arcTo(px, py + ph, px, py, rr);
    ctx.arcTo(px, py, px + labelW, py, rr);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#7dfce0";
    ctx.fillText(label, px + 18, py + ph / 2);

    // Column headers
    ctx.font = "bold 22px ui-monospace, monospace";
    ctx.fillStyle = "#5cf0c4";
    ctx.textAlign = "left";
    ctx.fillText("AGENT", 64, 122);
    ctx.fillText("TILE", 660, 122);
    ctx.fillText("STATUS", 850, 122);
    ctx.strokeStyle = "rgba(45, 212, 168, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 144);
    ctx.lineTo(SCREEN_W - 40, 144);
    ctx.stroke();

    // Rows
    const rows = snapshot();
    if (rows.length === 0) {
      ctx.fillStyle = "#5b6776";
      ctx.font = "italic 28px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("waiting for agents…", SCREEN_W / 2, SCREEN_H / 2 + 20);
      ctx.font = "20px ui-monospace, monospace";
      ctx.fillStyle = "#3a4756";
      ctx.fillText(
        "tune in when somebody joins the vibe-lobby",
        SCREEN_W / 2,
        SCREEN_H / 2 + 56,
      );
    } else {
      const ROW_H = 44;
      const MAX_ROWS = Math.floor((SCREEN_H - 200) / ROW_H);
      const shown = rows.slice(0, MAX_ROWS);
      shown.forEach((row, i) => {
        const ry = 160 + i * ROW_H;
        // Zebra
        if (i % 2 === 0) {
          ctx.fillStyle = "rgba(45, 212, 168, 0.04)";
          ctx.fillRect(40, ry, SCREEN_W - 80, ROW_H - 4);
        }
        // Status dot
        const offline = row.status === "offline";
        ctx.fillStyle = offline ? "#6b7280" : "#2dd4a8";
        ctx.beginPath();
        ctx.arc(58, ry + ROW_H / 2 - 2, 7, 0, Math.PI * 2);
        ctx.fill();
        // Name
        ctx.fillStyle = offline ? "#6b7280" : "#e8fff5";
        ctx.font = "bold 26px ui-monospace, monospace";
        ctx.textAlign = "left";
        const nm = row.name.length > 28 ? row.name.slice(0, 27) + "…" : row.name;
        ctx.fillText(nm, 78, ry + ROW_H / 2);
        // Tile
        ctx.fillStyle = "#a7e7d3";
        ctx.font = "24px ui-monospace, monospace";
        const tile =
          row.x === null || row.y === null
            ? "  —  "
            : `${String(row.x).padStart(2, " ")},${String(row.y).padStart(2, " ")}`;
        ctx.fillText(tile, 660, ry + ROW_H / 2);
        // Status
        ctx.fillStyle = offline ? "#6b7280" : "#5cf0c4";
        ctx.fillText(row.status || "online", 850, ry + ROW_H / 2);
      });
      if (rows.length > shown.length) {
        ctx.fillStyle = "#5b6776";
        ctx.font = "italic 20px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          `+ ${rows.length - shown.length} more — walk up to see all`,
          SCREEN_W / 2,
          SCREEN_H - 56,
        );
      }
    }

    // Footer ticker
    ctx.fillStyle = "#0a1218";
    ctx.fillRect(0, SCREEN_H - 36, SCREEN_W, 36);
    ctx.fillStyle = "#2dd4a8";
    ctx.fillRect(0, SCREEN_H - 36, SCREEN_W, 2);
    ctx.fillStyle = "#5cf0c4";
    ctx.font = "18px ui-monospace, monospace";
    ctx.textAlign = "left";
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    ctx.fillText(`EDGE ISLAND · vibe-lobby · ${time}`, 18, SCREEN_H - 17);
    ctx.textAlign = "right";
    ctx.fillText("press E to open", SCREEN_W - 18, SCREEN_H - 17);

    screenTex.needsUpdate = true;
  };

  // First paint (empty state)
  drawScreen();

  // ---- Data wiring ------------------------------------------------------
  const upsert = (row: {
    id?: string;
    agent_key?: string;
    name?: string;
    status?: string;
    x?: number | null;
    y?: number | null;
  }) => {
    const key = row.agent_key || row.id;
    if (!key) return;
    if (row.status === "offline") {
      if (agents.delete(key)) {
        drawScreen();
        notify();
      }
      return;
    }
    const prev = agents.get(key);
    agents.set(key, {
      id: row.id ?? prev?.id ?? key,
      key,
      name: row.name ?? prev?.name ?? "agent",
      status: row.status ?? prev?.status ?? "online",
      x: (row.x ?? prev?.x ?? null) as number | null,
      y: (row.y ?? prev?.y ?? null) as number | null,
      updatedAt: Date.now(),
    });
    drawScreen();
    notify();
  };

  const remove = (key: string) => {
    if (agents.delete(key)) {
      drawScreen();
      notify();
    }
  };

  // Initial fetch
  void (async () => {
    const { data, error } = await supabase
      .from("world_agents")
      .select("id, agent_key, name, status, room_id, x, y")
      .eq("room_id", roomId);
    if (error) {
      console.warn("[agentRosterBoard] fetch failed", error);
      return;
    }
    for (const row of data ?? []) {
      if ((row as { status?: string }).status === "offline") continue;
      upsert(row as never);
    }
  })();

  const channel: RealtimeChannel = supabase
    .channel("agent-roster-board")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "world_agents",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => upsert(payload.new as never),
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "world_agents",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => upsert(payload.new as never),
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "world_agents" },
      (payload) => {
        const row = payload.old as { agent_key?: string; id?: string };
        const key = row.agent_key || row.id;
        if (key) remove(key);
      },
    )
    .subscribe();

  // Repaint footer clock every few seconds so the time stays current.
  const clockTimer = window.setInterval(() => drawScreen(), 2500);

  // Approach point: a few meters in front of the screen, in world space.
  // Front face is +Z in local space, so rotate offset by yaw.
  const localFront = new THREE.Vector3(0, 0, 2.4);
  const rotY = opts.rotationY ?? 0;
  const interactPos = new THREE.Vector3(
    opts.position.x + Math.sin(rotY) * localFront.z,
    opts.position.y,
    opts.position.z + Math.cos(rotY) * localFront.z,
  );

  return {
    group,
    position: interactPos,
    getAgents: snapshot,
    onUpdate(cb) {
      subscribers.add(cb);
      cb(snapshot());
      return () => {
        subscribers.delete(cb);
      };
    },
    update(dt) {
      ledPhase += dt;
    },
    dispose() {
      window.clearInterval(clockTimer);
      void supabase.removeChannel(channel);
      subscribers.clear();
      screenTex.dispose();
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
