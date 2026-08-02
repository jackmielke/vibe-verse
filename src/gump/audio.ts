/**
 * Everything you hear, synthesised. No files, for the usual reason: a
 * footstep here is *parameterised* — by surface, by speed, by whether there
 * are forty people running behind you — and a handful of recorded clips
 * cannot do that without sounding like a handful of recorded clips.
 *
 * There is also a tune. The bench theme is a slow arpeggiated figure that the
 * chapters borrow and transpose, which is the cheapest way to make six very
 * different scenes feel like one story: it is the same six notes in the
 * pizzeria, in the jungle and on the road across America.
 *
 * One AudioContext, one master gain, `dispose()` closes it. A world that leaks
 * an audio context makes the next world in the hub sound wrong.
 */

/** The bench figure, in semitones from the root. Pentatonic, so it can never
 *  land on a sour note however a chapter transposes it. */
const THEME = [0, 7, 12, 16, 19, 16, 12, 7];

export class GumpAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private disposed = false;
  private muted = false;

  /** Music scheduling state — see `tickMusic`. */
  private nextNote = 0;
  private step = 0;
  private root = 220;
  private tempo = 0.42;
  private musicOn = false;

  /** Loops that live longer than one note: rain, engine, crowd. */
  private loops = new Map<string, () => void>();

  /** Browsers will not start audio before a gesture; the bench is ours. */
  async resume() {
    if (this.disposed) return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.5;
      this.musicGain.connect(this.master);

      const len = Math.floor(this.ctx.sampleRate * 2);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.nextNote = this.ctx.currentTime;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  }

  get isMuted() {
    return this.muted;
  }

  private now() {
    return this.ctx?.currentTime ?? 0;
  }

  private env(node: AudioNode, gain: number, attack: number, decay: number, at = this.now()) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    return g;
  }

  private tone(
    freq: number,
    dur: number,
    gain: number,
    type: OscillatorType = "sine",
    at = this.now(),
    dest?: AudioNode,
  ) {
    if (!this.ctx || !this.master) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    const g = this.env(o, gain, Math.min(0.02, dur * 0.2), dur, at);
    g.connect(dest ?? this.master);
    o.start(at);
    o.stop(at + dur + 0.08);
  }

  private burst(gain: number, cutoff: number, dur: number, q = 1, type: BiquadFilterType = "lowpass") {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    f.Q.value = q;
    src.connect(f);
    const g = this.env(f, gain, 0.005, dur);
    g.connect(this.master);
    src.start();
    src.stop(this.now() + dur + 0.1);
  }

  /* --- the tune ---------------------------------------------------------- */

  /**
   * Start (or re-key) the theme. Chapters call this on entry: the jungle takes
   * it down a fifth and slows it, the finale opens it up and speeds it. Same
   * notes throughout, which is the point.
   */
  music(root: number, tempo: number) {
    this.root = root;
    this.tempo = tempo;
    this.musicOn = true;
    if (this.ctx) this.nextNote = Math.max(this.nextNote, this.ctx.currentTime);
  }

  stopMusic() {
    this.musicOn = false;
  }

  /**
   * Called every frame. Schedules ahead of the audio clock rather than firing
   * on the animation frame, because rAF jitter on a busy frame is audible as a
   * limp in the rhythm and scheduling ahead is not.
   */
  tickMusic() {
    if (!this.ctx || !this.musicOn || this.disposed) return;
    const ahead = this.ctx.currentTime + 0.3;
    while (this.nextNote < ahead) {
      const semis = THEME[this.step % THEME.length];
      const f = this.root * Math.pow(2, semis / 12);
      const at = this.nextNote;
      // A plucked-string-ish voice: a sine for body, a triangle an octave up
      // at a fifth of the level for the attack. Cheap, and it is not a beep.
      this.tone(f, this.tempo * 2.2, 0.1, "sine", at, this.musicGain!);
      this.tone(f * 2, this.tempo * 0.5, 0.02, "triangle", at, this.musicGain!);
      if (this.step % 8 === 0) this.tone(f / 2, this.tempo * 4, 0.07, "sine", at, this.musicGain!);
      this.step++;
      this.nextNote += this.tempo;
    }
  }

  /* --- one-shots --------------------------------------------------------- */

  /** A footfall. `surface` changes the filter, not the sample. */
  step_(surface: "dirt" | "grass" | "mud" | "road" | "wood", effort: number) {
    const cut = { dirt: 900, grass: 700, mud: 420, road: 2200, wood: 1500 }[surface];
    this.burst(0.07 + effort * 0.09, cut, surface === "mud" ? 0.16 : 0.07);
  }

  chocolate() {
    const at = this.now();
    this.tone(880, 0.09, 0.12, "triangle", at);
    this.tone(1320, 0.12, 0.09, "triangle", at + 0.05);
  }

  coin(pitch = 1) {
    const at = this.now();
    this.tone(1046 * pitch, 0.07, 0.1, "square", at);
    this.tone(1568 * pitch, 0.14, 0.08, "square", at + 0.04);
  }

  thud() {
    this.burst(0.4, 180, 0.24);
    this.tone(70, 0.3, 0.3, "sine");
  }

  whistle() {
    const at = this.now();
    this.tone(2100, 0.35, 0.09, "sine", at);
    this.tone(2650, 0.35, 0.06, "sine", at);
  }

  /** The braces. Steel hitting a dirt road, and then nothing holding you. */
  snap() {
    const at = this.now();
    this.burst(0.5, 4200, 0.18, 4, "bandpass");
    this.tone(1800, 0.1, 0.16, "square", at);
    this.tone(900, 0.22, 0.12, "square", at + 0.06);
    this.tone(440, 0.5, 0.1, "sine", at + 0.14);
  }

  /** Bat on ball. `power` is how hard you swung. */
  paddle(power: number) {
    this.burst(0.2 + power * 0.3, 2600 + power * 1800, 0.05, 6, "bandpass");
    this.tone(1400 + power * 700, 0.05, 0.1, "square");
  }

  splash() {
    this.burst(0.3, 1400, 0.5, 0.7, "highpass");
  }

  thunder() {
    this.burst(0.6, 220, 1.6, 0.5);
    this.tone(48, 1.4, 0.25, "sine");
  }

  /** A crowd of `n` people, cheering for `dur` seconds. */
  cheer(n: number, dur = 1.2) {
    const g = Math.min(0.35, 0.05 + n * 0.006);
    this.burst(g, 1100 + n * 4, dur, 0.6, "bandpass");
  }

  fanfare() {
    const at = this.now();
    [0, 4, 7, 12].forEach((s, i) => {
      this.tone(392 * Math.pow(2, s / 12), 0.5, 0.12, "triangle", at + i * 0.11);
    });
  }

  fail() {
    const at = this.now();
    [0, -3, -7].forEach((s, i) => {
      this.tone(330 * Math.pow(2, s / 12), 0.45, 0.14, "sawtooth", at + i * 0.15);
    });
  }

  /* --- loops ------------------------------------------------------------- */

  /**
   * A held bed of noise — rain, boat engine, the freeway. Returns nothing;
   * `stopLoop(key)` ends it. Keyed so a chapter cannot start two of its own.
   */
  loop(key: string, cutoff: number, gain: number, type: BiquadFilterType = "lowpass") {
    if (!this.ctx || !this.master || !this.noiseBuf || this.loops.has(key)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, this.now() + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.loops.set(key, () => {
      try {
        g.gain.cancelScheduledValues(this.now());
        g.gain.linearRampToValueAtTime(0, this.now() + 0.3);
        src.stop(this.now() + 0.4);
      } catch {
        /* already gone */
      }
    });
  }

  stopLoop(key: string) {
    this.loops.get(key)?.();
    this.loops.delete(key);
  }

  stopAllLoops() {
    for (const stop of this.loops.values()) stop();
    this.loops.clear();
  }

  dispose() {
    this.disposed = true;
    this.musicOn = false;
    this.stopAllLoops();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}
