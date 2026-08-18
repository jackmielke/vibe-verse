/**
 * Below the surface.
 *
 * The sea had a top and no inside. You could swim on it, and the moment your
 * eyes went under, the world simply carried on being the world: the same fog,
 * the same sky, the same flat blue sheet now seen from a side it was never
 * drawn for. This is the other half — the part you get to by aiming the camera
 * down and swimming.
 *
 * Four things carry it, and they are deliberately all cheap, because the whole
 * point is that it costs nothing until somebody's head goes under:
 *
 *  - **The atmosphere.** Water is not air with a blue filter: sight lines
 *    collapse from a kilometre to about thirty metres, everything warm in the
 *    spectrum is gone within a few metres of depth, and the light comes from
 *    directly above rather than from a sun you can point at. Fog does most of
 *    that work, and it is the single biggest reason a scene reads as underwater
 *    rather than as tinted.
 *  - **Caustics.** The moving web of light on the seabed. Patched into the sand
 *    material rather than projected, so it costs one texture-free function in a
 *    shader that was already running.
 *  - **Shafts.** Light coming down in blades, following the sun's bearing.
 *    Additive planes that travel with the swimmer, the same trick the rain
 *    uses: a few of them everywhere you look beats a thousand of them
 *    somewhere you are not.
 *  - **Fish.** Nothing says "this is a place" like something living in it. A
 *    few schools, each wandering its own slow circuit, banking into turns.
 *
 * What is deliberately NOT here: a drowning meter. This world does not kill
 * you for being curious.
 */
import * as THREE from "three";
import { softDot } from "@/city/softDot";

/** How far you can see down here. Air is 1100 m; this is the whole point. */
const FOG_NEAR = 0.5;
const FOG_FAR = 42;
/** The colour everything tends toward with depth. */
const DEEP = new THREE.Color("#06212e");
const SHALLOW = new THREE.Color("#1d6f7d");
/** Past the shallows: what eighty metres of water looks like. */
const ABYSS = new THREE.Color("#020c14");

export interface UnderwaterTargets {
  scene: THREE.Scene;
  fog: THREE.Fog;
  ambient: THREE.Light;
  hemi: THREE.HemisphereLight;
  /**
   * The key light. Water eats it — that is most of why the seabed reads as
   * being underwater rather than as a beach in bright sun with a blue filter
   * over it — so it gets turned down with depth like everything else.
   */
  sun: THREE.Light;
  sunDir: THREE.Vector3;
  /**
   * Put the surface world back. Called once on the way out rather than every
   * frame: the day/night switch owns those handles and re-deriving them from
   * scratch is its job, not this module's.
   */
  restore(): void;
}

/** Fold `v` into [-size/2, size/2). Used to tile things around the swimmer. */
export function wrapBox(v: number, size: number): number {
  const h = size / 2;
  return ((((v + h) % size) + size) % size) - h;
}

export interface Underwater {
  group: THREE.Group;
  /** Materials that should catch caustics — the seabed, mostly. */
  patch(material: THREE.Material | THREE.Material[] | null | undefined): void;
  /**
   * Drive it. `depth` is how far the CAMERA is below the surface, or a value
   * <= 0 when it is above. Everything else follows from that one number.
   */
  update(dt: number, timeSec: number, depth: number, eye: THREE.Vector3): void;
  /** True while the camera is under. */
  submerged(): boolean;
  dispose(): void;
}

/**
 * The caustic web.
 *
 * Two ridged lattices multiplied and sharpened. Not a physical simulation of
 * anything — real caustics are the sea surface acting as a lens, which is a
 * render-to-texture and a second pass — but the eye is looking for a moving
 * net of bright lines that never quite repeats, and two incommensurate
 * lattices give exactly that for about a dozen instructions.
 */
