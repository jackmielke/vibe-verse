/**
 * Vibe Golf — WebAudio synthesis. Publishes AudioService2.
 *
 * STUB: placeholder. Replaced by the dedicated module author.
 */
import type { AudioService2, System, SystemFactory } from "../types";

const createAudio: SystemFactory = (ctx) => {
  const service: AudioService2 = { play() {}, music() {} };
  ctx.services.audio = service;
  return { name: "audio" } as System;
};

export default createAudio;
