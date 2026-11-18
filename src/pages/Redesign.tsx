/**
 * `/redesign/:id` — each of the three cover-art front doors on its own URL, for
 * linking or filming one. The homepage at `/` shows the same three with a
 * switcher (see `pages/Home.tsx`).
 *
 * Each direction is a whole, working homepage (real registry, real search,
 * real balance and price), so what gets picked is already built. The bar at
 * the bottom belongs to the picker, not to the design, and hides on `?bare`
 * so a direction can be filmed or framed without it.
 */
import { Suspense, useEffect } from "react";

import { DIRECTIONS } from "@/redesign/directions";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";


export default function Redesign() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const i = DIRECTIONS.findIndex((d) => d.id === id);

  useEffect(() => {
    if (i < 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      const step = e.key === "[" ? -1 : e.key === "]" ? 1 : 0;
      if (step) nav(`/redesign/${DIRECTIONS[(i + step + DIRECTIONS.length) % DIRECTIONS.length].id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, nav]);

  /* A fresh direction should open at its top, not at the scroll of the last. */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  if (i < 0) return <Navigate to="/redesign/arcade" replace />;
  const d = DIRECTIONS[i];
  const prev = DIRECTIONS[(i - 1 + DIRECTIONS.length) % DIRECTIONS.length];
  const next = DIRECTIONS[(i + 1) % DIRECTIONS.length];
  const Page = d.Component;

  return (
    <>
      <Suspense fallback={<div className="min-h-[100dvh] w-full bg-[#f4f9ff]" />}>
        <Page />
      </Suspense>
      {!params.has("bare") && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-[#0b1526]/90 p-1 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
            <Link to={`/redesign/${prev.id}`} aria-label={`Previous: ${prev.name}`} className="grid h-10 w-10 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            {DIRECTIONS.map((o) => (
              <Link
                key={o.id}
                to={`/redesign/${o.id}`}
                title={o.note}
                className={`rounded-full px-3.5 py-2 text-[13px] font-bold transition-colors ${
                  o.id === d.id ? "bg-white text-[#0b1526]" : "text-white/70 hover:text-white"
                }`}
              >
                {o.name}
              </Link>
            ))}
            <Link to={`/redesign/${next.id}`} aria-label={`Next: ${next.name}`} className="grid h-10 w-10 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white">
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
