/**
 * Vibe Golf — scene rendering.
 *
 * Turns the hole's 2D surface data into extruded 2.5D geometry: each ground
 * strip becomes a solid slab with a lit top edge, closed shapes become
 * blocks, and everything sits on the parallax Z stack from `core.ts`. Also
 * owns the ball, the cup and flag, and the aim preview.
 *
 * This is the baseline presentation — good enough to read and play. The
 * art-direction pass deepens it.
 */
import * as THREE from "three";
import type { Course, Hole, Surface, SurfaceMaterial, System, SystemFactory } from "../types";
import { LAYER } from "./core";

/** Base colours per material. The art pass replaces these with real texturing. */
const COLORS: Record<SurfaceMaterial, number> = {
  fairway: 0x4fa83f,
  green: 0x63c94d,
  rough: 0x357a2c,
  sand: 0xe6d29a,
  stone: 0x8d8477,
  metal: 0x9aa4ad,
  wood: 0x9a6b3f,
  ice: 0xbfe9f5,
  rubber: 0xd9456b,
  water: 0x2aa5c9,
  lava: 0xf05a28,
  outOfBounds: 0x333333,
};

/** How far below a ground strip the solid slab extends, metres. */
const SLAB_DEPTH = 26;
const EXTRUDE = 3.2;

