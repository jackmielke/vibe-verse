/**
 * /gatch/<id>: one Gatch News clip somebody shared from Cannon Chase, on a
 * TV with its headline, and a way into the game.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadClip, type SharedClip } from "@/cannonrun/share";

export default function GatchClip() {
  const { id = "" } = useParams();
  const [clip, setClip] = useState<SharedClip | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    loadClip(id).then((c) => { if (live) setClip(c); }).catch(() => { if (live) setClip(null); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (clip) document.title = `GATCH NEWS: ${clip.headline}`; }, [clip]);

  const share = async (): Promise<void> => {
    const url = window.location.href;
    if (navigator.share) { try { await navigator.share({ title: `GATCH NEWS: ${clip?.headline ?? ""}`, url }); return; } catch { /* fall through */ } }
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* nothing to do */ }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-3 py-16 text-white" style={{ background: "radial-gradient(ellipse at 50% 70%, #3a2a1c 0%, #0b0f1c 65%)" }}>
      <div className="w-full max-w-3xl">
        <div className="overflow-hidden rounded-2xl bg-[#0d1020] ring-1 ring-white/15">
          <div className="flex items-center gap-2 bg-[#14182c] px-3 py-2">
            <span className="rounded bg-[#d8202a] px-2 py-0.5 text-[12px] font-black tracking-wide">GATCH NEWS</span>
            <span className="text-[12px] font-bold text-white/70">FROM CANNON CHASE</span>
          </div>
          {clip ? (
            <div className="relative bg-black">
              <video src={clip.video} className="block aspect-video w-full bg-black" autoPlay muted loop playsInline controls />
              <div className="pointer-events-none absolute inset-x-0 bottom-12 flex flex-col items-start px-3">
                <div className="bg-[#d8202a] px-2 py-0.5 text-[11px] font-black tracking-wider">BREAKING</div>
                <div className="bg-[#0a1230]/90 px-2 py-1 text-[15px] font-extrabold sm:text-[18px]">{clip.headline}</div>
                {clip.sub ? <div className="bg-[#0a1230]/80 px-2 py-0.5 text-[11px] text-white/75">{clip.sub}</div> : null}
              </div>
            </div>
          ) : (
            <div className="flex aspect-video items-center justify-center px-6 text-center text-[14px] text-white/60">
              {clip === undefined ? "Tuning in..." : "This story isn't on the air any more."}
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link to="/cannon-chase" className="rounded-full bg-[#ffd36a] px-6 py-2.5 text-[14px] font-black text-black">Play Cannon Chase ▶</Link>
          <Link to="/cannon-chase?story" className="rounded-full bg-white/10 px-5 py-2.5 text-[14px] font-semibold">Read the story</Link>
          {clip ? <button className="ml-auto rounded-full bg-white/10 px-5 py-2.5 text-[14px] font-semibold" onClick={share}>{copied ? "Link copied" : "Share"}</button> : null}
        </div>
      </div>
    </div>
  );
}
