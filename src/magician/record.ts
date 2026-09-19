/**
 * Record the valley with everyone's voice in it.
 *
 * The canvas gives a video track; the ambience, Vibey's voice and the
 * visitor's own microphone are mixed into one audio track through a small
 * AudioContext; MediaRecorder writes a WebM. Stop returns a Blob and a
 * suggested filename, and the page hands it to the share sheet where there
 * is one, otherwise downloads it.
 *
 * Not for VR: inside an immersive session three renders to the XR layer's
 * framebuffer and the canvas is blank, so the headset's own recorder is the
 * tool there.
 */

export interface Recorder {
  start(): void;
  stop(): Promise<{ blob: Blob; name: string }>;
  recording(): boolean;
  seconds(): number;
}

export function createRecorder(canvas: HTMLCanvasElement, audioStreams: () => MediaStream[]): Recorder | null {
  if (typeof MediaRecorder === "undefined" || typeof (canvas as HTMLCanvasElement & { captureStream?: unknown }).captureStream !== "function") return null;
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let ctx: AudioContext | null = null;
  return {
    start() {
      if (rec) return;
      const video = canvas.captureStream(30);
      const tracks: MediaStreamTrack[] = [...video.getVideoTracks()];
      try {
        ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        let any = false;
        for (const s of audioStreams()) {
          if (!s || s.getAudioTracks().length === 0) continue;
          ctx.createMediaStreamSource(s).connect(dest);
          any = true;
        }
        if (any) tracks.push(...dest.stream.getAudioTracks());
      } catch {
        /* video only */
      }
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start(1000);
      startedAt = performance.now();
    },
    stop() {
      return new Promise((resolve) => {
        const r = rec;
        if (!r) { resolve({ blob: new Blob(), name: "magician.webm" }); return; }
        r.onstop = () => {
          const type = r.mimeType || "video/webm";
          const blob = new Blob(chunks, { type });
          rec = null;
          void ctx?.close().catch(() => undefined);
          ctx = null;
          const ext = type.includes("mp4") ? "mp4" : "webm";
          resolve({ blob, name: `magician-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}` });
        };
        r.stop();
      });
    },
    recording: () => rec !== null,
    seconds: () => (rec ? (performance.now() - startedAt) / 1000 : 0),
  };
}
