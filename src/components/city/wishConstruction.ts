/**
 * Wish construction sites — the God Orb's pending wishes, visibly being
 * built at the south edge of town. Each of the top pending wishes gets a
 * real little site: dirt, scaffolding, a crane, a warm glowing core, and
 * a sign naming the wish and its wisher. When the loop grants a wish it
 * leaves this row (and blooms in the Wish Garden instead) — so the town
 * literally grows outward, wish by wish.
 */
import * as THREE from "three";

interface Wish {
  text: string;
  author: string;
  status: string | null;
}

export interface WishConstruction {
  group: THREE.Group;
  setWishes: (wishes: Wish[]) => void;
  dispose: () => void;
}

// Rotated ~180° so the signs greet foot traffic arriving from the plaza.
const SITE_SLOTS: Array<[number, number, number]> = [
  [-7, 0, Math.PI + 0.4],
  [0, 1.2, Math.PI - 0.25],
  [7, 0.2, Math.PI + 0.3],
];

export function createWishConstruction(): WishConstruction {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];

  const wood = new THREE.MeshLambertMaterial({ color: "#8a6a4d" });
  const woodDark = new THREE.MeshLambertMaterial({ color: "#5d3f26" });
  const dirtMat = new THREE.MeshLambertMaterial({ color: "#6b4b2f" });
  const glowMat = new THREE.MeshBasicMaterial({ color: "#ffd166", transparent: true, opacity: 0.85 });
  disposables.push(wood, woodDark, dirtMat, glowMat);

  const buildSite = (wish: Wish, slot: [number, number, number]) => {
    const site = new THREE.Group();
    site.position.set(slot[0], 0, slot[1]);
    site.rotation.y = slot[2];

    // Dirt patch.
    const dirt = new THREE.Mesh(new THREE.CircleGeometry(2.4, 18), dirtMat);
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.02;
    site.add(dirt);

    // Scaffold: four corner posts + top beams.
    for (const [sx, sz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), wood);
      post.position.set(sx, 1.3, sz);
      site.add(post);
    }
    for (const [rot, z] of [[0, -1.4], [0, 1.4]] as const) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(2.94, 0.12, 0.12), woodDark);
      beam.position.set(0, 2.62, z);
      beam.rotation.y = rot;
      site.add(beam);
    }
    for (const x of [-1.4, 1.4]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.94), woodDark);
      beam.position.set(x, 2.62, 0);
      site.add(beam);
    }

    // The incubating wish: a warm glowing core on a pallet.
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), glowMat);
    core.position.y = 0.9;
    site.add(core);

    // Mini crane: mast, arm, cable, hook.
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.6, 0.18), woodDark);
    mast.position.set(2.2, 1.8, -1.9);
    site.add(mast);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.14), woodDark);
    arm.position.set(1.1, 3.55, -1.9);
    site.add(arm);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.3, 4), woodDark);
    cable.position.set(0.1, 2.9, -1.9);
    site.add(cable);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), glowMat);
    hook.position.set(0.1, 2.2, -1.9);
    site.add(hook);

    // The sign: what's being built, and who wished it.
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#f6d365";
      ctx.fillRect(0, 0, 512, 256);
      ctx.strokeStyle = "#3b2a1a";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, 502, 246);
      ctx.fillStyle = "#3b2a1a";
      ctx.textAlign = "center";
      ctx.font = "bold 34px 'Trebuchet MS', sans-serif";
      ctx.fillText("🏗️ UNDER CONSTRUCTION", 256, 52);
      ctx.font = "italic 28px Georgia, serif";
      const text = wish.text.length > 60 ? wish.text.slice(0, 59) + "…" : wish.text;
      // Word-wrap the wish across up to 3 lines.
      const words = text.split(" ");
      let line = "";
      let y = 108;
      for (const w of words) {
        if (ctx.measureText(`“${line}${w}”`).width > 460 && line) {
          ctx.fillText(line.trim(), 256, y);
          y += 36;
          line = "";
          if (y > 180) break;
        }
        line += w + " ";
      }
      if (y <= 180 && line) ctx.fillText(`“${line.trim()}”`, 256, y);
      ctx.font = "24px 'Trebuchet MS', sans-serif";
      ctx.fillText(`wished by ${wish.author || "someone"}`, 256, 224);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const signMat = new THREE.MeshBasicMaterial({ map: tex });
    disposables.push(tex, signMat);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), signMat);
    sign.position.set(0, 1.5, 2.05);
    site.add(sign);
    const signBack = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), wood);
    signBack.rotation.y = Math.PI;
    signBack.position.set(0, 1.5, 2.03);
    site.add(signBack);
    for (const sx of [-0.9, 0.9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), woodDark);
      leg.position.set(sx, 0.8, 2.04);
      site.add(leg);
    }

    return site;
  };

  let sites: THREE.Group[] = [];

  return {
    group,
    setWishes(wishes) {
      for (const s of sites) group.remove(s);
      sites = [];
      const pending = wishes
        .filter((w) => (w.status ?? "pending").toLowerCase() !== "granted")
        .slice(0, SITE_SLOTS.length);
      pending.forEach((w, i) => {
        const site = buildSite(w, SITE_SLOTS[i]);
        group.add(site);
        sites.push(site);
      });
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
    },
  };
}