const createRender: SystemFactory = (ctx) => {
  const root = new THREE.Group();
  ctx.scene.add(root);

  // --- Lighting -----------------------------------------------------------
  // A key light raking from the upper left plus a cool sky fill; enough to
  // give the extruded edges real form.
  const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
  key.position.set(-40, 70, 90);
  key.castShadow = ctx.quality !== "low";
  if (key.castShadow) {
    key.shadow.mapSize.set(1024, 1024);
    const c = key.shadow.camera as THREE.OrthographicCamera;
    c.left = -60; c.right = 60; c.top = 60; c.bottom = -60;
    c.near = 1; c.far = 400;
    key.shadow.bias = -0.0012;
  }
  const fill = new THREE.HemisphereLight(0xbfe4ff, 0x2b3f22, 1.15);
  ctx.scene.add(key, fill, key.target);

  // --- Sky backdrop -------------------------------------------------------
  // A big gradient quad parked far behind everything; cheap, and it reads as
  // atmosphere rather than a flat clear colour.
  const skyMat = new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x2f7fc4) },
      uMid: { value: new THREE.Color(0x8fd3e8) },
      uBot: { value: new THREE.Color(0xffd9a8) },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform vec3 uTop, uMid, uBot;
      void main(){
        vec3 c = mix(uBot, uMid, smoothstep(0.0, 0.55, vUv.y));
        c = mix(c, uTop, smoothstep(0.45, 1.0, vUv.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  ctx.scene.add(sky);

  // --- Hole geometry ------------------------------------------------------
  let holeGroup: THREE.Group | null = null;

  /** Extrude one surface into a slab and add it to `group`. */
  function buildSurface(s: Surface, group: THREE.Group, floorY: number): void {
    if (s.points.length < 2) return;
    const shape = new THREE.Shape();

    if (s.closed) {
      shape.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) shape.lineTo(s.points[i].x, s.points[i].y);
      shape.closePath();
    } else {
      // Open strip: walk the profile, then close it off downwards into a slab.
      shape.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) shape.lineTo(s.points[i].x, s.points[i].y);
      const last = s.points[s.points.length - 1];
      shape.lineTo(last.x, floorY);
      shape.lineTo(s.points[0].x, floorY);
      shape.closePath();
    }

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: EXTRUDE,
      bevelEnabled: true,
      bevelThickness: 0.14,
      bevelSize: 0.14,
      bevelSegments: 1,
      curveSegments: 1,
    });
    geo.translate(0, 0, -EXTRUDE * 0.5);

    const color = COLORS[s.material] ?? 0x888888;
    const isLiquid = s.material === "water" || s.material === "lava";
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: s.material === "ice" || isLiquid ? 0.16 : s.material === "metal" ? 0.35 : 0.92,
      metalness: s.material === "metal" ? 0.75 : 0.0,
      transparent: isLiquid,
      opacity: isLiquid ? 0.82 : 1,
      emissive: s.material === "lava" ? new THREE.Color(0x7a1d05) : new THREE.Color(0x000000),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = isLiquid ? LAYER.props - 1 : LAYER.course;
    mesh.receiveShadow = ctx.quality !== "low";
    mesh.castShadow = ctx.quality !== "low" && !isLiquid;
    group.add(mesh);

    // A brighter cap along the walkable top edge sells the 2.5D relief.
    if (!s.closed && !isLiquid) {
      const capPts: THREE.Vector3[] = s.points.map((p) => new THREE.Vector3(p.x, p.y, EXTRUDE * 0.5 + 0.02));
      const capGeo = new THREE.BufferGeometry().setFromPoints(capPts);
      const cap = new THREE.Line(
        capGeo,
        new THREE.LineBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45) }),
      );
      cap.position.z = LAYER.props;
      group.add(cap);
    }
  }

  // --- Ball ---------------------------------------------------------------
  const ballGeo = new THREE.SphereGeometry(1, 24, 16);
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.02 });
  const ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = ctx.quality !== "low";
  ballMesh.position.z = LAYER.ball;
  root.add(ballMesh);

  // Extra balls for the multi-ball shot.
  const extraBalls: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(ballGeo, ballMat.clone());
    m.visible = false;
    m.position.z = LAYER.ball;
    root.add(m);
    extraBalls.push(m);
  }

  // --- Cup + flag ---------------------------------------------------------
  const cupGroup = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 4.2, 6),
    new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 }),
  );
  pole.position.y = 2.1;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.9),
    new THREE.MeshStandardMaterial({ color: 0xfb4d5c, side: THREE.DoubleSide, roughness: 0.8 }),
  );
  flag.position.set(0.78, 3.7, 0);
  const cupRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.6, 0.07, 6, 20),
    new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 }),
  );
  cupRim.rotation.x = Math.PI / 2;
  cupGroup.add(pole, flag, cupRim);
  cupGroup.position.z = LAYER.props;
  root.add(cupGroup);

  // --- Aim preview --------------------------------------------------------
  const AIM_DOTS = 26;
  const aimGeo = new THREE.BufferGeometry();
  aimGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(AIM_DOTS * 3), 3));
  const aimDots = new THREE.Points(
    aimGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.28, transparent: true, opacity: 0.85, sizeAttenuation: true }),
  );
  aimDots.visible = false;
  aimDots.position.z = LAYER.fx;
  root.add(aimDots);

  let aimState: { aiming: boolean; power: number; from?: { x: number; y: number }; dir?: { x: number; y: number } } = {
    aiming: false, power: 0,
  };
  const offAim = ctx.on("golf:aim", (p) => {
    aimState = p as typeof aimState;
  });

  const offHole = ctx.on("golf:hole", (payload) => {
    const { hole } = payload as { hole: Hole; course: Course };
    if (holeGroup) {
      root.remove(holeGroup);
      holeGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mm = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) x.dispose();
      });
    }
    holeGroup = new THREE.Group();
    for (const s of hole.surfaces) buildSurface(s, holeGroup, hole.bounds.min.y - SLAB_DEPTH);
    root.add(holeGroup);
    cupGroup.position.x = hole.cup.x;
    cupGroup.position.y = hole.cup.y;
  });

  const sys: System = {
    name: "render",
    lateUpdate(dt) {
      const cam = ctx.camera;
      const phys = ctx.services.physics;

      // Park the sky quad to exactly cover the view.
      const w = (cam.right - cam.left) * 1.05;
      const h = (cam.top - cam.bottom) * 1.05;
      sky.scale.set(w, h, 1);
      sky.position.set(cam.position.x, cam.position.y, LAYER.sky);

      // Keep the shadow frustum on the action.
      key.position.set(cam.position.x - 40, cam.position.y + 70, 90);
      key.target.position.set(cam.position.x, cam.position.y, 0);
      key.target.updateMatrixWorld();

      if (!phys) return;
      const live = phys.balls.filter((b) => b.active);
      const primary = live[0];

      if (primary) {
        ballMesh.visible = true;
        ballMesh.position.set(primary.pos.x, primary.pos.y, LAYER.ball);
        ballMesh.scale.setScalar(primary.radius);
        // Roll the ball by its own spin so it visibly rotates.
        ballMesh.rotation.z -= primary.spin * dt;
      } else {
        ballMesh.visible = false;
      }
      for (let i = 0; i < extraBalls.length; i++) {
        const b = live[i + 1];
        extraBalls[i].visible = Boolean(b);
        if (b) {
          extraBalls[i].position.set(b.pos.x, b.pos.y, LAYER.ball);
          extraBalls[i].scale.setScalar(b.radius);
        }
      }

      // Flag flutter.
      flag.rotation.y = Math.sin(ctx.elapsed * 2.4) * 0.28;

      // Aim preview: integrate the shot forward under gravity so the dots
      // show the real launch arc, not a straight line.
      if (aimState.aiming && aimState.from && aimState.dir && primary) {
        aimDots.visible = true;
        const g = phys.gravity;
        const speed = 6 + aimState.power * 46;
        let px = aimState.from.x;
        let py = aimState.from.y;
        let vx = aimState.dir.x * speed;
        let vy = aimState.dir.y * speed;
        const arr = aimGeo.attributes.position.array as Float32Array;
        const h2 = 0.045;
        for (let i = 0; i < AIM_DOTS; i++) {
          for (let k = 0; k < 3; k++) {
            vx += g.x * h2; vy += g.y * h2;
            px += vx * h2; py += vy * h2;
          }
          arr[i * 3] = px;
          arr[i * 3 + 1] = py;
          arr[i * 3 + 2] = 0;
        }
        aimGeo.attributes.position.needsUpdate = true;
        (aimDots.material as THREE.PointsMaterial).opacity = 0.28 + aimState.power * 0.6;
      } else {
        aimDots.visible = false;
      }
    },
    dispose() {
      offAim();
      offHole();
      ctx.scene.remove(root, sky, key, fill, key.target);
    },
  };

  return sys;
};

export default createRender;
