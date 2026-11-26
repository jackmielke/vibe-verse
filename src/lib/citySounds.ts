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
import { gobble as gobbleSound } from "@/city/turkey";

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
  /** A turkey's gobble, for the Thanksgiving mount. */
  gobble(): void;
  /** Thunder, for GOD MODE storms: a crack, then a long rolling tail. */
  thunder(): void;
  /**
   * Something entering water. `strength` 0..1 — a swimmer stepping off the
   * sand at one end, a kart arriving at thirty metres a second at the other.
   *
   * `gain` is distance. There is no panner anywhere in this engine and no
   * listener position: every sound is mixed straight into one master gain, so
   * without a caller-supplied falloff a splash on the far side of the bay is
   * exactly as loud as one at your feet. That is not a subtlety — it is why a
   * kart sinking three hundred metres away kept bubbling in your ear after you
   * had walked up the beach and gone home.
   */
  splash(strength: number, gain?: number): void;
  /** A car not surviving the landing: a body blow with a long tail. */
  boom(strength: number, gain?: number): void;
  /** One bubble. Call it at a throttled rate, not per frame. */
  bubble(gain?: number): void;
  /**
   * How far under the water the LISTENER is, 0..1.
   *
   * Sweeps a lowpass across the whole mix. Water carries low frequencies and
   * eats high ones, and that single fact is most of what your ears use to
   * decide whether your head is under — which is why the effect is worth more
   * than any individual underwater sound. Everything already in the world goes
   * through it for free: the jetpack, the wind, the chimes, the city.
   */
  setSubmerged(k: number): void;
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
  /**
   * Everything leaves through here, so going underwater can muffle the world.
   *
   * `master` keeps belonging to `setMuted` — the submerged duck gets its own
   * gain node rather than sharing one, because two things ramping the same
   * `AudioParam` with `setTargetAtTime` do not average, they overwrite, and
   * the loser is whichever ran first.
   */
  const submergeGain = ctx.createGain();
  submergeGain.gain.value = 1;
  const submerge = ctx.createBiquadFilter();
  submerge.type = "lowpass";
  // Wide open. A lowpass at the top of hearing is audibly a straight wire.
  submerge.frequency.value = 20000;
  master.connect(submergeGain).connect(submerge).connect(ctx.destination);

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
    thunder() {
      const t = ctx.currentTime;
      // Filtered noise, not an oscillator: thunder has no pitch. A short
      // bright crack rides on top of a long low roll that sweeps down as
      // it decays, which is what makes it sound distant rather than like
      // a snare hit.
      const dur = 2.6;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1800, t);
      lp.frequency.exponentialRampToValueAtTime(160, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.02);   // the crack
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur); // the roll
      src.connect(lp).connect(g).connect(master);
      src.start(t);
      src.stop(t + dur);
    },
    gobble() {
      gobbleSound(ctx, master, 0.35);
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
    splash(strength, gain = 1) {
      const s = Math.max(0, Math.min(1, strength));
      const g0 = Math.max(0, Math.min(1, gain));
      if (g0 < 0.01) return;
      const t = ctx.currentTime;
      /**
       * Noise, not an oscillator, for the same reason thunder is: water has no
       * pitch. What makes it read as water rather than as static is the
       * SWEEP — bright at the instant of contact, closing down to a low churn
       * as the froth collapses. A fixed filter is a hiss.
       */
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = 0.7;
      f.frequency.setValueAtTime(1600 + 2600 * s, t);
      f.frequency.exponentialRampToValueAtTime(240, t + 0.3 + 0.35 * s);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.34 * (0.25 + s) * g0, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45 + 0.55 * s);
      src.connect(f).connect(g).connect(master);
      // Offset into the buffer, so two splashes in a row are not the same
      // two hundred milliseconds of noise twice.
      src.start(t, Math.random() * 1.5);
      src.stop(t + 1.2);
    },
    boom(strength, gain = 1) {
      const s = Math.max(0, Math.min(1, strength));
      const g0 = Math.max(0, Math.min(1, gain));
      if (g0 < 0.01) return;
      const t = ctx.currentTime;
      // The body: a sine dropped through two octaves. This is the part you
      // feel rather than hear, and it is what separates an explosion from a
      // loud noise.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(26, t + 0.55);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.5 * (0.4 + s) * g0, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      osc.connect(og).connect(master);
      osc.start(t);
      osc.stop(t + 1);
      // The crack and the roll: broadband at the front, closing to a rumble.
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(5000, t);
      f.frequency.exponentialRampToValueAtTime(170, t + 1.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.42 * (0.3 + s) * g0, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
      src.connect(f).connect(g).connect(master);
      src.start(t, Math.random() * 1.5);
      src.stop(t + 1.5);
    },
    bubble(gain = 1) {
      const g0 = Math.max(0, Math.min(1, gain));
      if (g0 < 0.01) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const f0 = 360 + Math.random() * 540;
      osc.frequency.setValueAtTime(f0, t);
      // RISING, and that is the whole trick. A bubble's resonant frequency
      // climbs as it shrinks, so a falling blip sounds like a game menu and a
      // rising one sounds like air in water.
      osc.frequency.exponentialRampToValueAtTime(f0 * 2.3, t + 0.085);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.055 * g0, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.13);
    },
    setSubmerged(k) {
      const x = Math.max(0, Math.min(1, k));
      const t = ctx.currentTime;
      // Geometric, not linear. Frequency is heard logarithmically, so a linear
      // sweep from 20 kHz spends the first three quarters of its travel in a
      // range where nothing audible changes and then slams shut at the end.
      submerge.frequency.setTargetAtTime(20000 * Math.pow(360 / 20000, x), t, 0.1);
      // And a little quieter. Water is not just duller, it is further away.
      submergeGain.gain.setTargetAtTime(1 - 0.3 * x, t, 0.1);
    },
    setMuted(muted) {
      master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    },
    dispose() {
      void ctx.close();
    },
  };
}
