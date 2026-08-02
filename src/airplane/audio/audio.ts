/**
 * Everything you hear, synthesised. No files, no fetches, no licences.
 *
 * A four-engine airliner at night is one of the great sounds, and almost all
 * of it is **noise** rather than tone: a JT3D at cruise is a broad hiss with a
 * fan whine sitting on top, and the thing that makes it read as *four* engines
 * is that they are never quite in tune with each other. Two identical
 * oscillators sound like a synthesiser; four detuned ones beating against each
 * other sound like an aeroplane, and the beat frequency changes as you move
 * the levers, which is a detail nobody notices and everybody hears.
 *
 * The other half of the mix is the airflow, which is not the engines at all —
 * it is the boundary layer over the windshield, and it scales with airspeed
 * rather than with thrust. Those two moving independently is why closing the
 * throttles on final sounds like *something happening* rather than like a
 * volume slider.
 *
 * Everything here is guarded: if the audio context cannot be created, or a
 * node type is missing, the flight carries on in silence. Losing the sound
 * should cost you the sound.
 */
import type { AudioService, PlaneCtx, System } from "../types";
import type { AircraftService } from "../play/aircraft";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** White noise, once, looped. Cheaper and calmer than a ScriptProcessor. */
function noiseBuffer(ctx: AudioContext, seconds = 2.5): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Brown-ish noise: integrated white, which has the low-frequency weight a
  // jet's rumble needs. Plain white noise reads as radio static.
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.2 + w * 0.25;
  }
  return buf;
}

interface EngineVoice {
  gain: GainNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  filter: BiquadFilterNode;
}

