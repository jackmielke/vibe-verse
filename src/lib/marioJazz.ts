/**
 * marioJazz — a tiny procedural "jazz cafe" soundtrack + SFX engine for
 * SUPER DUPER MARIO. Everything is synthesized with WebAudio (no audio
 * assets to download, which keeps the world light on mobile).
 *
 * The bed is a relaxed lounge trio: a walking upright bass, soft
 * Rhodes-ish ii–V–I comping, and brushed drums, all looping over a
 * laid-back swing. On top sit the classic platformer SFX (coin, jump,
 * stomp, warp, 1-UP) but voiced warm and mellow so they sit inside the
 * cafe vibe instead of fighting it.
 *
 * Must be created from a user gesture (browsers gate AudioContext).
 */
export interface MarioJazz {
  /** Start/stop the looping cafe bed. */
  setPlaying(playing: boolean): void;
  coin(): void;
  jump(): void;
  stomp(): void;
  warp(): void;
  oneUp(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

// A short, friendly ii–V–I–VI turnaround in F major (Real-Book staple).
// Each chord is [root, third, fifth, seventh] in Hz, voiced mid-register.
const PROGRESSION: number[][] = [
  [146.83, 174.61, 220.0, 261.63], // Gm7  (ii)
  [130.81, 164.81, 196.0, 233.08], // C9   (V)
  [174.61, 220.0, 261.63, 329.63], // Fmaj7(I)
  [146.83, 185.0, 220.0, 277.18], // D7b9 (VI) -> back to ii
];

// Walking-bass scale tones per bar (roots + passing notes), low octave.
const BASS_LINES: number[][] = [
  [98.0, 110.0, 123.47, 130.81], // G A B C
  [130.81, 123.47, 110.0, 98.0], // C B A G
  [87.31, 98.0, 110.0, 116.54], // F G A Bb
  [146.83, 138.59, 130.81, 123.47], // D Db C B
];

export function createMarioJazz(): MarioJazz | null {
  let ctx: AudioContext;
  try {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  } catch {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = 0.0001;
  master.connect(ctx.destination);

  // Gentle room reverb so the cafe feels like a small room, not a void.
  const convolver = ctx.createConvolver();
  {
    const len = ctx.sampleRate * 1.4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    convolver.buffer = buf;
  }
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  convolver.connect(wet).connect(master);

  const bedGain = ctx.createGain();
  bedGain.gain.value = 0.55;
  bedGain.connect(master);
  bedGain.connect(convolver);

  const sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.9;
  sfxGain.connect(master);
  sfxGain.connect(convolver);

  // Shared noise buffer for brushed drums.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  {
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---- voices -----------------------------------------------------
  const rhodes = (freq: number, t: number, dur: number, vel: number) => {
    // Two slightly detuned sines + a soft attack = electric-piano-ish.
    [0, 1].forEach((i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq * (i ? 1.005 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel * (i ? 0.5 : 1), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1600;
      o.connect(g).connect(lp).connect(bedGain);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  };

  const bass = (freq: number, t: number, dur: number) => {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bedGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  const brush = (t: number, vel: number, bright: boolean) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (bright ? 0.12 : 0.06));
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = bright ? 6500 : 3200;
    bp.Q.value = 0.7;
    src.connect(bp).connect(g).connect(bedGain);
    src.start(t);
    src.stop(t + 0.2);
  };

  // ---- swing scheduler -------------------------------------------
  const BPM = 96;
  const beat = 60 / BPM;
  const swing = 0.62; // ratio of first eighth within a beat
  let bar = 0;
  let nextNoteTime = 0;
  let timer: number | null = null;

  const scheduleBar = (barStart: number) => {
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const line = BASS_LINES[bar % BASS_LINES.length];

    for (let b = 0; b < 4; b++) {
      const tBeat = barStart + b * beat;
      // Walking bass: one note per beat.
      bass(line[b], tBeat, beat * 0.95);
      // Brushed swing ride: down-beat + swung up-beat.
      brush(tBeat, 0.05, true);
      brush(tBeat + beat * swing, 0.035, true);
      // Soft snare brush on 2 and 4.
      if (b === 1 || b === 3) brush(tBeat, 0.04, false);
    }
    // Comp the chord softly on beats 1 and the "and" of 2 (Rhodes).
    chord.forEach((f) => rhodes(f, barStart + beat * 0.0, beat * 1.6, 0.07));
    chord.forEach((f) => rhodes(f, barStart + beat * 2.5, beat * 1.4, 0.055));
    bar++;
  };

  const loop = () => {
    while (nextNoteTime < ctx.currentTime + 0.3) {
      scheduleBar(nextNoteTime);
      nextNoteTime += beat * 4;
    }
    timer = window.setTimeout(loop, 80);
  };

  // ---- SFX --------------------------------------------------------
  const blip = (freqs: number[], step: number, type: OscillatorType, dur: number, vel: number) => {
    const t0 = ctx.currentTime;
    freqs.forEach((f, i) => {
      const t = t0 + i * step;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(sfxGain);
      o.start(t);
      o.stop(t + dur + 0.02);
    });
  };

  return {
    setPlaying(playing) {
      if (ctx.state === "suspended") ctx.resume();
      if (playing) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.6);
        if (timer == null) {
          nextNoteTime = ctx.currentTime + 0.1;
          loop();
        }
      } else {
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
        if (timer != null) {
          window.clearTimeout(timer);
          timer = null;
        }
      }
    },
    coin() {
      blip([987.77, 1318.51], 0.08, "triangle", 0.16, 0.22);
    },
    jump() {
      // Quick upward swoop.
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(330, t);
      o.frequency.exponentialRampToValueAtTime(740, t + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(sfxGain);
      o.start(t);
      o.stop(t + 0.2);
    },
    stomp() {
      blip([220, 110], 0.05, "square", 0.12, 0.2);
    },
    warp() {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(110, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      o.connect(g).connect(sfxGain);
      o.start(t);
      o.stop(t + 0.6);
    },
    oneUp() {
      blip([659.25, 783.99, 1046.5, 1318.51], 0.12, "triangle", 0.28, 0.2);
    },
    setMuted(muted) {
      master.gain.setTargetAtTime(muted ? 0.0001 : 0.5, ctx.currentTime, 0.2);
    },
    dispose() {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      ctx.close();
    },
  };
}
