/**
 * THE LONG NIGHT — the thing the city does after dark.
 *
 * The hour is the player's now: six chips and a slider set it, and the sweep
 * runs the shadows round and brings the lamps on as it goes. Which meant that
 * for the first time somebody could choose to be here at two in the morning —
 * and what they found was the same city with the lights off. Every reason to
 * be in this world happens in daylight. The bazaar, the couriers, the races,
 * the crowd on the plaza, the rocket on the horizon: all of it is a thing you
 * look at, and at night you cannot see any of it.
 *
 * So: once the sun is properly down, the city sends up lanterns, and shells
 * burst over the Beacon. It is the most straightforwardly *wholesome* thing
 * that can happen in a techno-optimistic city — a festival is a lot of people
 * deciding together to stand outside and look up — and it is the one kind of
 * spectacle that reads at every distance this world is ever seen from. From
 * the ice, a kilometre and a half down, it is a scatter of warm sparks under
 * a black rock. From the rim it is directly overhead. From the plaza you are
 * standing in it.
 *
 * ## Why there is no simulation in here at all
 *
 * Every lantern and every spark is a **pure function of the clock**. Nothing
 * in this file has state that survives a frame; `update` writes four uniforms
 * and returns. There is no particle pool, no spawn queue, no integration step,
 * and no array that has to be walked sixty times a second.
 *
 * That is not cleverness for its own sake — it falls out of three things this
 * world already demands:
 *
 * - **The day cycle can be scrubbed.** `DAY_SWEEP_RATE` is 0.17 of phase a
 *   second, so a player can go from noon to midnight in three seconds. Any
 *   simulated firework would have to be either warmed up for those three
 *   seconds or popped into existence half-formed. A closed-form one is simply
 *   *correct at whatever time you ask it about*, including a time it has
 *   never been asked about before.
 * - **`update` must not allocate**, and the cheapest way to honour that is to
 *   have nothing to update.
 * - **The whole thing is invisible for two thirds of the day.** A system that
 *   costs nothing while hidden can be switched off with `group.visible` and
 *   genuinely stop costing, rather than continuing to step a thousand
 *   particles nobody is looking at.
 *
 * The price is that the show is on a loop, and a patient person will see it
 * repeat. The loop is 96 seconds and the shells are spread unevenly across
 * it, which is long enough that nobody has ever noticed and short enough that
 * arriving at any moment puts you inside a burst within a few seconds.
 *
 * ## Night is decided from the sun, not from `daylight`
 *
 * `ctx.daylight` is the lamp switch and it is **0.32 at the sunset this world
 * is painted at**. Fading a festival in against it would put fireworks over a
 * city that is still visibly orange, which is not a festival, it is a bug.
 * `ctx.gradeDaylight` is closer but it is a hard 1-or-0 on the sun crossing
 * the horizon, so it would snap.
 *
 * So this reads `ctx.sunDir.y` and fades over the band where the sun is a
 * little under the horizon: nothing at all while any limb of it is up, full
 * strength by the time the blue hour is over. That is the same interval the
 * sky's own blue-hour keyframe covers, arrived at independently, which is the
 * expected outcome — both are answering "when is it actually dark".
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import { ISLAND_Y } from "./config";
import type { BuildContext, FrameContext, System } from "./types";

/* -------------------------------------------------------------------------
 * Tuning
 * ---------------------------------------------------------------------- */

/**
 * The loop, seconds.
 *
 * Everything repeats on this. Long enough not to read as a loop, short enough
 * that arriving at a random moment does not mean waiting for the show.
 */
const PERIOD = 96;

/** Lanterns aloft at once, per tier. */
const LANTERNS = { high: 620, low: 240 } as const;

/** Shells in the sky per loop, and sparks in each. */
const SHELLS = { high: 22, low: 10 } as const;
const SPARKS = { high: 96, low: 44 } as const;

/** Where lanterns are released from: an annulus over the inner city. */
const RELEASE_R0 = 26;
const RELEASE_R1 = 178;

/** How far a lantern climbs before it is lost, and how long it takes. */
const CLIMB = 300;
const CLIMB_TIME = 132;

/** Shells rise to somewhere in this band above the deck. */
const APEX_LO = 150;
const APEX_HI = 340;

/**
 * The palette.
 *
 * Warm for the lanterns — they are paper with a flame in them and there is
 * only one colour that is. The shells get one cool entry among the warm ones,
 * because a sky of nothing but gold reads as a fire rather than a festival.
 */
const LANTERN_TINTS = [0xffc477, 0xffb066, 0xffd9a0, 0xff9d6b, 0xffe7bc] as const;
const SHELL_TINTS = [0xffd27a, 0xff8fa8, 0x9fe0ff, 0xfff2c4, 0xc7a3ff, 0x8affc8] as const;

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