export function createAudio(ctx: PlaneCtx): System {
  const AC =
    typeof window !== "undefined"
      ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AC) {
    ctx.services.audio = silentService();
    return {};
  }

  let ac: AudioContext;
  try {
    ac = new AC();
  } catch {
    ctx.services.audio = silentService();
    return {};
  }

  const master = ac.createGain();
  master.gain.value = 0.55;
  master.connect(ac.destination);

  // A gentle limiter, so a lightning crack under a full-power engine mix does
  // not clip the whole bus into a click.
  let out: AudioNode = master;
  try {
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.disconnect();
    master.connect(comp);
    comp.connect(ac.destination);
    out = master;
  } catch {
    /* no compressor here; the raw bus will do */
  }

  const noise = noiseBuffer(ac);

  // --- the four engines ----------------------------------------------------
  const engines: EngineVoice[] = [];
  const sources: AudioBufferSourceNode[] = [];
  for (let i = 0; i < 4; i++) {
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    // Each engine reads the loop at a slightly different rate, so the four of
    // them never phase-align. This is the whole trick.
    src.playbackRate.value = 0.86 + i * 0.052;

    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 190;
    filter.Q.value = 0.55;

    const gain = ac.createGain();
    gain.gain.value = 0;

    // The fan. A real turbofan's N1 whine is a strong tone at blade-passing
    // frequency, and it is the only part of the sound that tells you what the
    // engines are doing when you cannot see the gauges.
    const whine = ac.createOscillator();
    whine.type = "sawtooth";
    whine.frequency.value = 320;
    const whineGain = ac.createGain();
    whineGain.gain.value = 0;
    const whineFilter = ac.createBiquadFilter();
    whineFilter.type = "lowpass";
    whineFilter.frequency.value = 2600;

    src.connect(filter);
    filter.connect(gain);
    whine.connect(whineFilter);
    whineFilter.connect(whineGain);
    whineGain.connect(gain);
    gain.connect(out);

    try {
      src.start();
      whine.start();
    } catch {
      /* already started */
    }
    sources.push(src);
    engines.push({ gain, whine, whineGain, filter });
  }

  // --- airflow over the windshield -----------------------------------------
  const airSrc = ac.createBufferSource();
  airSrc.buffer = noise;
  airSrc.loop = true;
  airSrc.playbackRate.value = 1.7;
  const airFilter = ac.createBiquadFilter();
  airFilter.type = "highpass";
  airFilter.frequency.value = 900;
  const airGain = ac.createGain();
  airGain.gain.value = 0;
  airSrc.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(out);
  try {
    airSrc.start();
  } catch {
    /* already started */
  }

  // --- rain on the glass ---------------------------------------------------
  const rainSrc = ac.createBufferSource();
  rainSrc.buffer = noise;
  rainSrc.loop = true;
  rainSrc.playbackRate.value = 2.4;
  const rainFilter = ac.createBiquadFilter();
  rainFilter.type = "bandpass";
  rainFilter.frequency.value = 2400;
  rainFilter.Q.value = 0.4;
  const rainGain = ac.createGain();
  rainGain.gain.value = 0;
  rainSrc.connect(rainFilter);
  rainFilter.connect(rainGain);
  rainGain.connect(out);
  try {
    rainSrc.start();
  } catch {
    /* already started */
  }

  // --- one-shots -----------------------------------------------------------
  const now = () => ac.currentTime;

  /** Thunder: a filtered noise burst with a long, tumbling tail. */
  function thunder(gain: number): void {
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.35 + Math.random() * 0.2;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, now());
    lp.frequency.exponentialRampToValueAtTime(90, now() + 2.4);
    const g = ac.createGain();
    // The crack, then the roll. A single decay reads as a door slamming.
    g.gain.setValueAtTime(0.0001, now());
    g.gain.exponentialRampToValueAtTime(gain * 0.9, now() + 0.03);
    g.gain.exponentialRampToValueAtTime(gain * 0.35, now() + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, now() + 3.2);
    src.connect(lp);
    lp.connect(g);
    g.connect(out);
    src.start();
    src.stop(now() + 3.4);
  }

  /** A short tone. Chimes, warnings, the marker beacon. */
  function beep(freq: number, seconds: number, gain: number, type: OscillatorType = "sine"): void {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now());
    g.gain.exponentialRampToValueAtTime(gain, now() + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now() + seconds);
    o.connect(g);
    g.connect(out);
    o.start();
    o.stop(now() + seconds + 0.05);
  }

  /**
   * A line of dialogue, as a train of blips.
   *
   * Not speech and not trying to be. It is the Banjo-Kazooie trick: a pitched
   * blip per syllable, at a speaker's cadence, with the pitch set by who is
   * talking. Read alongside the subtitle it registers as a voice, and unlike a
   * synthesised voice it never sounds *wrong*.
   */
  function say(voice: string, syllables: number): void {
    const base =
      voice === "ELAINE" ? 420 : voice === "RUMACK" ? 175 : voice === "KRAMER" ? 145 : voice === "OTTO" ? 300 : 210;
    const n = clamp(Math.round(syllables), 1, 26);
    for (let i = 0; i < n; i++) {
      const t = now() + i * 0.085;
      const o = ac.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), t);
      const f = ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = voice === "KRAMER" || voice === "TOWER" ? 1500 : 2600;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.045, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.062);
      o.connect(f);
      f.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + 0.08);
    }
  }

  const cues: Record<string, (gain: number, rate: number) => void> = {
    thunder: (g) => thunder(g * 0.55),
    chime: () => beep(880, 0.35, 0.09),
    gear: () => beep(150, 0.5, 0.05, "square"),
    flap: () => beep(220, 0.3, 0.035, "triangle"),
    warn: () => beep(660, 0.18, 0.10, "square"),
    stall: () => beep(400, 0.10, 0.12, "sawtooth"),
    marker: () => beep(400, 0.12, 0.08),
    click: () => beep(1200, 0.05, 0.05, "square"),
    touchdown: (g) => thunder(g * 0.25),
  };

  const service: AudioService = {
    muted: false,
    unlock() {
      if (ac.state === "suspended") void ac.resume();
    },
    cue(name, opts) {
      if (service.muted) return;
      cues[name]?.(opts?.gain ?? 1, opts?.rate ?? 1);
    },
    say(voice, syllables) {
      if (service.muted) return;
      say(voice, syllables);
    },
    setMuted(m) {
      service.muted = m;
      master.gain.setTargetAtTime(m ? 0 : 0.55, now(), 0.05);
    },
  };
  ctx.services.audio = service;

  // Cues driven by events, so nothing has to call into the audio directly.
  const offs = [
    ctx.on("gear", () => service.cue("gear")),
    ctx.on("flaps", () => service.cue("flap")),
    ctx.on("crisis", () => service.cue("chime")),
    ctx.on("autopilot", () => service.cue("click")),
  ];

  let stallBeep = 0;
  let markerBeep = 0;
  let wasOnGround = true;

  return {
    update(dt, c) {
      if (service.muted || ac.state !== "running") return;
      const air = c.services.flight as AircraftService | undefined;
      if (!air) return;
      const s = air.state;
      const t = now();

      // Engines. Level follows N1; the fan whine follows it much more steeply,
      // which is what makes spooling up *sound* like spooling up.
      const inside = c.services.camera?.inCockpit ?? true;
      const hull = inside ? 0.55 : 1.0;
      for (let i = 0; i < 4; i++) {
        const n1 = s.n1[i];
        engines[i].gain.gain.setTargetAtTime(n1 * n1 * 0.20 * hull, t, 0.12);
        engines[i].filter.frequency.setTargetAtTime(150 + n1 * 260, t, 0.2);
        engines[i].whine.frequency.setTargetAtTime(240 + n1 * 900 + i * 7, t, 0.15);
        engines[i].whineGain.gain.setTargetAtTime(
          Math.pow(n1, 3) * 0.035 * (inside ? 0.5 : 1),
          t,
          0.15,
        );
      }

      // Airflow: scales with dynamic pressure, not with thrust.
      const q = (s.ias * s.ias) / (190 * 190);
      airGain.gain.setTargetAtTime(clamp(q, 0, 1) * 0.13 * hull, t, 0.2);
      airFilter.frequency.setTargetAtTime(700 + s.ias * 6, t, 0.3);

      // Rain: only when there is any, and louder inside where it hits glass.
      const rain = (c.services.sky?.rain ?? 0) * (s.altitude < 4600 ? 1 : 0.1);
      rainGain.gain.setTargetAtTime(rain * 0.055 * (inside ? 1 : 0.4), t, 0.4);

      // The stick shaker. A real one is a mechanical rattle on the column and
      // it is impossible to ignore, which is the point.
      if (s.stallMargin < 0.12 && !s.onGround) {
        stallBeep -= dt;
        if (stallBeep <= 0) {
          stallBeep = 0.11;
          service.cue("stall");
        }
      }

      // Marker beacons, on the way down the approach.
      if (air.ils.valid && air.ils.distance < 11000 && s.radarAltitude > 30) {
        const outer = Math.abs(air.ils.distance - 9260) < 350;
        const middle = Math.abs(air.ils.distance - 1050) < 180;
        if (outer || middle) {
          markerBeep -= dt;
          if (markerBeep <= 0) {
            markerBeep = outer ? 0.5 : 0.2;
            service.cue("marker");
          }
        }
      }

      if (s.onGround && !wasOnGround) service.cue("touchdown", { gain: clamp(-s.touchdownVs / 3, 0.2, 1) });
      wasOnGround = s.onGround;
    },

    dispose() {
      for (const o of offs) o();
      for (const src of [...sources, airSrc, rainSrc]) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const e of engines) {
        try {
          e.whine.stop();
        } catch {
          /* already stopped */
        }
      }
      // Browsers cap live AudioContexts too, and a world that leaks one is the
      // same class of bug as a leaked WebGL context.
      void ac.close().catch(() => undefined);
      delete ctx.services.audio;
    },
  };
}

function silentService(): AudioService {
  return {
    muted: true,
    unlock() {},
    cue() {},
    say() {},
    setMuted() {},
  };
}
