import * as THREE from "three";
import type { SoundBus } from "../ModuleTypes";

/**
 * Fully procedural audio. There are no sound files in this project — every
 * gunshot, jet pass and wave is synthesised in the WebAudio graph at runtime.
 *
 * Signal path:
 *   source -> [per-voice filter/shaper] -> panner -> bus gain -> master
 *                                                       \-> convolver (space)
 *
 * The impulse response for the reverb is generated as decaying noise, tuned to
 * "open water with a distant shoreline" — long, dark, and diffuse.
 */

type BusName = "sfx" | "weapon" | "ambient" | "music" | "ui";

export class AudioEngine implements SoundBus {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = new Map<BusName, GainNode>();
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private listener = new THREE.Vector3();
  private forward = new THREE.Vector3(0, 0, -1);
  private noiseBuffer!: AudioBuffer;
  private started = false;
  private musicNodes: AudioNode[] = [];
  private currentMusic: string | null = null;

  masterVolume = 0.8;
  musicVolume = 0.5;

  /**
   * Browsers require a user gesture. Call from the first click/keypress —
   * calling it twice is harmless.
   */
  start(): void {
    if (this.started) return;
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    } catch {
      return; // no audio available — the game still plays
    }
    const ctx = this.ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // Gentle bus compression so a firefight never clips the mix.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    this.master.connect(comp);
    comp.connect(ctx.destination);

    for (const name of ["sfx", "weapon", "ambient", "music", "ui"] as BusName[]) {
      const g = ctx.createGain();
      g.gain.value = name === "music" ? this.musicVolume : 1;
      g.connect(this.master);
      this.buses.set(name, g);
    }

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.8, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.16;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

