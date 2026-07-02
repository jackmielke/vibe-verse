/**
 * skyGames — four mini games, one per Vibeverse sky island.
 *
 *   Lone Tree Island → "Mole Meadow"   — whack-a-mole with your feet:
 *     moles pop out of meadow holes; stomp (run onto) them before they
 *     duck. 45 seconds, score = bops.
 *
 *   Crystal Isle → "Crystal Climb"     — a beacon race up the crystal
 *     skyline: 8 checkpoints light up one at a time, jetpack through
 *     them fast. Score = 90 − seconds taken (all 8 required).
 *
 *   Sky Shrine → "Shrine Dive"         — leap off the highest island
 *     and skydive through 10 rings down the mountain of air, landing
 *     on a glowing target. Score = rings × 8 (+20 bullseye landing).
 *
 *   Lantern Grove → "Lantern Echo"     — Simon says with lanterns: a
 *     color sequence flashes around the pond; walk to the lanterns in
 *     order. One mistake ends it. Score = rounds completed.
 *
 * All four run in-world inside /city using nothing but the player's
 * position — no modal, no iframe, no new controls to learn. The module
 * owns visuals + state machines; City owns the buttons, HUD line and
 * the $VIBE payout (server-side via vibe-economy `game_reward`).
 *
 * Everything here is decoration — no collision boxes are registered,
 * so games can never break movement.
 */
import * as THREE from "three";

export type SkyGameKey = "mole-meadow" | "crystal-climb" | "shrine-dive" | "lantern-echo";

export interface SkyGameEnd {
  key: SkyGameKey;
  name: string;
  /** Raw score the server converts to $VIBE (it re-clamps everything). */
  score: number;
  /** Human summary for the toast, e.g. "17 moles bopped". */
  detail: string;
}

export type SkyGameCue = "pop" | "good" | "bad" | "tick" | "go";

export interface SkyGamesWorld {
  group: THREE.Group;
  update(dt: number, now: number, playerPos: THREE.Vector3): void;
  /** Which game's start zone the player is in (null when a game is active). */
  nearGame(playerPos: THREE.Vector3): { key: SkyGameKey; name: string } | null;
  start(key: SkyGameKey): void;
  cancel(): void;
  activeKey(): SkyGameKey | null;
  /** One-line live status for the HUD while a game runs. */
  hudLine(): string | null;
  /** Fires once per run with the final score (0 for aborted runs). */
  onEnd: ((e: SkyGameEnd) => void) | null;
  /** Short audio cues City routes into citySounds. */
  onCue: ((cue: SkyGameCue) => void) | null;
}

// Island anchors — mirrors SPECS in skyIslands.ts (pad = walkable top center).
const LONE_TREE = new THREE.Vector3(-140, 55, 130); // r 20
const CRYSTAL = new THREE.Vector3(-240, 85, -20); // r 26
const SHRINE = new THREE.Vector3(-140, 115, -180); // r 18
const GROVE = new THREE.Vector3(40, 80, -230); // r 16

const GAME_META: Record<SkyGameKey, { name: string; anchor: THREE.Vector3; zone: number }> = {
  "mole-meadow": { name: "Mole Meadow", anchor: LONE_TREE, zone: 14 },
  "crystal-climb": { name: "Crystal Climb", anchor: CRYSTAL, zone: 16 },
  "shrine-dive": { name: "Shrine Dive", anchor: SHRINE, zone: 12 },
  "lantern-echo": { name: "Lantern Echo", anchor: GROVE, zone: 12 },
};

const COUNTDOWN = 3; // seconds of "get ready" before every game

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function textSprite(text: string, px = 42, color = "#baffe9"): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  s.scale.set(6, 1.5, 1);
  return s;
}

const flat = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z);

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------

