/**
 * Oni's door on the front page: the whole lobby in one card. Pick a name and
 * a character here and you land in the square already joined.
 */
import { useNavigate } from "react-router-dom";
import { JoinCard } from "./JoinCard";

export function OniLobbyCard({ className = "" }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <section
      className={`relative overflow-hidden rounded-3xl border border-[#ff5a3c]/30 p-4 text-white sm:p-5 ${className}`}
      style={{ background: "radial-gradient(120% 140% at 0% 0%, rgba(255,90,60,0.28) 0%, rgba(60,24,60,0.55) 45%, rgba(18,12,28,0.85) 100%)" }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-sm">
          <div className="text-[10px] uppercase tracking-[0.35em] text-[#ffb89a]">Play together · live now</div>
          <h2 className="mt-1 font-heading text-2xl font-bold">👹 Oni <span className="text-base font-normal text-white/60">鬼ごっこ</span></h2>
          <p className="mt-1 text-[13px] leading-snug text-white/70">
            Infection tag for the whole room. Everyone gets a random character; the oni has horns and anyone it touches grows them too. Last one without horns wins. Phones, laptops and VR in one square.
          </p>
          <div className="mt-2 flex gap-3 text-[11px] text-white/50">
            <a href="/oni?show" className="underline decoration-dotted underline-offset-4 hover:text-white">projector view</a>
            <a href="/oni?bots=6" className="underline decoration-dotted underline-offset-4 hover:text-white">practice with bots</a>
          </div>
        </div>
        <JoinCard onJoin={() => navigate("/oni?go=1")} cta="Join" size={84} />
      </div>
    </section>
  );
}
