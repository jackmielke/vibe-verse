/**
 * The post pipeline: render, ambient occlusion, anti-aliasing, output. Owned
 * separately from the world so the look can be tuned without touching the
 * camera or the controls.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface Post {
  composer: EffectComposer;
  setSize(w: number, h: number): void;
  render(): void;
  dispose(): void;
}

export function buildPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: { ssao?: boolean } = {}): Post {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  let ssao: SSAOPass | null = null;
  if (opts.ssao !== false) {
    ssao = new SSAOPass(scene, camera, 1, 1);
    ssao.kernelRadius = 0.9;
    ssao.minDistance = 0.0004;
    ssao.maxDistance = 0.02;
    composer.addPass(ssao);
  }
  const smaa = new SMAAPass(1, 1);
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return {
    composer,
    setSize(w, h) {
      composer.setSize(w, h);
      ssao?.setSize(w, h);
      smaa.setSize(w, h);
    },
    render() {
      composer.render();
    },
    dispose() {
      ssao?.dispose();
      composer.dispose();
    },
  };
}