export function buildSkyGames(): SkyGamesWorld {
  const group = new THREE.Group();

  // ---- start totems: a slowly-bobbing 🎮 marker at each island -------
  const totems: THREE.Sprite[] = [];
  (Object.keys(GAME_META) as SkyGameKey[]).forEach((key) => {
    const m = GAME_META[key];
    const s = textSprite(`🎮 ${m.name}`, 44);
    s.position.set(m.anchor.x, m.anchor.y + 3.4, m.anchor.z + m.zone * 0.35);
    group.add(s);
    totems.push(s);
  });

  // =========================================================================
  // Mole Meadow
  // =========================================================================
  const HOLES = 8;
  interface Mole {
    root: THREE.Group;
    body: THREE.Group;
    up: boolean;
    t: number; // time in current state
    stay: number; // how long it stays up
    bopped: boolean;
  }
  const moles: Mole[] = [];
  {
    const holeGeo = new THREE.CircleGeometry(1.05, 20);
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x241608 });
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.85 });
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xf2a0b8, roughness: 0.6 });
    for (let i = 0; i < HOLES; i++) {
      const a = (i / HOLES) * Math.PI * 2 + 0.35;
      const r = 8.5 + (i % 3);
      const root = new THREE.Group();
      root.position.set(
        LONE_TREE.x + Math.cos(a) * r,
        LONE_TREE.y + 0.06,
        LONE_TREE.z + Math.sin(a) * r,
      );
      const hole = new THREE.Mesh(holeGeo, holeMat);
      hole.rotation.x = -Math.PI / 2;
      root.add(hole);
      const body = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.6, 6, 12), bodyMat);
      torso.position.y = 0.55;
      body.add(torso);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), noseMat);
      nose.position.set(0, 0.95, 0.5);
      body.add(nose);
      for (const side of [-0.22, 0.22]) {
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x101010 }),
        );
        eye.position.set(side, 1.05, 0.42);
        body.add(eye);
      }
      body.position.y = -1.6; // hidden underground
      body.visible = false;
      root.add(body);
      group.add(root);
      moles.push({ root, body, up: false, t: 0, stay: 1.2, bopped: false });
    }
  }
  const MOLE_DURATION = 45;
  let moleScore = 0;
  let moleTime = 0;

  // =========================================================================
  // Crystal Climb
  // =========================================================================
  const BEACONS = 8;
  const beacons: THREE.Group[] = [];
  const beaconMats: THREE.MeshBasicMaterial[] = [];
  {
    for (let i = 0; i < BEACONS; i++) {
      const a = i * 0.95 + 0.4;
      const r = 9 + (i % 4) * 3.2;
      const y = 4 + i * 4.3;
      const g = new THREE.Group();
      g.position.set(
        CRYSTAL.x + Math.cos(a) * r,
        CRYSTAL.y + y,
        CRYSTAL.z + Math.sin(a) * r,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: 0x6fd9ff,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.12, 10, 40), mat);
      g.add(ring);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), mat);
      g.add(core);
      g.visible = false;
      group.add(g);
      beacons.push(g);
      beaconMats.push(mat);
    }
  }
  const CLIMB_TIMEOUT = 90;
  let climbIdx = 0;
  let climbTime = 0;

  // =========================================================================
  // Shrine Dive
  // =========================================================================
  const RINGS = 10;
  const DIVE_TARGET = new THREE.Vector3(-215, 0.2, -330); // open apron, off-grid
  interface DiveRing {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    hit: boolean;
  }
  const diveRings: DiveRing[] = [];
  let diveTargetDisc: THREE.Mesh;
  {
    const start = new THREE.Vector3(SHRINE.x - 4, SHRINE.y - 4, SHRINE.z - 10);
    for (let i = 0; i < RINGS; i++) {
      const t = (i + 1) / (RINGS + 1);
      const pos = start.clone().lerp(DIVE_TARGET.clone().setY(6), t);
      pos.x += Math.sin(t * Math.PI * 2) * 7; // lazy S-curve
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.16, 10, 44), mat);
      ring.position.copy(pos);
      // Face rings along the dive direction so you fall "through" them.
      ring.lookAt(DIVE_TARGET.x, 0, DIVE_TARGET.z);
      ring.visible = false;
      group.add(ring);
      diveRings.push({ mesh: ring, mat, hit: false });
    }
    diveTargetDisc = new THREE.Mesh(
      new THREE.CircleGeometry(5, 40),
      new THREE.MeshBasicMaterial({
        color: 0x4ade80,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    diveTargetDisc.rotation.x = -Math.PI / 2;
    diveTargetDisc.position.copy(DIVE_TARGET);
    diveTargetDisc.visible = false;
    group.add(diveTargetDisc);
  }
  const DIVE_TIMEOUT = 75;
  let diveHits = 0;
  let diveTime = 0;
  let diveStarted = false; // becomes true once the player leaves the shrine

  // =========================================================================
  // Lantern Echo
  // =========================================================================
  const LANTERNS = 5;
  const LANTERN_COLORS = [0x2dd4a8, 0xff7eb3, 0x6fd9ff, 0xffd166, 0xb78ae0];
  interface EchoLantern {
    group: THREE.Group;
    orbMat: THREE.MeshStandardMaterial;
    inside: boolean; // player currently within press radius
  }
  const lanterns: EchoLantern[] = [];
  {
    for (let i = 0; i < LANTERNS; i++) {
      const a = (i / LANTERNS) * Math.PI * 2 - Math.PI / 2;
      const r = 8.5;
      const g = new THREE.Group();
      g.position.set(
        GROVE.x + Math.cos(a) * r,
        GROVE.y,
        GROVE.z + Math.sin(a) * r,
      );
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.12, 1.7, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a3423, roughness: 0.95 }),
      );
      post.position.y = 0.85;
      g.add(post);
      const orbMat = new THREE.MeshStandardMaterial({
        color: LANTERN_COLORS[i],
        emissive: LANTERN_COLORS[i],
        emissiveIntensity: 0.25,
        roughness: 0.5,
      });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), orbMat);
      orb.position.y = 1.95;
      g.add(orb);
      group.add(g);
      lanterns.push({ group: g, orbMat, inside: false });
    }
  }
  const ECHO_MAX_ROUNDS = 12;
  let echoSeq: number[] = [];
  let echoInput = 0; // index into the sequence the player must match next
  let echoRound = 0;
  let echoPhase: "show" | "input" = "show";
  let echoShowIdx = 0;
  let echoShowT = 0;

  // =========================================================================
  // shared run state
  // =========================================================================
  let active: SkyGameKey | null = null;
  let countdown = 0;
  let hud: string | null = null;
  // Game clocks run on WALL time (from `now`), not frame dt — so a laggy
  // tab or a slow GPU never turns a 45s round into slow motion. The clamp
  // only guards against tab-sleep jumps.
  let lastNowMs = -1;

  const api: SkyGamesWorld = {
    group,
    onEnd: null,
    onCue: null,
    activeKey: () => active,
    hudLine: () => hud,

    nearGame(playerPos) {
      if (active) return null;
      for (const key of Object.keys(GAME_META) as SkyGameKey[]) {
        const m = GAME_META[key];
        if (flat(playerPos, m.anchor) < m.zone && Math.abs(playerPos.y - m.anchor.y) < 8) {
          return { key, name: m.name };
        }
      }
      return null;
    },

    start(key) {
      if (active) return;
      active = key;
      countdown = COUNTDOWN;
      hud = null;
      if (key === "mole-meadow") {
        moleScore = 0;
        moleTime = MOLE_DURATION;
        for (const m of moles) {
          m.up = false;
          m.t = Math.random() * 2;
          m.bopped = false;
          m.body.visible = false;
          m.body.position.y = -1.6;
          m.body.scale.set(1, 1, 1);
        }
      } else if (key === "crystal-climb") {
        climbIdx = 0;
        climbTime = 0;
        beacons.forEach((b, i) => {
          b.visible = true;
          beaconMats[i].opacity = 0.12;
        });
      } else if (key === "shrine-dive") {
        diveHits = 0;
        diveTime = 0;
        diveStarted = false;
        for (const r of diveRings) {
          r.hit = false;
          r.mesh.visible = true;
          r.mat.opacity = 0.35;
          r.mat.color.set(0xffd166);
        }
        diveTargetDisc.visible = true;
      } else if (key === "lantern-echo") {
        echoSeq = [Math.floor(Math.random() * LANTERNS)];
        for (let i = 1; i < 3; i++) echoSeq.push(Math.floor(Math.random() * LANTERNS));
        echoRound = 0;
        echoInput = 0;
        echoPhase = "show";
        echoShowIdx = -1;
        echoShowT = 0;
        for (const l of lanterns) l.inside = true; // require stepping OUT first
      }
    },

    cancel() {
      if (!active) return;
      finish(0, "run abandoned");
    },

    update(dt, now, playerPos) {
      const wallDt = lastNowMs < 0 ? 0 : Math.min((now - lastNowMs) / 1000, 1);
      lastNowMs = now;
      // Idle dressing: totems bob gently.
      totems.forEach((t, i) => {
        t.position.y = GAME_META[(Object.keys(GAME_META) as SkyGameKey[])[i]].anchor.y + 3.4 + Math.sin(now * 0.0012 + i) * 0.25;
      });

      if (!active) return;

      if (countdown > 0) {
        const before = Math.ceil(countdown);
        countdown -= wallDt;
        const after = Math.ceil(Math.max(0, countdown));
        if (after !== before && after > 0) api.onCue?.("tick");
        if (countdown <= 0) api.onCue?.("go");
        hud = countdown > 0
          ? `${GAME_META[active].name} — get ready… ${Math.ceil(countdown)}`
          : hud;
        if (countdown > 0) return;
      }

      switch (active) {
        case "mole-meadow": {
          moleTime -= wallDt;
          if (moleTime <= 0) {
            finish(moleScore, `${moleScore} mole${moleScore === 1 ? "" : "s"} bopped`);
            return;
          }
          // Difficulty ramps: moles stay up shorter as time passes.
          const speedup = 1 - (1 - moleTime / MOLE_DURATION) * 0.45;
          for (const m of moles) {
            m.t -= wallDt;
            if (!m.up && m.t <= 0) {
              // Pop up (keep at most 3 up).
              if (moles.filter((x) => x.up).length < 3) {
                m.up = true;
                m.bopped = false;
                m.stay = (0.9 + Math.random() * 0.9) * speedup;
                m.t = m.stay;
                m.body.visible = true;
                api.onCue?.("pop");
              } else {
                m.t = 0.3 + Math.random() * 0.5;
              }
            } else if (m.up) {
              // Animate rise/sink (bopped moles stay up briefly, squished).
              const k = m.bopped ? 0.65 : Math.min(1, (m.stay - m.t) * 8);
              m.body.position.y = -1.6 + k * 1.6;
              if (m.t <= 0) {
                m.up = false;
                m.body.visible = false;
                m.t = 0.6 + Math.random() * 1.6;
              }
              // Stomp check: close on the flat, roughly at meadow height.
              if (
                !m.bopped &&
                flat(playerPos, m.root.position) < 1.7 &&
                Math.abs(playerPos.y - LONE_TREE.y) < 3
              ) {
                m.bopped = true;
                moleScore++;
                m.body.scale.set(1.3, 0.25, 1.3); // squish!
                m.t = Math.min(m.t, 0.22);
                api.onCue?.("good");
              }
            }
          }
          hud = `Mole Meadow — ${moleScore} bopped · ${Math.ceil(moleTime)}s`;
          break;
        }

        case "crystal-climb": {
          climbTime += wallDt;
          if (climbTime > CLIMB_TIMEOUT) {
            finish(0, "the crystals dimmed (timeout)");
            return;
          }
          const target = beacons[climbIdx];
          // Current beacon pulses bright; already-hit ones vanish.
          beaconMats.forEach((m, i) => {
            m.opacity = i < climbIdx ? 0 : i === climbIdx ? 0.55 + Math.sin(now * 0.008) * 0.3 : 0.12;
          });
          target.rotation.y += dt * 2;
          if (playerPos.distanceTo(target.position) < 3.2) {
            climbIdx++;
            api.onCue?.(climbIdx >= BEACONS ? "go" : "good");
            if (climbIdx >= BEACONS) {
              const score = Math.max(5, Math.round(90 - climbTime));
              finish(score, `all 8 beacons in ${climbTime.toFixed(1)}s`);
              return;
            }
          }
          hud = `Crystal Climb — beacon ${climbIdx + 1}/${BEACONS} · ${climbTime.toFixed(1)}s`;
          break;
        }

        case "shrine-dive": {
          diveTime += wallDt;
          if (!diveStarted && flat(playerPos, SHRINE) > 20) diveStarted = true;
          for (const r of diveRings) {
            if (!r.hit && playerPos.distanceTo(r.mesh.position) < 3.4) {
              r.hit = true;
              diveHits++;
              r.mat.color.set(0x4ade80);
              r.mat.opacity = 0.8;
              api.onCue?.("good");
            }
            r.mesh.rotation.z += dt * 0.6;
          }
          (diveTargetDisc.material as THREE.MeshBasicMaterial).opacity =
            0.35 + Math.sin(now * 0.004) * 0.2;
          const landed = playerPos.y < DIVE_TARGET.y + 2.2 && diveStarted;
          if (landed || diveTime > DIVE_TIMEOUT) {
            const bullseye = flat(playerPos, DIVE_TARGET) < 5.5 && landed;
            const score = diveHits * 8 + (bullseye ? 20 : 0);
            finish(
              score,
              `${diveHits}/${RINGS} rings${bullseye ? " + bullseye landing!" : ""}`,
            );
            return;
          }
          hud = `Shrine Dive — ${diveHits}/${RINGS} rings · dive to the green pad!`;
          break;
        }

        case "lantern-echo": {
          if (echoPhase === "show") {
            echoShowT -= wallDt;
            if (echoShowT <= 0) {
              // Dim previous, light next.
              lanterns.forEach((l) => (l.orbMat.emissiveIntensity = 0.25));
              echoShowIdx++;
              if (echoShowIdx >= echoSeq.length) {
                echoPhase = "input";
                echoInput = 0;
              } else {
                lanterns[echoSeq[echoShowIdx]].orbMat.emissiveIntensity = 2.2;
                api.onCue?.("pop");
                echoShowT = 0.6;
              }
            }
            hud = `Lantern Echo — watch the lanterns… (round ${echoRound + 1})`;
          } else {
            // Input phase: entering a lantern's circle = pressing it.
            for (let i = 0; i < lanterns.length; i++) {
              const l = lanterns[i];
              const d = flat(playerPos, l.group.position);
              const wasInside = l.inside;
              l.inside = d < (wasInside ? 2.6 : 1.9); // hysteresis
              if (l.inside && !wasInside) {
                // Press!
                l.orbMat.emissiveIntensity = 2.2;
                setTimeout(() => (l.orbMat.emissiveIntensity = 0.25), 250);
                if (i === echoSeq[echoInput]) {
                  echoInput++;
                  api.onCue?.("good");
                  if (echoInput >= echoSeq.length) {
                    echoRound++;
                    if (echoRound >= ECHO_MAX_ROUNDS) {
                      finish(echoRound, `${echoRound} rounds — perfect echo!`);
                      return;
                    }
                    echoSeq.push(Math.floor(Math.random() * LANTERNS));
                    echoPhase = "show";
                    echoShowIdx = -1;
                    echoShowT = 0.9;
                    lanterns.forEach((x) => (x.inside = true));
                  }
                } else {
                  api.onCue?.("bad");
                  finish(echoRound, `${echoRound} round${echoRound === 1 ? "" : "s"} echoed`);
                  return;
                }
              }
            }
            hud = `Lantern Echo — repeat the sequence (${echoInput}/${echoSeq.length}) · round ${echoRound + 1}`;
          }
          break;
        }
      }
    },
  };

  function finish(score: number, detail: string) {
    const key = active!;
    // Hide per-game props.
    if (key === "mole-meadow") {
      for (const m of moles) {
        m.up = false;
        m.body.visible = false;
      }
    } else if (key === "crystal-climb") {
      beacons.forEach((b) => (b.visible = false));
    } else if (key === "shrine-dive") {
      for (const r of diveRings) r.mesh.visible = false;
      diveTargetDisc.visible = false;
    } else if (key === "lantern-echo") {
      lanterns.forEach((l) => (l.orbMat.emissiveIntensity = 0.25));
    }
    active = null;
    hud = null;
    api.onEnd?.({ key, name: GAME_META[key].name, score, detail });
  }

  return api;
}
