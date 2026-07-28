/**
 * San Palmas — audio.
 *
 * WebAudio-synthesised weapons, explosions, ambience. Publishes AudioService.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { AudioService, System, SystemFactory } from "../types";

const createAudio: SystemFactory = (ctx) => {
  const service: AudioService = {
    play() {},
    ambience() {},
    setListener() {},
  };
  ctx.services.audio = service;
  const sys: System = { name: "audio" };
  return sys;
};

export default createAudio;