/**
 * A unit quad, built by hand rather than borrowed from `PlaneGeometry`.
 *
 * Disposing a shared geometry frees the GPU buffers its attributes sit in, so
 * two instanced systems sharing one plane means the second one's `dispose`
 * silently deletes the first one's vertices. `weather.ts` learned that and
 * says so; this is the same helper for the same reason, rather than an import
 * of it — a system may not import another system.
 */
function quad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  /* The show is 300 m tall and 400 m across and every vertex of it is computed
     in the vertex shader, so the CPU-side bounds are meaningless. A sphere
     that contains the whole thing keeps the frustum cull honest without
     needing three.js to know where anything is. */
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, ISLAND_Y + 160, 0), 900);
  return g;
}

/**
 * The soft round falloff both populations are drawn with.
 *
 * A hot core that clips to white and a wide, fast-decaying halo. One
 * expression rather than a texture, because there are no image files in this
 * world and a two-term exponential is a better light than any 32-pixel sprite.
 */
const FALLOFF = /* glsl */ `
  // Fed the quad's own corner offset, which runs -0.5..0.5, so the centre is
  // already at zero and there is no uv to unmap.
  float glowAt(vec2 q) {
    float r2 = dot(q, q) * 4.0;
    return exp(-r2 * 3.1) * 0.55 + exp(-r2 * 15.0) * 0.9;
  }
`;

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

export interface FestivalHandle extends System {
  /** 0 by day, 1 once it is properly dark. What the show is scaled by. */
  readonly night: number;
}

