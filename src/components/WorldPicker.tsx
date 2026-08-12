/**
 * WorldPicker — the "choose your world" overlay.
 *
 * Opens over whatever world you are already in, from the ⋯ menu in GlobalNav
 * and once per session on the village map. Lists EVERY world as a preview card,
 * featured-first. Clicking a card routes straight there.
 *
 * **Overlay only.** It used to double as a full page for "/" and "/worlds",
 * which is where a real bug lived: as a page, `onClose` navigated somewhere,
 * and the card handler called `navigate(world)` and then `onClose()` in the
 * same tick — so the second navigation won and every card on the homepage took
 * you to the Terminal instead of to the world you tapped. The grid page is
 * `src/pages/Game.tsx` now, and it uses plain links.
 *
 * The list itself is `src/worlds/registry.ts`. This component used to keep its
 * own copy, as did the nav, the hub and the Terminal, and the four of them
 * disagreed about which worlds exist. Now there is one list and several views
 * of it. Card art is keyed off the world's `key` in `src/worlds/art.ts`.
 */
import { createPortal } from "react-dom";
import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { WORLDS, featuredFirst, type WorldEntry } from "@/worlds/registry";
import { artFor } from "@/worlds/art";
import { exactLabel, sinceLabel, updatedAt } from "@/worlds/freshness";

export default function WorldPicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  /* Escape closes it. This overlay covers the entire viewport and used to be
     openable only from a menu that no longer exists; now that "/" opens it from
     any page, the one thing it must not be is a room with a single door
     somebody has to go looking for. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const here = (w: WorldEntry) =>
    w.route.split("?")[0] === location.pathname && !w.route.includes("?");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? WORLDS.filter(
          (w) => w.name.toLowerCase().includes(q) || w.blurb.toLowerCase().includes(q),
        )
      : WORLDS;
    // Featured worlds lead. Stable within each group so the rest keeps its
    // hand-tuned order.
    return featuredFirst(list);
  }, [query]);

  const body = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 overflow-y-auto bg-background/85 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.4 } }}
        >
          <div className="min-h-full px-4 pb-12">
            {/* The way out, and the way to narrow it down, pinned to the top.
                Both used to be at the ends of a fifty-two card scroll: the
                close button was the *last* element on the page, so leaving
                meant scrolling past every world in the vibeverse to find it,
                and the search field scrolled away the moment you started
                looking. A full-screen overlay has to keep its exit in view. */}
            <div className="sticky top-0 z-10 -mx-4 mb-5 border-b border-border/40 bg-background/80 px-4 py-3 backdrop-blur-xl">
              <div className="mx-auto flex max-w-6xl items-center gap-3">
                <div className="hidden min-w-0 sm:block">
                  <h1 className="font-heading text-sm font-bold tracking-wide text-gradient-mint">
                    Choose your world
                  </h1>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    {filtered.length === WORLDS.length
                      ? `${WORLDS.length} doors · one browser tab`
                      : `${filtered.length} of ${WORLDS.length}`}
                  </p>
                </div>

                <div className="relative min-w-0 flex-1 sm:max-w-sm">
                  <Search
                    className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50"
                    aria-hidden
                  />
                  <input
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search worlds…"
                    aria-label={`Search ${WORLDS.length} worlds`}
                    className="w-full appearance-none rounded-full border border-border/60 bg-background/50 py-2 pl-9 pr-4 text-sm placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                  />
                </div>

                <button
                  onClick={onClose}
                  aria-label="Close search"
                  title="Close (Esc)"
                  className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            {/* Every card the same size.
                Featured worlds used to span the full width at a different
                aspect ratio, so a list with several of them read as one column
                of banners with the occasional pair squeezed beside it — the
                grid looked broken rather than emphasised. They keep their
                accent ring, which says "start here" without rearranging
                everything around them. */}
            <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {filtered.map((w, i) => (
                <motion.button
                  key={w.key}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  /* Capped. At `0.05 * i` the fifty-second card began appearing
                     two and a half seconds in, so the bottom of the list stayed
                     blank for longer than it took to scroll there. */
                  transition={{ delay: Math.min(i, 11) * 0.03, duration: 0.3 }}
                  onClick={() => {
                    navigate(w.route);
                    onClose();
                  }}
                  className={`group glass-panel overflow-hidden rounded-2xl border text-left transition-colors ${
                    w.featured ? "border-transparent" : "border-border/40 hover:border-primary/60"
                  }`}
                  style={w.featured ? { boxShadow: `inset 0 0 0 1.5px ${w.accent}66` } : undefined}
                >
                  <div className="relative aspect-video overflow-hidden bg-black/40">
                    {artFor(w.key) ? (
                      <img
                        src={artFor(w.key)}
                        alt={w.name}
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div
                        className="w-full h-full"
                        style={{
                          background:
                            `radial-gradient(120% 90% at 18% 0%, ${w.accent}44, transparent 62%),` +
                            "linear-gradient(178deg, #11151d 0%, #080a0f 70%)",
                        }}
                      >
                        <svg
                          viewBox="0 0 160 60"
                          preserveAspectRatio="none"
                          className="absolute inset-x-0 bottom-0 h-1/2 w-full opacity-30"
                          aria-hidden
                        >
                          <path
                            d="M0 60V44h9V33h7v11h6V26h8v18h5V36h9v8h7V20h8v24h6V31h10v13h7V38h8v6h6V28h9v16h7v-9h8v9h6V33h9v11h7V41h8v19z"
                            fill={w.accent}
                          />
                        </svg>
                      </div>
                    )}
                    {w.status && (
                      <span
                        className="absolute bottom-2 left-2 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-black"
                        style={{ background: w.accent }}
                      >
                        {w.status}
                      </span>
                    )}
                    {here(w) && (
                      <span className="absolute top-2 right-2 rounded-full bg-primary/80 text-primary-foreground text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5">
                        you're here
                      </span>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-baseline gap-2">
                      <div className="font-heading font-semibold text-sm">
                        {w.emoji} {w.name}
                      </div>
                      {sinceLabel(updatedAt(w.key)) && (
                        <span
                          title={exactLabel(updatedAt(w.key)) ?? undefined}
                          className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50"
                        >
                          {sinceLabel(updatedAt(w.key))}
                        </span>
                      )}
                    </div>
                    {/* Two lines, on every card, at every width. A name is not
                        an explanation and the whole job of this screen is
                        telling you what is behind each door — but an unbounded
                        blurb in a two-column phone grid makes every row as tall
                        as its wordiest card. */}
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {w.blurb}
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>

            {filtered.length === 0 && (
              <p className="mt-16 text-center text-sm text-muted-foreground">
                Nothing matches “{query}”.
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Portalled to <body> so it floats above whatever world is already running.
  return createPortal(body, document.body);
}