    this.noiseBuffer = this.makeNoise(2.0);
    this.startAmbience();
  }

  /** Exponentially decaying stereo noise — a cheap, convincing open-air tail. */
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Slight inter-channel decorrelation widens the tail.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (ch === 0 ? 1 : 0.92);
      }
    }
    return buf;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setListener(position: THREE.Vector3, forward: THREE.Vector3): void {
    this.listener.copy(position);
    this.forward.copy(forward);
    const ctx = this.ctx;
    if (!ctx?.listener) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = position.x;
      l.positionY.value = position.y;
      l.positionZ.value = position.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      // Safari still ships the deprecated setter API.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
        position.x,
        position.y,
        position.z,
      );
      (
        l as unknown as { setOrientation(...a: number[]): void }
      ).setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  private panner(position?: THREE.Vector3): AudioNode {
    const ctx = this.ctx!;
    if (!position) {
      const g = ctx.createGain();
      return g;
    }
    const p = ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 6;
    p.maxDistance = 900;
    p.rolloffFactor = 1.3;
    p.positionX.value = position.x;
    p.positionY.value = position.y;
    p.positionZ.value = position.z;
    return p;
  }

  private connect(node: AudioNode, bus: BusName, position?: THREE.Vector3, reverbAmount = 1): AudioNode {
    const pan = this.panner(position);
    node.connect(pan);
    pan.connect(this.buses.get(bus)!);
    if (reverbAmount > 0) {
      const send = this.ctx!.createGain();
      send.gain.value = reverbAmount;
      pan.connect(send);
      send.connect(this.reverbSend);
    }
    return pan;
  }

  private noiseSource(duration: number, playbackRate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start();
    src.stop(ctx.currentTime + duration);
    return src;
  }

  // ---------------------------------------------------------------- voices --

  /**
   * A gunshot is three layers: a click transient, a filtered noise body whose
   * cutoff sweeps down (the crack), and a low sine thump (the punch).
   */
  private gunshot(position: THREE.Vector3 | undefined, opts: { punch: number; crack: number; pitch: number; tail: number }): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const body = this.noiseSource(opts.tail, 1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(3400 * opts.pitch, t);
    bp.frequency.exponentialRampToValueAtTime(420 * opts.pitch, t + opts.tail);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(opts.crack, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + opts.tail);

    body.connect(bp);
    bp.connect(bodyGain);
    this.connect(bodyGain, "weapon", position, 0.5);

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(150 * opts.pitch, t);
    thump.frequency.exponentialRampToValueAtTime(48 * opts.pitch, t + 0.11);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(opts.punch, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    thump.connect(thumpGain);
    this.connect(thumpGain, "weapon", position, 0.2);
    thump.start(t);
    thump.stop(t + 0.2);
  }

  /** Descending FM squeal — Covenant plasma. */
  private plasma(position: THREE.Vector3 | undefined, pitch = 1): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const carrier = ctx.createOscillator();
    carrier.type = "sawtooth";
    carrier.frequency.setValueAtTime(1250 * pitch, t);
    carrier.frequency.exponentialRampToValueAtTime(300 * pitch, t + 0.24);

    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = 82 * pitch;
    const modGain = ctx.createGain();
    modGain.gain.value = 420;
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.26);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    carrier.connect(lp);
    lp.connect(g);
    this.connect(g, "weapon", position, 0.7);

    carrier.start(t);
    mod.start(t);
    carrier.stop(t + 0.3);
    mod.stop(t + 0.3);
  }

  private explosion(position: THREE.Vector3 | undefined, size = 1): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 1.6 * size;

    const n = this.noiseSource(dur, 0.55);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85 * size, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(lp);
    lp.connect(g);
    this.connect(g, "sfx", position, 1.4);

    // Sub-bass thump you feel more than hear
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(78 * (1 / size), t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 0.6 * size);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.9 * size, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7 * size);
    sub.connect(sg);
    this.connect(sg, "sfx", position, 0.3);
    sub.start(t);
    sub.stop(t + 0.8 * size);
  }

  private impact(position: THREE.Vector3 | undefined, kind: "dirt" | "metal" | "water" | "flesh"): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const cfg = {
      dirt: { freq: 380, q: 1.1, dur: 0.16, gain: 0.22, type: "lowpass" as const },
      metal: { freq: 2900, q: 7, dur: 0.28, gain: 0.24, type: "bandpass" as const },
      water: { freq: 900, q: 0.7, dur: 0.34, gain: 0.2, type: "lowpass" as const },
      flesh: { freq: 240, q: 1.6, dur: 0.13, gain: 0.28, type: "lowpass" as const },
    }[kind];

    const n = this.noiseSource(cfg.dur, 1);
    const f = ctx.createBiquadFilter();
    f.type = cfg.type;
    f.frequency.value = cfg.freq;
    f.Q.value = cfg.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(cfg.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur);
    n.connect(f);
    f.connect(g);
    this.connect(g, "sfx", position, 0.6);
  }

  private ui(kind: "click" | "confirm" | "deny"): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const g = ctx.createGain();
    const freq = { click: 880, confirm: 1320, deny: 220 }[kind];
    osc.frequency.setValueAtTime(freq, t);
    if (kind === "confirm") osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.09);
    if (kind === "deny") osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.14);
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g);
    g.connect(this.buses.get("ui")!);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Continuous lake + wind bed, started once and left running. */
  private startAmbience(): void {
    const ctx = this.ctx!;
    const amb = this.buses.get("ambient")!;

    // Water lapping: pink-ish noise through a slowly wandering lowpass.
    const water = ctx.createBufferSource();
    water.buffer = this.noiseBuffer;
    water.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = "lowpass";
    wf.frequency.value = 620;
    wf.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.055;

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(wf.frequency);

    water.connect(wf);
    wf.connect(wg);
    wg.connect(amb);
    water.start();
    lfo.start();

    // Wind: a second, darker noise layer with an independent slow swell.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    wind.playbackRate.value = 0.35;
    const windF = ctx.createBiquadFilter();
    windF.type = "bandpass";
    windF.frequency.value = 320;
    windF.Q.value = 0.5;
    const windG = ctx.createGain();
    windG.gain.value = 0.03;
    const windLfo = ctx.createOscillator();
    windLfo.type = "sine";
    windLfo.frequency.value = 0.061;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.022;
    windLfo.connect(windLfoGain);
    windLfoGain.connect(windG.gain);

    wind.connect(windF);
    windF.connect(windG);
    windG.connect(amb);
    wind.start();
    windLfo.start();
  }

  // ------------------------------------------------------------- SoundBus --

  play(id: string, position?: THREE.Vector3, volume = 1, pitch = 1): void {
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") void this.ctx.resume();

    switch (id) {
      case "shot-ar":
        return this.gunshot(position, { punch: 0.5 * volume, crack: 0.42 * volume, pitch: 1.05 * pitch, tail: 0.3 });
      case "shot-br":
        return this.gunshot(position, { punch: 0.55 * volume, crack: 0.46 * volume, pitch: 0.95 * pitch, tail: 0.34 });
      case "shot-sniper":
        return this.gunshot(position, { punch: 1.0 * volume, crack: 0.7 * volume, pitch: 0.62 * pitch, tail: 0.9 });
      case "shot-plasma":
        return this.plasma(position, pitch);
      case "explosion":
        return this.explosion(position, volume);
      case "impact-dirt":
        return this.impact(position, "dirt");
      case "impact-metal":
        return this.impact(position, "metal");
      case "impact-water":
        return this.impact(position, "water");
      case "impact-flesh":
        return this.impact(position, "flesh");
      case "ui-click":
        return this.ui("click");
      case "ui-confirm":
        return this.ui("confirm");
      case "ui-deny":
        return this.ui("deny");
      default:
        return;
    }
  }

  music(id: string | null): void {
    if (!this.ctx || id === this.currentMusic) return;
    this.currentMusic = id;
    this.musicNodes.forEach((n) => {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    });
    this.musicNodes = [];
    if (!id) return;

    const ctx = this.ctx;
    const bus = this.buses.get("music")!;
    const t = ctx.currentTime;

    // A slow modal drone in D dorian — Halo-adjacent without quoting it.
    const roots = id === "combat" ? [73.42, 110, 146.83, 220] : [73.42, 110, 164.81];
    roots.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.value = f;
      // Slight detune per voice keeps the pad from sounding synthetic.
      osc.detune.value = (i - 1) * 4;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.055 / (i + 1), t + 3.5);

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.05 + i * 0.017;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.02 / (i + 1);
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);

      osc.connect(g);
      g.connect(bus);
      osc.start(t);
      lfo.start(t);
      this.musicNodes.push(osc, lfo, g, lfoGain);
    });
  }

  setVolumes(master: number, music: number): void {
    this.masterVolume = master;
    this.musicVolume = music;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05);
    this.buses.get("music")?.gain.setTargetAtTime(music, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    this.music(null);
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

export const audio = new AudioEngine();
