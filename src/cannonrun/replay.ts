/**
 * Gatch News keeps the tape rolling, shot from Chopper 7 (the engine draws
 * the chopper's view and the broadcast graphics into the canvas given here). Every time a bulletin goes out (a new
 * ride, a wreck, the henchmen, the train, the diner), the canvas is recorded
 * for a few seconds, so after the run there is a reel of everything that
 * happened to rewatch, headline by headline. Jack, Nov 2026: "I want on News
 * just to record everything that happened so you can rewatch it afterwards."
 *
 * One recorder at a time: a bulletin that lands while a clip is rolling just
 * keeps it rolling a little longer and adds its headline. Clips are blobs in
 * memory, capped in number and length, and freed on restart and dispose.
 */
export interface ReplayClip {
  url: string;
  /** the headlines that went out while it was rolling, first one first */
  headlines: { headline: string; sub: string }[];
  /** seconds into the run when it started */
  at: number;
  type: string;
}

const MAX_CLIPS = 16;
const MAX_LEN = 14;

export class Replay {
  clips: ReplayClip[] = [];
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stopAt = 0;
  private cur: Omit<ReplayClip, "url"> | null = null;
  private stream: MediaStream | null = null;
  private readonly mime: string;
  readonly ok: boolean;

  constructor(private canvas: HTMLCanvasElement) {
    const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
    this.mime = MR ? types.find((t) => { try { return MR.isTypeSupported(t); } catch { return false; } }) ?? "" : "";
    this.ok = !!MR && !!this.mime && typeof canvas.captureStream === "function";
  }

  /** A bulletin went out at `now` (seconds into the run): roll tape for `secs`. */
  mark(now: number, headline: string, sub: string, secs = 6): void {
    if (!this.ok) return;
    if (this.rec && this.cur) {
      if (!this.cur.headlines.some((h) => h.headline === headline)) this.cur.headlines.push({ headline, sub });
      this.stopAt = Math.min(this.cur.at + MAX_LEN, Math.max(this.stopAt, now + secs));
      return;
    }
    try {
      this.stream = this.stream ?? this.canvas.captureStream(24);
      const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 1_400_000 });
      this.chunks = [];
      this.cur = { headlines: [{ headline, sub }], at: now, type: this.mime.split(";")[0] };
      const meta = this.cur;
      rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: meta.type });
        this.chunks = [];
        if (blob.size < 2000) return;
        this.clips.push({ ...meta, url: URL.createObjectURL(blob) });
        // keep the first clip (how it started) and the latest ones
        while (this.clips.length > MAX_CLIPS) { const [gone] = this.clips.splice(1, 1); URL.revokeObjectURL(gone.url); }
      };
      rec.start(500);
      this.rec = rec;
      this.stopAt = now + secs;
    } catch {
      this.rec = null;
      this.cur = null;
    }
  }

  /** true while a clip is being recorded (the engine only films the chopper shot then) */
  get rolling(): boolean { return !!this.rec; }

  /** Call every frame with the run clock. */
  tick(now: number): void {
    if (this.rec && now >= this.stopAt) this.cut();
  }

  /** Stop whatever is rolling (the run is over). */
  cut(): void {
    const r = this.rec;
    this.rec = null;
    this.cur = null;
    if (r && r.state !== "inactive") { try { r.stop(); } catch { /* already stopped */ } }
  }

  clear(): void {
    this.cut();
    for (const c of this.clips) URL.revokeObjectURL(c.url);
    this.clips = [];
  }

  dispose(): void {
    this.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