const CAUSTIC_GLSL = /* glsl */ `
  float causticLayer(vec2 p, float t){
    float a = sin(p.x + t) + sin(p.y * 1.17 - t * 0.8);
    float b = sin((p.x + p.y) * 0.71 + t * 1.3);
    return 1.0 - abs(a * 0.5 + b * 0.35) * 0.8;
  }
  float causticWeb(vec2 p, float t){
    // The second lattice is ROTATED, not just scaled. Scaled alone, both
    // layers run their bands in the same direction and multiplying them gives
    // long parallel ribbons crawling across the sand — pretty, and nothing
    // like caustics, which are a net. Two thirds of a radian is enough for the
    // crossings to read as cells.
    const mat2 turn = mat2(0.78, -0.63, 0.63, 0.78);
    float c = causticLayer(p * 0.9, t) * causticLayer(turn * p * 1.63 + 11.0, -t * 0.7);
    return pow(clamp(c, 0.0, 1.0), 5.0);
  }
`;

const CAUSTIC_PARS = /* glsl */ `
  uniform float uCausticAmt;
  uniform float uCausticTime;
  varying vec3 uwWorld;
  varying float uwUp;
`;

export function createUnderwater(targets: UnderwaterTargets): Underwater {
  const group = new THREE.Group();
  group.visible = false;
  const trash: Array<{ dispose(): void }> = [];

  const causticAmt = { value: 0 };
  const causticTime = { value: 0 };
  const patched = new WeakSet<THREE.Material>();

  const patchOne = (mat: THREE.Material) => {
    if (patched.has(mat)) return;
    /**
     * Only materials whose shader actually has a normal.
     *
     * The vertex injection reads `objectNormal`, which exists in the lit
     * material chunks and nowhere else. Sprites and points compile a
     * completely different vertex shader — `<begin_vertex>` is there, the
     * normal is not — so patching one is not a no-op, it is a shader that
     * fails to link, and a failed link in three is a silent black object.
     * This guard is what makes `patch()` safe to point at a whole subtree
     * without first knowing what is in it.
     */
    const lit = mat as unknown as Record<string, boolean>;
    if (
      !lit.isMeshStandardMaterial &&
      !lit.isMeshPhysicalMaterial &&
      !lit.isMeshPhongMaterial &&
      !lit.isMeshLambertMaterial
    ) {
      return;
    }
    patched.add(mat);
    const prev = mat.onBeforeCompile?.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      // Chained, not replaced: the seabed already carries the snow patch, and
      // whichever of the two is applied second would otherwise drop the first.
      prev?.(shader, renderer);
      shader.uniforms.uCausticAmt = causticAmt;
      shader.uniforms.uCausticTime = causticTime;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `${CAUSTIC_PARS}\nvoid main() {`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          mat4 uwModel = modelMatrix;
          #ifdef USE_INSTANCING
            uwModel = modelMatrix * instanceMatrix;
          #endif
          uwWorld = (uwModel * vec4(transformed, 1.0)).xyz;
          uwUp = normalize(mat3(uwModel) * objectNormal).y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("void main() {", `${CAUSTIC_PARS}\n${CAUSTIC_GLSL}\nvoid main() {`)
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (uCausticAmt > 0.001 && uwWorld.y < 0.0) {
            // Brightest just under the surface and thinning with depth — but
            // slowly. The first cut faded them out by fifteen metres, and the
            // bay is twelve deep, so the seabed you actually swim down to was
            // getting seven percent of the effect: a flat blue plane with the
            // caustics technically present and invisible. In clear water you
            // can see the web on the bottom a long way further down than that.
            float depthFade = 1.0 - smoothstep(2.0, 34.0, -uwWorld.y);
            float lit = smoothstep(0.15, 0.75, uwUp);
            float web = causticWeb(uwWorld.xz * 0.55, uCausticTime);
            diffuseColor.rgb += vec3(0.50, 0.95, 0.92) * web * depthFade * lit * uCausticAmt;
          }`,
        );
    };
    mat.needsUpdate = true;
  };

  // ---- Shafts ----------------------------------------------------------
  /**
   * Light coming down in blades.
   *
   * Long additive quads, spread through a box that travels with the swimmer —
   * the same argument the rain makes: a few of them wherever you are looking
   * beats a thousand of them somewhere you are not. Each is yawed to the sun's
   * bearing and tipped slightly, so they all lean the same way and read as one
   * light source rather than as decoration.
   */
  const SHAFTS = 16;
  const shaftTex = (() => {
    /**
     * Soft ACROSS as well as along.
     *
     * The first cut was an 8-pixel strip carrying only a vertical gradient, so
     * every shaft had two perfectly straight vertical edges where it met the
     * water. Additive blending does not hide that — it emphasises it — and
     * sixteen of them came out looking like sheets of white paper standing in
     * the sea. A beam of light has no edge; it has a middle. The horizontal
     * falloff is the entire difference between the two readings and it costs
     * one multiply in a 64x128 canvas built once.
     */
    const W = 64;
    const H = 128;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      // Down the beam: brightest just under the surface, gone by the bottom.
      const along = Math.pow(1 - v, 1.9) * (0.35 + 0.65 * Math.pow(1 - v, 0.35));
      for (let x = 0; x < W; x++) {
        const u = (x / (W - 1)) * 2 - 1; // -1..1 across
        const across = Math.pow(Math.max(0, 1 - u * u), 2.2);
        const a = along * across;
        const o = (y * W + x) * 4;
        img.data[o] = 235;
        img.data[o + 1] = 252;
        img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const shaftMat = new THREE.MeshBasicMaterial({
    map: shaftTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const shaftGeo = new THREE.PlaneGeometry(1, 1);
  shaftGeo.translate(0, -0.5, 0); // hangs DOWN from the surface
  const shafts = new THREE.InstancedMesh(shaftGeo, shaftMat, SHAFTS);
  shafts.frustumCulled = false;
  shafts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(shafts);
  const shaftSeed = Array.from({ length: SHAFTS }, () => ({
    x: (Math.random() - 0.5) * 46,
    z: (Math.random() - 0.5) * 46,
    w: 1.1 + Math.random() * 3.4,
    len: 16 + Math.random() * 26,
    phase: Math.random() * Math.PI * 2,
  }));
  trash.push(shaftGeo, shaftMat, shaftTex);

  // ---- Motes -----------------------------------------------------------
  // The stuff in the water. Nothing sells depth like something out of focus
  // drifting between you and the thing you are looking at.
  const MOTES = 420;
  const motePos = new Float32Array(MOTES * 3);
  const moteDrift = new Float32Array(MOTES * 3);
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (Math.random() - 0.5) * 26;
    motePos[i * 3 + 1] = (Math.random() - 0.5) * 18;
    motePos[i * 3 + 2] = (Math.random() - 0.5) * 26;
    moteDrift[i * 3] = (Math.random() - 0.5) * 0.25;
    moteDrift[i * 3 + 1] = -0.05 - Math.random() * 0.12;
    moteDrift[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  /**
   * Round, and only round because it is textured.
   *
   * `fog: false` keeps the snow visible at any depth, which is right — it is
   * the thing between you and everything else, and fogging it out defeats the
   * point. But it also means these are the only pixels in the abyss the
   * darkness does not touch, so their SHAPE is load-bearing down there: as
   * untextured points they were crisp pale squares scattered over a black
   * frame and read as rendering artefacts, not as silt.
   */
  const moteTex = softDot();
  const moteMat = new THREE.PointsMaterial({
    color: "#cdf3ff",
    size: 0.11,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    ...(moteTex ? { map: moteTex } : {}),
  });
  if (moteTex) trash.push(moteTex);
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  group.add(motes);
  trash.push(moteGeo, moteMat);

  // ---- Fish ------------------------------------------------------------
  /**
   * Three schools, each on its own slow circuit, each fish holding a place in
   * the formation with a little wander of its own.
   *
   * Instance matrices are rebuilt on the CPU. Sixty composes a frame is
   * nothing, and it buys banking into the turns — which is the single thing
   * that separates a school of fish from a cloud of triangles.
   */
  const SCHOOLS = 3;
  const PER_SCHOOL = 22;
  const FISH = SCHOOLS * PER_SCHOOL;
  const fishGeo = (() => {
    // A flattened octahedron for the body and a fin behind it. Two shapes,
    // eight triangles, and it reads as a fish at every distance you will see
    // one from down here.
    const body = new THREE.OctahedronGeometry(0.5, 0);
    body.scale(1.7, 0.62, 0.42);
    const tail = new THREE.ConeGeometry(0.3, 0.5, 3);
    tail.rotateZ(Math.PI / 2);
    tail.translate(-1.0, 0, 0);
    tail.scale(1, 1.5, 0.35);
    return { body, tail };
  })();
  const fishMat = new THREE.MeshStandardMaterial({
    color: "#8fd8e8",
    roughness: 0.42,
    metalness: 0.25,
    emissive: "#0d3b47",
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0,
  });
  const fishBody = new THREE.InstancedMesh(fishGeo.body, fishMat, FISH);
  const fishTail = new THREE.InstancedMesh(fishGeo.tail, fishMat, FISH);
  for (const m of [fishBody, fishTail]) {
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  trash.push(fishGeo.body, fishGeo.tail, fishMat);

  const school = Array.from({ length: SCHOOLS }, (_, s) => ({
    // Each circuit is a slow ellipse at its own radius, depth and rate.
    radius: 14 + s * 9,
    depth: -4 - s * 3.5,
    rate: 0.055 + s * 0.018,
    phase: (s / SCHOOLS) * Math.PI * 2,
    scale: 0.5 + s * 0.22,
  }));
  const fishSeed = Array.from({ length: FISH }, (_, i) => ({
    school: Math.floor(i / PER_SCHOOL),
    // Place in the formation, in the school's own frame.
    ox: (Math.random() - 0.5) * 7,
    oy: (Math.random() - 0.5) * 2.6,
    oz: (Math.random() - 0.5) * 5,
    wob: Math.random() * Math.PI * 2,
    speed: 0.8 + Math.random() * 0.6,
  }));

  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();
  const E = new THREE.Euler();
  const anchor = new THREE.Vector3();

  let depthEased = 0;
  let wasUnder = false;

  /**
   * The surface world's atmosphere, captured the frame we go under.
   *
   * The blend has to be a function of DEPTH — at half a metre down you should
   * be half underwater — and that needs both ends of it. Lerping each handle
   * from its own current value toward the underwater target instead looks like
   * the same thing and is not: it converges over frames no matter how shallow
   * you are, so the colours arrive at full underwater within a second of your
   * chin getting wet while the fog is still honest, and the waterline stops
   * being a crossing and becomes a switch.
   *
   * Only the colours and intensities are captured. Fog near/far are rewritten
   * from the camera zoom every frame by the caller, so they are read live.
   */
  const surface = {
    fogNear: 0,
    fogFar: 0,
    fogColor: new THREE.Color(),
    background: new THREE.Color(),
    ambient: new THREE.Color(),
    ambientI: 0,
    hemi: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiI: 0,
    sun: new THREE.Color(),
    sunI: 0,
  };
  const AMBIENT_UW = new THREE.Color("#9fe6ff");
  const HEMI_UW = new THREE.Color("#a8f0ff");
  const tint = new THREE.Color();
  const scratch = new THREE.Color();

  return {
    group,
    patch(material) {
      if (!material) return;
      if (Array.isArray(material)) material.forEach(patchOne);
      else patchOne(material);
    },
    submerged: () => depthEased > 0.02,
    update(dt, timeSec, depth, eye) {
      // Eased, so breaking the surface in a swell does not strobe the whole
      // atmosphere on and off with every wave.
      const target = Math.max(0, depth);
      depthEased += (target - depthEased) * (1 - Math.pow(0.0005, dt));
      const k = Math.min(1, depthEased / 2.5); // 0 at the surface, 1 by 2.5 m

      group.visible = depthEased > 0.02;
      if (!group.visible) {
        if (wasUnder) {
          targets.restore();
          wasUnder = false;
          causticAmt.value = 0;
        }
        return;
      }
      const { fog, scene, ambient, hemi, sun } = targets;
      if (!wasUnder) {
        // First frame under. Everything is still the surface world's, so this
        // is the only moment it can be read.
        surface.fogColor.copy(fog.color);
        surface.background.copy(scene.background as THREE.Color);
        surface.ambient.copy(ambient.color);
        surface.ambientI = ambient.intensity;
        surface.hemi.copy(hemi.color);
        surface.hemiGround.copy(hemi.groundColor);
        surface.hemiI = hemi.intensity;
        surface.sun.copy(sun.color);
        surface.sunI = sun.intensity;
      }
      surface.fogNear = fog.near;
      surface.fogFar = fog.far;
      wasUnder = true;
      causticTime.value = timeSec * 0.55;
      // Caustics are cast by the surface, so they are strongest seen from just
      // under it and irrelevant from the air.
      causticAmt.value = 0.9 * Math.min(1, depthEased / 1.2);

      // ---- Atmosphere ----------------------------------------------------
      // Colour with depth: green-blue in the shallows, going to almost black
      // by the time there is eighteen metres of water over your head.
      tint.copy(SHALLOW).lerp(DEEP, Math.min(1, depthEased / 18));
      /**
       * And keeps going past the point the shallows stop at.
       *
       * `DEEP` is the colour of twelve metres of bay, which is as deep as this
       * world went when it was written. Eighty metres down a trench it is
       * still far too blue and far too bright — so below eighteen metres the
       * tint keeps sliding toward black and the sight line keeps closing. That
       * falloff is doing the same job the dark does in a cave: it is what makes
       * a big empty volume feel like it has something in it you have not seen
       * yet.
       *
       * It closed to THIRTEEN metres first, and thirteen metres is smaller than
       * the room. The trench is thirty-two across and the camera rides five
       * behind you, so the walls, the floor, the vent and every polyp on them
       * were past the fog's far plane the whole way down: the abyss rendered as
       * a black rectangle with a silhouette in it, and it read as a missing
       * texture rather than as darkness. Thirty is still a short sight line —
       * the far wall of the shaft still fades out, which is the point — but it
       * is longer than the thing you are standing in — thirty-two metres across
       * at the floor of the trench, which is where the number below comes
       * from, and a test asserts the two stay in that order.
       */
      const abyss = THREE.MathUtils.clamp((depthEased - 18) / 55, 0, 1);
      tint.lerp(ABYSS, abyss);
      fog.color.copy(surface.fogColor).lerp(tint, k);
      fog.near = THREE.MathUtils.lerp(surface.fogNear, FOG_NEAR, k);
      fog.far = THREE.MathUtils.lerp(
        surface.fogFar,
        THREE.MathUtils.lerp(FOG_FAR, 34, abyss),
        k,
      );
      (scene.background as THREE.Color).copy(surface.background).lerp(tint, k);
      scratch.copy(tint).lerp(AMBIENT_UW, 0.5);
      ambient.color.copy(surface.ambient).lerp(scratch, k);
      ambient.intensity = THREE.MathUtils.lerp(surface.ambientI, 0.42, k);
      hemi.color.copy(surface.hemi).lerp(HEMI_UW, k);
      hemi.groundColor.copy(surface.hemiGround).lerp(DEEP, k);
      hemi.intensity = THREE.MathUtils.lerp(surface.hemiI, 0.85, k);
      /**
       * The key light, absorbed.
       *
       * Left alone, the sun goes on hitting the seabed at full daylight
       * strength and the sand comes back a flat pale sheet with the caustics
       * technically drawn on it and completely invisible — a lit beach with a
       * blue background, which is what "underwater" looks like when only the
       * fog was changed. Water removes the warm end first, so it goes cyan on
       * the way down as well as dim, and it keeps falling with depth rather
       * than settling: at thirty metres there is very little left.
       */
      const absorbed = 1 / (1 + depthEased * 0.16);
      sun.color.copy(surface.sun).lerp(HEMI_UW, k * 0.75);
      sun.intensity = THREE.MathUtils.lerp(surface.sunI, surface.sunI * 0.5 * absorbed, k);

      const fade = Math.min(1, depthEased / 1.5);

      // ---- Shafts --------------------------------------------------------
      shaftMat.opacity = 0.5 * fade * (1 - Math.min(1, depthEased / 34));
      // Yawed to the sun's bearing so every blade leans the same way.
      const sunYaw = Math.atan2(targets.sunDir.x, targets.sunDir.z);
      for (let i = 0; i < SHAFTS; i++) {
        const s = shaftSeed[i];
        const sway = Math.sin(timeSec * 0.32 + s.phase) * 1.6;
        // Wrapped around the swimmer, so a shaft never runs out behind you.
        //
        // Note what is wrapped: the shaft's WORLD anchor is fixed and the
        // OFFSET from the eye is folded back into the box. Placing it at a
        // constant offset instead is the obvious version and it is wrong —
        // every blade then travels with the camera at exactly your speed, the
        // parallax against the seabed goes to zero, and sixteen shafts read as
        // sixteen decals stuck to the lens. Which is the tell that separates a
        // volume of light from a texture of one.
        const x = eye.x + wrapBox(s.x + sway - eye.x, 46);
        const z = eye.z + wrapBox(s.z - eye.z, 46);
        E.set(0.22, sunYaw, 0, "YXZ");
        Q.setFromEuler(E);
        P.set(x, 0.2, z);
        S.set(s.w * (0.85 + 0.3 * Math.sin(timeSec * 0.5 + s.phase)), s.len, 1);
        shafts.setMatrixAt(i, M.compose(P, Q, S));
      }
      shafts.instanceMatrix.needsUpdate = true;

      // ---- Motes ---------------------------------------------------------
      moteMat.opacity = 0.55 * fade;
      for (let i = 0; i < MOTES; i++) {
        let x = motePos[i * 3] + moteDrift[i * 3] * dt;
        let y = motePos[i * 3 + 1] + moteDrift[i * 3 + 1] * dt;
        let z = motePos[i * 3 + 2] + moteDrift[i * 3 + 2] * dt;
        // Kept in a box around the eye — the box is the trick, not the count.
        if (x - eye.x > 13) x -= 26; else if (x - eye.x < -13) x += 26;
        if (y - eye.y > 9) y -= 18; else if (y - eye.y < -9) y += 18;
        if (z - eye.z > 13) z -= 26; else if (z - eye.z < -13) z += 26;
        motePos[i * 3] = x;
        motePos[i * 3 + 1] = y;
        motePos[i * 3 + 2] = z;
      }
      (moteGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

      // ---- Fish ----------------------------------------------------------
      fishMat.opacity = fade;
      for (let i = 0; i < FISH; i++) {
        const f = fishSeed[i];
        const sc = school[f.school];
        const a = timeSec * sc.rate * Math.PI * 2 + sc.phase;
        // The school's own slow circuit, anchored near the swimmer so there is
        // always something to see without simulating an ocean of fish.
        anchor.set(
          eye.x + Math.cos(a) * sc.radius,
          sc.depth + Math.sin(a * 1.7) * 1.4,
          eye.z + Math.sin(a) * sc.radius,
        );
        // Heading is the tangent of the circuit; banking follows the turn.
        const heading = a + Math.PI / 2;
        const wob = Math.sin(timeSec * 2.2 * f.speed + f.wob);
        P.set(
          anchor.x + Math.cos(heading) * f.oz - Math.sin(heading) * f.ox,
          anchor.y + f.oy + wob * 0.22,
          anchor.z + Math.sin(heading) * f.oz + Math.cos(heading) * f.ox,
        );
        E.set(0, heading + wob * 0.16, -0.35);
        Q.setFromEuler(E);
        const sz = sc.scale * (0.8 + 0.4 * ((i * 37) % 10) / 10);
        S.setScalar(sz);
        fishBody.setMatrixAt(i, M.compose(P, Q, S));
        // The tail is a second instance sharing the body's transform, yawed by
        // its own beat. One extra draw call for a whole school that swims.
        E.set(0, heading + wob * 0.55, -0.35);
        Q.setFromEuler(E);
        fishTail.setMatrixAt(i, M.compose(P, Q, S));
      }
      fishBody.instanceMatrix.needsUpdate = true;
      fishTail.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
