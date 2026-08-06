/**
 * The arcade's noises. One oscillator at a time, built on demand.
 *
 * Worth writing rather than importing `citySounds`: that module boots a reverb
 * bus and a music layer for a world you walk around in, and this is three
 * cabinets that need a blip, a chime and a coin drop. More to the point, it has
 * to be *closeable* — browsers cap live AudioContexts the same way they cap
 * WebGL contexts, and a page that leaks one breaks audio in the next world the
 * visitor opens.
 */
export interface ArcadeSounds {
  blip(semitone?: number): void;
  chime(): void;
  thud(): void;
  coin(): void;
  fanfare(): void;
  close(): void;
}

export function createArcadeSounds(): ArcadeSounds {
  let ctx: AudioContext | null = null;

  /* Lazily created on the first sound, which is always inside a click handler
     — browsers will not let a context start outside a gesture, and creating it
     on mount just produces a suspended context and a console warning. */
  function ac(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  function tone(freq: number, dur: number, type: OscillatorType, gain = 0.09, delay = 0) {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.04);
  }

  const A4 = 440;
  const note = (semi: number) => A4 * Math.pow(2, semi / 12);

  return {
    blip: (semi = 0) => tone(note(semi), 0.08, "square", 0.05),
    chime: () => {
      tone(note(7), 0.18, "triangle", 0.08);
      tone(note(12), 0.22, "triangle", 0.05, 0.04);
    },
    thud: () => tone(90, 0.22, "sawtooth", 0.09),
    /* The coin drop. Two clacks and a ring — the sound that tells you the
       machine took your money, which is the moment the ledger actually moved. */
    coin: () => {
      tone(1180, 0.05, "square", 0.06);
      tone(1560, 0.05, "square", 0.05, 0.055);
      tone(2100, 0.16, "triangle", 0.04, 0.1);
    },
    fanfare: () => {
      [0, 4, 7, 12].forEach((s, i) => tone(note(s), 0.3, "triangle", 0.075, i * 0.085));
    },
    close: () => {
      if (ctx) void ctx.close().catch(() => { /* already closed */ });
      ctx = null;
    },
  };
}
