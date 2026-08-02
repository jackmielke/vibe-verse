/**
 * Every sound in this world is synthesised at runtime. Nothing is downloaded.
 *
 * That is not a technical flourish, it is the only way this world could sound
 * like Star Trek at all — the actual effects are somebody's property, and a
 * world that shipped them would be a world that had to be taken down. What is
 * *not* anybody's property is the physics: the bridge hum is a low drone with
 * a fifth in it, the red alert is a sawtooth swept up and cut off, a phaser is
 * a buzzing tone ring-modulated at around thirty hertz, and the transporter is
 * a cluster of sines glissing in opposite directions through a sparkle of
 * filtered noise. Build those from oscillators and you land somewhere the ear
 * files under "that show" without ever having copied a waveform.
 *
 * The single most valuable thing in this file is the least dramatic: `chatter`.
 * The TOS bridge is never quiet — there is a soft blip roughly every two
 * seconds from a console nobody is looking at. Take it away and the room dies.
 * It costs eight lines.
 */
import type { AlertLevel, AudioService, CrewLine, System, TrekCtx } from "../types";

interface VoiceProfile {
  pitch: number;
  rate: number;
  /** Prefer a voice whose name or locale matches one of these, in order. */
  prefer: string[];
}

/**
 * Per-officer voice settings for the browser's own speech synthesiser.
 *
 * The voices available differ on every machine, so this cannot be exact and
 * does not try to be. What it can do is make them *distinguishable* — Spock
 * lower and slower than anyone else, Chekov quick and high, the computer flat
 * and a little fast — which is enough that you know who is talking before you
 * read the caption.
 */
const VOICES: Record<string, VoiceProfile> = {
  CAPTAIN: { pitch: 0.92, rate: 0.95, prefer: ["Google US English", "en-US"] },
  SPOCK: { pitch: 0.72, rate: 0.86, prefer: ["Daniel", "en-GB", "en-US"] },
  "MR. SPOCK": { pitch: 0.72, rate: 0.86, prefer: ["Daniel", "en-GB", "en-US"] },
  SCOTT: { pitch: 0.82, rate: 0.94, prefer: ["Daniel", "en-GB", "en-US"] },
  SULU: { pitch: 0.95, rate: 1.0, prefer: ["Google US English", "en-US"] },
  CHEKOV: { pitch: 1.08, rate: 1.12, prefer: ["en-GB", "en-US"] },
  UHURA: { pitch: 1.22, rate: 1.0, prefer: ["Samantha", "Google UK English Female", "en-US"] },
  MCCOY: { pitch: 0.98, rate: 1.06, prefer: ["Fred", "en-US"] },
  COMPUTER: { pitch: 1.34, rate: 0.92, prefer: ["Samantha", "Google UK English Female", "en-US"] },
  COMMAND: { pitch: 0.88, rate: 0.96, prefer: ["en-US"] },
  KLINGON: { pitch: 0.58, rate: 0.84, prefer: ["en-GB", "en-US"] },
  ROMULAN: { pitch: 0.66, rate: 0.88, prefer: ["Daniel", "en-GB", "en-US"] },
};