export function buildFestival(ctx: BuildContext): FestivalHandle {
  const rng = makeRng(`empyrean-festival:${ctx.seedSalt}`);
  const group = new THREE.Group();
  group.name = "empyrean-festival";
  group.visible = false;

  const nLanterns = LANTERNS[ctx.quality];
  const nShells = SHELLS[ctx.quality];
  const nSparks = SPARKS[ctx.quality];

  /* ---- lanterns -------------------------------------------------------- */

  const lanternGeo = quad();
  {
    const origin = new Float32Array(nLanterns * 3);
    const seed = new Float32Array(nLanterns);
    const size = new Float32Array(nLanterns);
    const release = new Float32Array(nLanterns);
    const tint = new Float32Array(nLanterns * 3);
    const c = new THREE.Color();
    for (let i = 0; i < nLanterns; i++) {
      /* Uniform over the annulus, which needs the square root — without it
         every lantern crowds the middle, and the middle is where the Beacon
         is and where the shells already are. */
      const t = rng.next();
      const r = Math.sqrt(RELEASE_R0 * RELEASE_R0 + t * (RELEASE_R1 * RELEASE_R1 - RELEASE_R0 * RELEASE_R0));
      const a = rng.next() * Math.PI * 2;
      origin[i * 3] = Math.cos(a) * r;
      origin[i * 3 + 1] = ISLAND_Y + 1.4;
      origin[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = rng.next() * 100;
      /* Seven to twelve metres, for a thing that is a metre of paper.
       *
       * Sized honestly the first time — 1.5 to 3 m — and the result was
       * invisible. From the skyline viewpoint, 640 m out, a 3 m quad
       * subtends about three pixels, and three pixels of additive glow at
       * a third of an alpha is nothing at all. What is being drawn here is
       * not the paper, it is the *light coming off it*, and a light has no
       * size of its own: a street lamp is a centimetre of filament and
       * fills a doorway. The falloff does the rest — a wide, fast-decaying
       * halo still reads as a small bright point from ten metres away. */
      size[i] = 7 + rng.next() * 5;
      /* Spread the releases over a whole climb rather than over the loop, so
         the column is evenly populated top to bottom at every moment instead
         of arriving in waves. */
      release[i] = rng.next() * CLIMB_TIME;
      c.setHex(LANTERN_TINTS[(rng.next() * LANTERN_TINTS.length) | 0]);
      tint[i * 3] = c.r;
      tint[i * 3 + 1] = c.g;
      tint[i * 3 + 2] = c.b;
    }
    lanternGeo.setAttribute("aOrigin", new THREE.InstancedBufferAttribute(origin, 3));
    lanternGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    lanternGeo.setAttribute("aSize", new THREE.InstancedBufferAttribute(size, 1));
    lanternGeo.setAttribute("aRelease", new THREE.InstancedBufferAttribute(release, 1));
    lanternGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    lanternGeo.instanceCount = nLanterns;
  }

  const lanternMat = new THREE.ShaderMaterial({
    name: "EmpyreanLanterns",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aOrigin;
      attribute float aSeed;
      attribute float aSize;
      attribute float aRelease;
      attribute vec3 aTint;
      uniform float uTime;
      varying vec3 vTint;
      varying float vAlpha;
      varying vec2 vQuad;

      void main() {
        vQuad = position.xy;
        float t = mod(uTime - aRelease, ${CLIMB_TIME.toFixed(1)});
        float rise = t / ${CLIMB_TIME.toFixed(1)};

        vec3 p = aOrigin;
        p.y += rise * ${CLIMB.toFixed(1)};

        // A lantern is a bag of hot air on a string: it wanders, and it
        // wanders more as it climbs out of the shelter of the towers.
        float sway = 1.6 + rise * 15.0;
        p.x += sin(uTime * 0.21 + aSeed * 7.1) * sway;
        p.z += cos(uTime * 0.17 + aSeed * 5.3) * sway;

        // And it drifts outward, because the air over a warm city goes up in
        // the middle and out at the edges. Without this they rise in a
        // cylinder, which is the one shape hot air never makes.
        vec2 out2 = normalize(aOrigin.xz + vec2(0.0001, 0.0001));
        p.xz += out2 * rise * 46.0;

        // In quickly, out slowly. The fade at the top is the lantern going
        // out, so it wants to be gradual; the fade at the bottom is only
        // hiding the wrap and wants to be over with.
        vAlpha = smoothstep(0.0, 0.035, rise) * (1.0 - smoothstep(0.62, 1.0, rise));

        // The flame is not steady. Two incommensurable sines so it never
        // finds a rhythm.
        float flicker = 0.86 + 0.14 * sin(uTime * 5.3 + aSeed * 31.0)
                             + 0.06 * sin(uTime * 11.7 + aSeed * 12.0);
        vAlpha *= flicker;
        vTint = aTint;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += position.xy * aSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      varying vec3 vTint;
      varying float vAlpha;
      varying vec2 vQuad;
      ${FALLOFF}
      void main() {
        float g = glowAt(vQuad);
        gl_FragColor = vec4(vTint * g, g * vAlpha * uNight);
      }
    `,
  });

  /* ---- shells ---------------------------------------------------------- */

  const shellGeo = quad();
  const nSparkTotal = nShells * nSparks;
  {
    const dir = new Float32Array(nSparkTotal * 3);
    const launch = new Float32Array(nSparkTotal * 3);
    const when = new Float32Array(nSparkTotal);
    const speed = new Float32Array(nSparkTotal);
    const seed = new Float32Array(nSparkTotal);
    const tint = new Float32Array(nSparkTotal * 3);
    const c = new THREE.Color();
    for (let s = 0; s < nShells; s++) {
      /* One shell: a launch point, an apex, a moment and a colour, shared by
         every spark in it. Sparks differ only in which way they go. */
      const a = rng.next() * Math.PI * 2;
      const r = 30 + rng.next() * 150;
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r;
      const apex = ISLAND_Y + APEX_LO + rng.next() * (APEX_HI - APEX_LO);
      /* Unevenly spread across the loop rather than every PERIOD/n seconds.
         Evenly spaced shells read as a metronome, and a metronome is the one
         thing that gives a loop away. */
      const at = (s + rng.next() * 0.9) * (PERIOD / nShells);
      const sp = 44 + rng.next() * 34;
      c.setHex(SHELL_TINTS[(rng.next() * SHELL_TINTS.length) | 0]);
      /* A slightly squashed sphere of directions. A perfect one looks like a
         diagram; real shells are wider than they are tall because the ones
         going straight up are fighting gravity from the first instant. */
      for (let k = 0; k < nSparks; k++) {
        const i = s * nSparks + k;
        const u = rng.next() * 2 - 1;
        const th = rng.next() * Math.PI * 2;
        const sq = Math.sqrt(1 - u * u);
        dir[i * 3] = Math.cos(th) * sq;
        dir[i * 3 + 1] = u * 0.78;
        dir[i * 3 + 2] = Math.sin(th) * sq;
        launch[i * 3] = lx;
        launch[i * 3 + 1] = apex;
        launch[i * 3 + 2] = lz;
        when[i] = at;
        // Not every spark leaves at the same speed, or the shell is a shell.
        speed[i] = sp * (0.55 + rng.next() * 0.65);
        seed[i] = rng.next() * 100;
        tint[i * 3] = c.r;
        tint[i * 3 + 1] = c.g;
        tint[i * 3 + 2] = c.b;
      }
    }
    shellGeo.setAttribute("aDir", new THREE.InstancedBufferAttribute(dir, 3));
    shellGeo.setAttribute("aApex", new THREE.InstancedBufferAttribute(launch, 3));
    shellGeo.setAttribute("aWhen", new THREE.InstancedBufferAttribute(when, 1));
    shellGeo.setAttribute("aSpeed", new THREE.InstancedBufferAttribute(speed, 1));
    shellGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    shellGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    shellGeo.instanceCount = nSparkTotal;
  }

  const shellMat = new THREE.ShaderMaterial({
    name: "EmpyreanShells",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aDir;
      attribute vec3 aApex;
      attribute float aWhen;
      attribute float aSpeed;
      attribute float aSeed;
      attribute vec3 aTint;
      uniform float uTime;
      varying vec3 vTint;
      varying float vAlpha;
      varying vec2 vQuad;

      // Seconds of climb before the burst, and of burn after it.
      const float RISE = 2.6;
      const float BURN = 3.4;
      const float DRAG = 1.45;
      const float G = 7.0;

      void main() {
        vQuad = position.xy;
        float t = mod(uTime - aWhen, ${PERIOD.toFixed(1)});

        // The climb. It starts on the deck under the apex and decelerates
        // into it, which is what a mortar shell does and is also the only way
        // the burst does not look like it happened mid-flight.
        float k = clamp(t / RISE, 0.0, 1.0);
        vec3 from = vec3(aApex.x, ${(ISLAND_Y + 6).toFixed(1)}, aApex.z);
        vec3 climbing = mix(from, aApex, 1.0 - (1.0 - k) * (1.0 - k));

        // The burn. Drag-limited flight from the apex, with gravity taking
        // over as the outward speed dies. The closed form of
        // v' = -DRAG*v is what keeps the sparks from flying off for ever.
        float b = max(t - RISE, 0.0);
        float travel = (1.0 - exp(-b * DRAG)) / DRAG;
        vec3 burst = aApex + aDir * aSpeed * travel - vec3(0.0, 0.5 * G * b * b, 0.0);

        float burst_on = step(RISE, t);
        vec3 p = mix(climbing, burst, burst_on);

        // Before the burst every spark of a shell is at the same point, which
        // is exactly right: that is the rising ember, and it is bright
        // because a hundred quads are stacked on it.
        float rising = 1.0 - burst_on;
        float aliveRise = step(0.0, t) * (1.0 - step(RISE, t)) * (0.25 + 0.5 * k);
        float aliveBurn = burst_on * exp(-b * 1.05) * (1.0 - smoothstep(BURN * 0.7, BURN, b));

        // Sparks twinkle out at slightly different times, which is the whole
        // difference between a firework and a balloon deflating.
        float twinkle = 0.72 + 0.28 * sin(b * 21.0 + aSeed * 44.0);
        vAlpha = aliveRise * rising + aliveBurn * twinkle;

        // The tail cools to red as it dies, the way burning metal does.
        vTint = mix(aTint, vec3(1.0, 0.34, 0.12), burst_on * smoothstep(0.4, BURN, b) * 0.7);

        // Same reasoning as the lanterns: this is the light, not the ember.
        // The rising shell is tighter than the sparks it becomes, and a spark
        // swells as it cools and its trail smears.
        float size = mix(4.2, 7.0 + b * 3.2, burst_on);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      varying vec3 vTint;
      varying float vAlpha;
      varying vec2 vQuad;
      ${FALLOFF}
      void main() {
        float g = glowAt(vQuad);
        gl_FragColor = vec4(vTint * g, g * vAlpha * uNight);
      }
    `,
  });

  const lanterns = new THREE.Mesh(lanternGeo, lanternMat);
  lanterns.name = "empyrean-lanterns";
  lanterns.frustumCulled = false;
  lanterns.renderOrder = 6;
  const shells = new THREE.Mesh(shellGeo, shellMat);
  shells.name = "empyrean-shells";
  shells.frustumCulled = false;
  shells.renderOrder = 6;
  group.add(lanterns, shells);

  let night = 0;

  return {
    name: "festival",
    group,
    get night() {
      return night;
    },
    update(f: FrameContext) {
      /* See the note at the top: the sun's own altitude, not `daylight`,
         which is 0.32 at the sunset this world is painted at and would put
         fireworks over an orange sky. Full strength once the sun is six
         degrees under, which is the end of civil twilight and is when a real
         one would start. */
      const y = f.sunDir.y;
      night = y >= 0.02 ? 0 : Math.min(1, (0.02 - y) / 0.12);

      group.visible = night > 0.003;
      if (!group.visible) return;

      lanternMat.uniforms.uTime.value = f.time;
      lanternMat.uniforms.uNight.value = night;
      shellMat.uniforms.uTime.value = f.time;
      shellMat.uniforms.uNight.value = night;
    },
    dispose() {
      lanternGeo.dispose();
      lanternMat.dispose();
      shellGeo.dispose();
      shellMat.dispose();
      group.clear();
    },
  };
}
