/**
 * San Palmas — sky, sun and atmosphere.
 *
 * Publishes SkyService: sun direction/colour and a day/night cycle.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import * as THREE from "three";
import type { SkyService, System, SystemFactory } from "../types";

const createSky: SystemFactory = (ctx) => {
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b4a, 1.1);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.position.set(400, 700, 260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 2200;
  const c = sun.shadow.camera as THREE.OrthographicCamera;
  c.left = -420; c.right = 420; c.top = 420; c.bottom = -420;
  c.updateProjectionMatrix();
  ctx.scene.add(hemi, sun, sun.target);
  ctx.scene.background = new THREE.Color(0x8fd0e8);
  ctx.scene.fog = new THREE.Fog(0x9fd6ea, 500, 4200);

  const service: SkyService = {
    time: 0.42,
    sunDirection: sun.position.clone().normalize(),
    sunColor: new THREE.Color(0xfff3e0),
    daylight: 1,
    setTime(t) { this.time = t; },
  };
  ctx.services.sky = service;

  const sys: System = {
    name: "sky",
    update() {
      // Keep the shadow frustum centred on the player.
      const p = ctx.services.player?.position ?? ctx.camera.position;
      sun.position.set(p.x + 400, p.y + 700, p.z + 260);
      sun.target.position.set(p.x, p.y, p.z);
      sun.target.updateMatrixWorld();
    },
    dispose() { sun.dispose(); hemi.dispose(); },
  };
  return sys;
};

export default createSky;