export function createAudio(ctx: TrekCtx): System {
  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambienceGain: GainNode | null = null;
  let spaceSend: GainNode | null = null;
  let muted = false;
  let voicesOn = true;
  let alert: AlertLevel = "normal";

  const stops: (() => void)[] = [];
  let chatterAt = 0;
  let klaxonAt = 0;
  let beamNodes: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  function ensure(): boolean {
    if (ac) {
      if (ac.state === "suspended") void ac.resume();
      return true;
    }
    if (!AC) return false;
    try {
      ac = new AC();
    } catch {
      return false;
    }
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ac.destination);

    // A long, dark delay tail. Space has no reverb, but a bridge does, and a
    // room that sounds anechoic reads as a green screen.
    const delay = ac.createDelay(1.0);
    delay.delayTime.value = 0.19;
    const fb = ac.createGain();
    fb.gain.value = 0.32;
    const tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2200;
    delay.connect(tone);
    tone.connect(fb);
    fb.connect(delay);
    delay.connect(master);
    spaceSend = ac.createGain();
    spaceSend.gain.value = 0.5;
    spaceSend.connect(delay);

    sfxBus = ac.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);
    sfxBus.connect(spaceSend);

    ambienceGain = ac.createGain();
    ambienceGain.gain.value = 0;
    ambienceGain.connect(master);

    startAmbience();
    return true;
  }

  function noiseBuffer(seconds: number): AudioBuffer {
    const len = Math.max(1, Math.floor(ac!.sampleRate * seconds));
    const buf = ac!.createBuffer(1, len, ac!.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * The engine hum.
   *
   * Three detuned sines an octave and a fifth apart with a slow beat between
   * them, plus a band of filtered noise for the air handling. The beat is the
   * part people actually remember — two oscillators a couple of hertz apart
   * produce a slow throb, and that throb is the sound of a ship being alive.
   */
  function startAmbience(): void {
    if (!ac || !ambienceGain) return;
    const partials: [number, number][] = [
      [55, 0.34],
      [55.7, 0.3],
      [82.5, 0.16],
      [110, 0.09],
      [164.8, 0.035],
    ];
    for (const [freq, gain] of partials) {
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ac.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(ambienceGain);
      osc.start();
      stops.push(() => {
        try {
          osc.stop();
          osc.disconnect();
          g.disconnect();
        } catch {
          /* already gone */
        }
      });
    }

    const air = ac.createBufferSource();
    air.buffer = noiseBuffer(4);
    air.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 480;
    bp.Q.value = 0.7;
    const ag = ac.createGain();
    ag.gain.value = 0.05;
    air.connect(bp);
    bp.connect(ag);
    ag.connect(ambienceGain);
    air.start();
    stops.push(() => {
      try {
        air.stop();
        air.disconnect();
        bp.disconnect();
        ag.disconnect();
      } catch {
        /* already gone */
      }
    });

    // Fade in over three seconds — the ship was already running when you
    // walked on.
    ambienceGain.gain.setValueAtTime(0, ac.currentTime);
    ambienceGain.gain.linearRampToValueAtTime(0.5, ac.currentTime + 3);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  interface ToneOpts {
    type?: OscillatorType;
    from: number;
    to?: number;
    dur: number;
    gain?: number;
    attack?: number;
    filter?: { type: BiquadFilterType; freq: number; q?: number; to?: number };
    /** Ring modulation depth and rate — what makes a phaser a phaser. */
    ring?: [number, number];
    delay?: number;
    send?: number;
  }

  function tone(o: ToneOpts): void {
    if (!ac || !sfxBus) return;
    const t = ac.currentTime + (o.delay ?? 0);
    const osc = ac.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + o.dur);

    const g = ac.createGain();
    const peak = (o.gain ?? 0.3) * (muted ? 0 : 1);
    const atk = o.attack ?? 0.006;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    let node: AudioNode = osc;
    if (o.filter) {
      const f = ac.createBiquadFilter();
      f.type = o.filter.type;
      f.frequency.setValueAtTime(o.filter.freq, t);
      if (o.filter.to !== undefined) {
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.to), t + o.dur);
      }
      f.Q.value = o.filter.q ?? 1;
      node.connect(f);
      node = f;
    }
    node.connect(g);

    if (o.ring) {
      const [depth, rate] = o.ring;
      const lfo = ac.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = rate;
      const lg = ac.createGain();
      lg.gain.value = depth;
      lfo.connect(lg);
      lg.connect(g.gain);
      lfo.start(t);
      lfo.stop(t + o.dur + 0.05);
    }

    g.connect(sfxBus);
    if (o.send !== undefined && spaceSend) {
      const s = ac.createGain();
      s.gain.value = o.send;
      g.connect(s);
      s.connect(spaceSend);
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  function noise(o: {
    dur: number;
    gain?: number;
    freq: number;
    to?: number;
    q?: number;
    type?: BiquadFilterType;
    delay?: number;
  }): void {
    if (!ac || !sfxBus) return;
    const t = ac.currentTime + (o.delay ?? 0);
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(Math.max(0.12, o.dur));
    const f = ac.createBiquadFilter();
    f.type = o.type ?? "bandpass";
    f.frequency.setValueAtTime(o.freq, t);
    if (o.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.dur);
    f.Q.value = o.q ?? 1;
    const g = ac.createGain();
    const peak = (o.gain ?? 0.3) * (muted ? 0 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(sfxBus);
    src.start(t);
    src.stop(t + o.dur + 0.05);
    src.onended = () => {
      try {
        src.disconnect();
        f.disconnect();
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /** Every sound the game can ask for, by name. */
  const CUES: Record<string, (opts?: { gain?: number; rate?: number; detune?: number }) => void> = {
    // The console blip. Pitch varies so it never sounds like a metronome.
    blip: (o) => tone({ type: "sine", from: 900 * (o?.rate ?? 1), dur: 0.07, gain: 0.05 }),
    blipLow: (o) => tone({ type: "sine", from: 420 * (o?.rate ?? 1), dur: 0.09, gain: 0.05 }),
    // The two-tone acknowledgement a station gives when it takes an order.
    ack: () => {
      tone({ type: "sine", from: 780, dur: 0.06, gain: 0.09 });
      tone({ type: "sine", from: 1180, dur: 0.08, gain: 0.08, delay: 0.07 });
    },
    // The boatswain's whistle. Up, hold, trill, down.
    bosun: () => {
      tone({ type: "sine", from: 700, to: 1500, dur: 0.28, gain: 0.13 });
      tone({ type: "sine", from: 1500, to: 1520, dur: 0.3, gain: 0.11, delay: 0.28, ring: [0.5, 11] });
      tone({ type: "sine", from: 1500, to: 780, dur: 0.24, gain: 0.11, delay: 0.58 });
    },
    // Hailing frequencies: the little inquisitive warble.
    hail: () => {
      tone({ type: "triangle", from: 620, to: 1240, dur: 0.13, gain: 0.1 });
      tone({ type: "triangle", from: 1240, to: 900, dur: 0.16, gain: 0.09, delay: 0.14 });
    },
    // The communicator flip-and-chirp.
    communicator: () => {
      tone({ type: "sine", from: 420, to: 2100, dur: 0.16, gain: 0.11, ring: [0.35, 24] });
    },
    // Phasers: a buzzing tone that falls and then holds. One shot version.
    phaser: () => {
      tone({
        type: "sawtooth",
        from: 720,
        to: 430,
        dur: 0.55,
        gain: 0.16,
        ring: [0.55, 29],
        filter: { type: "bandpass", freq: 1400, q: 3, to: 900 },
        send: 0.4,
      });
    },
    disruptor: () => {
      tone({
        type: "square",
        from: 1050,
        to: 620,
        dur: 0.3,
        gain: 0.13,
        ring: [0.6, 41],
        filter: { type: "bandpass", freq: 2000, q: 4, to: 1100 },
        send: 0.35,
      });
    },
    // Torpedo launch: air leaving a tube, then the low thump of the mass.
    torpedo: () => {
      noise({ dur: 0.34, gain: 0.2, freq: 2400, to: 300, q: 1.2 });
      tone({ type: "sine", from: 160, to: 52, dur: 0.5, gain: 0.24, send: 0.5 });
    },
    plasma: () => {
      tone({ type: "sawtooth", from: 300, to: 120, dur: 0.9, gain: 0.16, ring: [0.4, 7], send: 0.6 });
      noise({ dur: 0.9, gain: 0.1, freq: 700, to: 200, q: 0.8 });
    },
    // Shields taking a beam: bright, ringing, and *not* destructive-sounding.
    shieldHit: () => {
      tone({ type: "sine", from: 1750, to: 640, dur: 0.42, gain: 0.16, ring: [0.4, 17], send: 0.6 });
      noise({ dur: 0.2, gain: 0.09, freq: 3200, to: 900, q: 2 });
    },
    // Hull taking a hit: the whole room lurches. Low, brief, and physical.
    hullHit: () => {
      tone({ type: "sine", from: 120, to: 38, dur: 0.7, gain: 0.34, send: 0.7 });
      noise({ dur: 0.5, gain: 0.24, freq: 900, to: 120, q: 0.7 });
      noise({ dur: 0.22, gain: 0.1, freq: 4200, to: 1800, q: 3, delay: 0.02 });
    },
    // A console going up in the captain's face.
    consoleBlow: () => {
      noise({ dur: 0.5, gain: 0.26, freq: 2600, to: 260, q: 0.8 });
      tone({ type: "sawtooth", from: 340, to: 60, dur: 0.4, gain: 0.16 });
    },
    explosion: (o) => {
      const g = o?.gain ?? 1;
      noise({ dur: 1.9, gain: 0.34 * g, freq: 620, to: 70, q: 0.5 });
      tone({ type: "sine", from: 92, to: 26, dur: 2.1, gain: 0.4 * g, send: 0.9 });
      noise({ dur: 0.3, gain: 0.2 * g, freq: 5200, to: 1400, q: 1.5 });
    },
    // The transporter. Two clusters glissing past each other through sparkle.
    transporter: () => {
      for (let i = 0; i < 5; i++) {
        const base = 300 + i * 190;
        tone({ type: "sine", from: base, to: base * 2.2, dur: 2.6, gain: 0.05, attack: 0.6 });
        tone({ type: "sine", from: base * 2.4, to: base * 1.1, dur: 2.6, gain: 0.045, attack: 0.9 });
      }
      noise({ dur: 2.6, gain: 0.06, freq: 5200, to: 2200, q: 1.2 });
    },
    // Warp: the drive winding up, then the snap of leaving.
    warp: () => {
      tone({ type: "sawtooth", from: 60, to: 240, dur: 2.4, gain: 0.2, attack: 0.8, filter: { type: "lowpass", freq: 400, to: 2600, q: 1 } });
      noise({ dur: 2.6, gain: 0.14, freq: 300, to: 4800, q: 0.6 });
      tone({ type: "sine", from: 1400, to: 90, dur: 1.4, gain: 0.28, delay: 2.3, send: 1 });
      noise({ dur: 1.6, gain: 0.2, freq: 6000, to: 200, q: 0.5, delay: 2.3 });
    },
    // The turbolift.
    doors: () => {
      noise({ dur: 0.45, gain: 0.12, freq: 900, to: 2600, q: 1.4 });
      noise({ dur: 0.3, gain: 0.08, freq: 2600, to: 700, q: 1.4, delay: 0.4 });
    },
    // The library computer, answering.
    computer: () => {
      tone({ type: "square", from: 1500, dur: 0.05, gain: 0.06 });
      tone({ type: "square", from: 1100, dur: 0.05, gain: 0.06, delay: 0.06 });
      tone({ type: "square", from: 1800, dur: 0.07, gain: 0.06, delay: 0.12 });
    },
    // Mission title cards. Original motif — a rising fourth, held, resolved up.
    fanfare: () => {
      const notes: [number, number, number][] = [
        [174.6, 0, 0.55],
        [233.1, 0.5, 0.5],
        [349.2, 0.95, 1.6],
        [261.6, 0.95, 1.6],
        [440.0, 0.95, 1.6],
      ];
      for (const [f, at, dur] of notes) {
        tone({
          type: "sawtooth",
          from: f,
          dur,
          gain: 0.09,
          attack: 0.12,
          delay: at,
          filter: { type: "lowpass", freq: 900, to: 2200, q: 0.8 },
          send: 0.9,
        });
        tone({ type: "sine", from: f * 2, dur, gain: 0.035, attack: 0.16, delay: at, send: 0.6 });
      }
    },
    victory: () => {
      const notes: [number, number][] = [[261.6, 0], [329.6, 0.16], [392.0, 0.32], [523.3, 0.48]];
      for (const [f, at] of notes) {
        tone({ type: "triangle", from: f, dur: 0.9, gain: 0.1, attack: 0.03, delay: at, send: 0.8 });
      }
    },
    defeat: () => {
      tone({ type: "sawtooth", from: 220, to: 60, dur: 3.2, gain: 0.18, filter: { type: "lowpass", freq: 1200, to: 200, q: 1 }, send: 1 });
    },
    lock: () => {
      tone({ type: "square", from: 1320, dur: 0.05, gain: 0.07 });
      tone({ type: "square", from: 1760, dur: 0.09, gain: 0.07, delay: 0.055 });
    },
    deny: () => {
      tone({ type: "square", from: 320, dur: 0.09, gain: 0.09 });
      tone({ type: "square", from: 220, dur: 0.14, gain: 0.09, delay: 0.09 });
    },
    // The cloak: a swallowed, descending shimmer.
    cloak: () => {
      for (let i = 0; i < 4; i++) {
        tone({ type: "sine", from: 1400 - i * 160, to: 180, dur: 1.5, gain: 0.05, attack: 0.2, send: 0.8 });
      }
      noise({ dur: 1.4, gain: 0.07, freq: 4000, to: 400, q: 1.5 });
    },
    decloak: () => {
      for (let i = 0; i < 4; i++) {
        tone({ type: "sine", from: 200, to: 1300 - i * 150, dur: 1.1, gain: 0.05, attack: 0.15, send: 0.8 });
      }
      noise({ dur: 1.1, gain: 0.08, freq: 400, to: 4200, q: 1.5 });
    },
  };

  // -------------------------------------------------------------------------
  // Sustained phaser beam
  // -------------------------------------------------------------------------

  function setPhaserBeam(on: boolean): void {
    if (!ac || !sfxBus) return;
    if (on && !beamNodes) {
      const osc = ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(760, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(455, ac.currentTime + 0.35);
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1250;
      bp.Q.value = 3.2;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(muted ? 0.0001 : 0.13, ac.currentTime + 0.05);
      const lfo = ac.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 31;
      const lg = ac.createGain();
      lg.gain.value = 0.5;
      lfo.connect(lg);
      lg.connect(g.gain);
      osc.connect(bp);
      bp.connect(g);
      g.connect(sfxBus);
      osc.start();
      lfo.start();
      beamNodes = { osc, gain: g, lfo };
    } else if (!on && beamNodes) {
      const { osc, gain, lfo } = beamNodes;
      beamNodes = null;
      const t = ac.currentTime;
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(0.0002, gain.gain.value), t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.stop(t + 0.16);
        lfo.stop(t + 0.16);
        osc.onended = () => {
          try {
            osc.disconnect();
            lfo.disconnect();
            gain.disconnect();
          } catch {
            /* already gone */
          }
        };
      } catch {
        /* already stopped */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Speech
  // -------------------------------------------------------------------------

  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  let voiceList: SpeechSynthesisVoice[] = [];
  const refreshVoices = () => {
    try {
      voiceList = synth?.getVoices() ?? [];
    } catch {
      voiceList = [];
    }
  };
  refreshVoices();
  if (synth) synth.addEventListener?.("voiceschanged", refreshVoices);

  function pickVoice(profile: VoiceProfile): SpeechSynthesisVoice | undefined {
    if (!voiceList.length) return undefined;
    for (const want of profile.prefer) {
      const hit = voiceList.find(
        (v) => v.name === want || v.lang === want || v.name.includes(want),
      );
      if (hit) return hit;
    }
    return voiceList.find((v) => v.lang.startsWith("en")) ?? voiceList[0];
  }

  function speak(line: CrewLine): void {
    if (!voicesOn || muted || !synth) return;
    const profile = VOICES[line.who.toUpperCase()] ?? VOICES.COMPUTER;
    try {
      const u = new SpeechSynthesisUtterance(line.text);
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      u.volume = 0.95;
      const v = pickVoice(profile);
      if (v) u.voice = v;
      synth.speak(u);
    } catch {
      /* a browser without speech is a browser with subtitles */
    }
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  const service: AudioService = {
    unlock() {
      ensure();
    },
    cue(name, opts) {
      if (!ensure()) return;
      CUES[name]?.(opts);
    },
    setAlert(level) {
      alert = level;
      if (level === "normal") klaxonAt = 0;
    },
    setPhaserBeam(on) {
      if (!ensure()) return;
      setPhaserBeam(on);
    },
    speak(line) {
      speak(line);
    },
    setMuted(m) {
      muted = m;
      service.muted = m;
      if (master && ac) {
        master.gain.setTargetAtTime(m ? 0 : 0.85, ac.currentTime, 0.05);
      }
      if (m && synth) {
        try {
          synth.cancel();
        } catch {
          /* nothing queued */
        }
      }
    },
    setVoices(on) {
      voicesOn = on;
      service.voices = on;
      if (!on && synth) {
        try {
          synth.cancel();
        } catch {
          /* nothing queued */
        }
      }
    },
    muted: false,
    voices: true,
  };

  ctx.services.audio = service;

  // One gesture anywhere starts the graph. Browsers require it and the entry
  // screen's "Assume command" button is that gesture, but a stray click on the
  // canvas should work too.
  const kick = () => ensure();
  window.addEventListener("pointerdown", kick, { passive: true });
  window.addEventListener("keydown", kick);

  return {
    update(dt) {
      if (!ac) return;

      // Console chatter. Random, sparse, and quiet — see the file header.
      chatterAt -= dt;
      if (chatterAt <= 0) {
        chatterAt = 0.8 + Math.random() * 2.6;
        const rate = 0.6 + Math.random() * 1.5;
        if (Math.random() < 0.5) CUES.blip({ rate });
        else CUES.blipLow({ rate });
      }

      // The klaxon. TOS red alert is a sawtooth swept up hard and cut off,
      // roughly twice a second, with a lower octave under it for weight.
      if (alert !== "normal") {
        klaxonAt -= dt;
        if (klaxonAt <= 0) {
          const red = alert === "red";
          klaxonAt = red ? 1.05 : 1.9;
          tone({
            type: "sawtooth",
            from: red ? 380 : 300,
            to: red ? 900 : 560,
            dur: 0.42,
            gain: red ? 0.15 : 0.09,
            attack: 0.05,
            filter: { type: "lowpass", freq: 2400, q: 1 },
            send: 0.5,
          });
          tone({
            type: "sawtooth",
            from: red ? 190 : 150,
            to: red ? 450 : 280,
            dur: 0.42,
            gain: red ? 0.1 : 0.06,
            attack: 0.05,
            send: 0.5,
          });
        }
      }
    },

    dispose() {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
      synth?.removeEventListener?.("voiceschanged", refreshVoices);
      try {
        synth?.cancel();
      } catch {
        /* nothing queued */
      }
      setPhaserBeam(false);
      for (const stop of stops) stop();
      stops.length = 0;
      try {
        void ac?.close();
      } catch {
        /* already closed */
      }
      ac = null;
    },
  };
}
