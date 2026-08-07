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
          <div className="min-h-full flex flex-col items-center justify-center px-4 py-10 gap-6">
            <motion.div
              className="text-center space-y-1"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-wide text-gradient-mint">
                Choose your world
              </h1>
              <p className="text-xs text-muted-foreground tracking-[0.18em] uppercase">
                {WORLDS.length} doors · one browser tab
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="w-full max-w-md"
            >
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search worlds…"
                className="w-full glass-panel rounded-full border border-border/60 px-4 py-2 text-sm bg-background/40 focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground/70"
              />
            </motion.div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 max-w-4xl w-full">
              {filtered.map((w, i) => (
                <motion.button
                  key={w.key}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 * i, duration: 0.35 }}
                  onClick={() => {
                    navigate(w.route);
                    onClose();
                  }}
                  className={`group glass-panel rounded-2xl overflow-hidden text-left border transition-colors ${
                    w.featured
                      ? "col-span-2 lg:col-span-3 border-transparent"
                      : "border-border/40 hover:border-primary/60"
                  }`}
                  style={w.featured ? { boxShadow: `inset 0 0 0 1.5px ${w.accent}66` } : undefined}
                >
                  <div
                    className={`relative overflow-hidden bg-black/40 ${
                      w.featured ? "aspect-[16/7]" : "aspect-video"
                    }`}
                  >
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
                    {/* Featured worlds always explain themselves. Hiding the
                        blurb on small screens meant a card could say only "The
                        Terminal" on a phone — a name is not an explanation, and
                        the whole job of this screen is telling you what is
                        behind each door. */}
                    <div
                      className={`text-[11px] text-muted-foreground leading-snug mt-0.5 ${
                        w.featured ? "block" : "hidden sm:block"
                      }`}
                    >
                      {w.blurb}
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>

            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              onClick={onClose}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ close
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Portalled to <body> so it floats above whatever world is already running.
  return createPortal(body, document.body);
}
