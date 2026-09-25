/**
 * The festival's sounds, all synthesised: a taiko for every tag, a count-in,
 * a gong for the start, a squeaky honk, a fanfare in the yo scale, and a
 * drum under the chase that quickens as the clock runs out.
 */
export type Sfx = ReturnType<typeof createSfx>;

export function createSfx() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;

  function ac(): AudioContext | null {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch { ctx = null; }
    return ctx;
  }

  function env(g: GainNode, at: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  function taiko(gain = 1, pitch = 1, when = 0) {
    const c = ac(); if (!c || !master) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(95 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(48 * pitch, t + 0.35);
    const g = c.createGain(); env(g, t, 0.9 * gain, 0.005, 0.5);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.6);
    const n = c.createBufferSource(); n.buffer = noise;
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
    const ng = c.createGain(); env(ng, t, 0.35 * gain, 0.002, 0.08);
    n.connect(f).connect(ng).connect(master); n.start(t); n.stop(t + 0.15);
  }

  function tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0) {
    const c = ac(); if (!c || !master) return;
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain(); env(g, t, gain, 0.01, dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
  }

  let drumTimer: number | null = null;
  let drumUrgency = 0;
  const drumLoop = () => {
    // Don-don-ka, faster as time runs out.
    taiko(0.35, 1);
    taiko(0.25, 1.15, 0.18);
    const gap = 900 - drumUrgency * 520;
    drumTimer = window.setTimeout(drumLoop, gap);
  };

  return {
    resume() { const c = ac(); if (c && c.state === "suspended") void c.resume(); },
    setMuted(m: boolean) { muted = m; if (master) master.gain.value = m ? 0 : 0.8; },
    muted: () => muted,
    /** Somebody got tagged; louder if it was us or by us. */
    tag(close: boolean) {
      taiko(close ? 1.2 : 0.55, close ? 0.9 : 1.1);
      if (close) { taiko(0.9, 0.8, 0.12); tone(220, 0.5, "sawtooth", 0.08); tone(165, 0.6, "sawtooth", 0.06, 0.08); }
    },
    count(n: number) { tone(n > 0 ? 660 : 990, n > 0 ? 0.18 : 0.5, "triangle", 0.25); },
    gong() {
      const c = ac(); if (!c) return;
      for (const [f, g] of [[110, 0.3], [164, 0.18], [233, 0.12], [311, 0.08]] as const) tone(f, 2.6, "sine", g);
      taiko(1.1, 0.85);
    },
    honk() {
      const c = ac(); if (!c || !master) return;
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = "square";
      o.frequency.setValueAtTime(520, t);
      o.frequency.exponentialRampToValueAtTime(880, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(600, t + 0.22);
      const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 2;
      const g = c.createGain(); env(g, t, 0.35, 0.01, 0.25);
      o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + 0.3);
    },
    jump() { tone(420, 0.12, "sine", 0.08); tone(630, 0.1, "sine", 0.06, 0.05); },
    fanfare() {
      // Yo scale: D E G A B.
      const notes = [587, 659, 784, 880, 988, 1175];
      notes.forEach((f, i) => tone(f, 0.35, "triangle", 0.18, i * 0.11));
      tone(1175, 1.2, "sine", 0.12, notes.length * 0.11);
      taiko(0.9, 1, 0); taiko(0.9, 1, 0.33);
    },
    drum(on: boolean, urgency = 0) {
      drumUrgency = Math.max(0, Math.min(1, urgency));
      if (on && drumTimer === null) drumLoop();
      if (!on && drumTimer !== null) { clearTimeout(drumTimer); drumTimer = null; }
    },
    dispose() {
      if (drumTimer !== null) clearTimeout(drumTimer);
      drumTimer = null;
      void ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}
