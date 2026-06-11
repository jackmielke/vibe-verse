/**
 * citySounds — tiny synthesized audio engine for Vibe City.
 *
 * Everything is generated with WebAudio (no audio assets): a filtered
 * noise loop for the jetpack thruster, a darker noise bed for wind at
 * speed, pentatonic chimes for star pickups, a landing thud, and a
 * little fanfare when the run completes.
 *
 * Create it inside a user-gesture handler (browsers require one to
 * start an AudioContext). All levels are set via setTargetAtTime so
 * there are no clicks.
 */
export interface CitySounds {
  /** Per-frame: ramp thruster + wind beds toward their targets. */
  update(thrusting: boolean, speed: number, airborne: boolean): void;
  /** Star pickup chime; `step` walks up a pentatonic scale. */
  chime(step: number): void;
  /** Landing thud; `impact` 0..1 scales the volume. */
  thud(impact: number): void;
  /** All-stars-collected fanfare. */
  fanfare(): void;
  /** A comedy moo for the cow Easter egg. */
  moo(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0]; // C5 maj pent

export function createCitySounds(): CitySounds | null {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return null; // no audio support — the game plays silently
  }

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  // Shared 2s noise buffer for thruster + wind.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const makeNoiseBed = (filterType: BiquadFilterType, freq: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    return { gain, filter };
  };

  const thrust = makeNoiseBed("bandpass", 320);
  thrust.filter.Q.value = 0.8;
  const wind = makeNoiseBed("lowpass", 480);

  const blip = (freq: number, t0: number, dur: number, level: number, type: OscillatorType) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  };

  return {
    update(thrusting, speed, airborne) {
      const t = ctx.currentTime;
      // Thruster: rumbly band of noise with a little wobble baked in
      // by modulating the filter alongside the gain.
      thrust.gain.gain.setTargetAtTime(thrusting ? 0.32 : 0, t, 0.08);
      thrust.filter.frequency.setTargetAtTime(thrusting ? 280 + speed * 6 : 320, t, 0.15);
      // Wind builds with airspeed, mostly while airborne.
      const windLevel = airborne ? Math.min(speed / 38, 1) * 0.22 : 0.015;
      wind.gain.gain.setTargetAtTime(windLevel, t, 0.25);
    },
    chime(step) {
      const t = ctx.currentTime;
      const note = PENTATONIC[step % PENTATONIC.length] * (1 + Math.floor(step / 10));
      blip(note, t, 0.5, 0.22, "sine");
      blip(note * 1.5, t + 0.04, 0.4, 0.1, "sine");
    },
    thud(impact) {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(95, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.4 * impact, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.25);
    },
    fanfare() {
      const t = ctx.currentTime;
      [0, 2, 4, 7, 9].forEach((s, i) => {
        blip(PENTATONIC[s % 5] * (s >= 5 ? 2 : 1), t + i * 0.14, 0.6, 0.2, "triangle");
      });
    },
    moo() {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(196, t);
      osc.frequency.linearRampToValueAtTime(140, t + 0.18);
      osc.frequency.linearRampToValueAtTime(108, t + 0.55);
      const vib = ctx.createOscillator();
      vib.frequency.value = 6.5;
      const vibGain = ctx.createGain();
      vibGain.gain.value = 7;
      vib.connect(vibGain).connect(osc.frequency);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 420;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.34, t + 0.06);
      g.gain.setValueAtTime(0.34, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.68);
      osc.connect(lp).connect(g).connect(master);
      osc.start(t);
      vib.start(t);
      osc.stop(t + 0.75);
      vib.stop(t + 0.75);
    },
    setMuted(muted) {
      master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    },
    dispose() {
      void ctx.close();
    },
  };
}
