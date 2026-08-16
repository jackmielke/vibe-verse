/**
 * Fifteen front doors, and the list of them.
 *
 * `/homes` is a bake-off. Each entry is a whole page — its own layout, type,
 * palette and card — rather than a skin over one design, because fifteen
 * token-swaps of the same page tell you nothing you could not have guessed from
 * a swatch. The differences have to be structural to be worth looking at.
 *
 * Every theme is `lazy()`, and that is not optional here: eagerly importing
 * fifteen pages would put all of them in the chunk that has to paint before you
 * see the first one. The same rule the rest of the router follows, for the same
 * reason — see `CLAUDE.md`.
 *
 * `mood` and `note` are for the picker, so the list can be read before it is
 * clicked through. `palette` is three colours that genuinely appear on the
 * page, drawn as a swatch — an honest thumbnail is worth more than a
 * screenshot that goes stale the first time somebody edits a theme.
 */
import { lazy, type LazyExoticComponent, type ComponentType } from "react";

export interface HomeTheme {
  id: string;
  name: string;
  /** Two or three words. What kind of thing this is. */
  mood: string;
  /** One sentence, in the picker. Say what it is betting on. */
  note: string;
  /** Three colours that actually appear on the page. */
  palette: [string, string, string];
  Component: LazyExoticComponent<ComponentType>;
}

export const HOME_THEMES: HomeTheme[] = [
  {
    id: "midnight",
    name: "Midnight",
    mood: "Cinematic night",
    note: "A moon behind cloud, glass nav, and a dashboard strip. Closest to the mock.",
    palette: ["#05070d", "#e2ecff", "#7dffd4"],
    Component: lazy(() => import("@/home/themes/Midnight")),
  },
  {
    id: "alpine",
    name: "Alpine",
    mood: "Travel poster",
    note: "Flat colour, a hard diagonal horizon, type set enormous. Five colours, no photographs in the furniture.",
    palette: ["#f3ead9", "#2f6f8f", "#e8622c"],
    Component: lazy(() => import("@/home/themes/Alpine")),
  },
  {
    id: "editorial",
    name: "Editorial",
    mood: "Design annual",
    note: "Serif on cream, an opening plate, and a contents page. Bets that worlds look valuable when nothing glows.",
    palette: ["#faf7f0", "#171412", "#8a7a5c"],
    Component: lazy(() => import("@/home/themes/Editorial")),
  },
  {
    id: "zine",
    name: "Zine",
    mood: "Pinned wall",
    note: "The mood board as the front door — taped, tilted, nothing lines up. Angles are seeded, so it is the same wall every time.",
    palette: ["#080808", "#ffffff", "#b8b8b8"],
    Component: lazy(() => import("@/home/themes/Zine")),
  },
  {
    id: "terminal",
    name: "Terminal",
    mood: "Directory listing",
    note: "No pictures at all. Fifty-three worlds you can read top to bottom in ten seconds.",
    palette: ["#020604", "#7dffd4", "#0b3b2c"],
    Component: lazy(() => import("@/home/themes/Terminal")),
  },
  {
    id: "aurora",
    name: "Aurora",
    mood: "Glass bento",
    note: "Tiles in three sizes over a slow gradient, so the grid tells you where to start.",
    palette: ["#0a0716", "#a78bfa", "#22d3ee"],
    Component: lazy(() => import("@/home/themes/Aurora")),
  },
  {
    id: "riso",
    name: "Riso",
    mood: "Two-ink print",
    note: "Fluorescent pink and blue, off-register, halftone. Art is duotoned by blending, not by a filter.",
    palette: ["#f7f4ea", "#ff48b0", "#1a4bd6"],
    Component: lazy(() => import("@/home/themes/Riso")),
  },
  {
    id: "field",
    name: "Field",
    mood: "Trail guide",
    note: "No grid at all — worlds hang off one dotted route, and the passport is the whole point.",
    palette: ["#e8dfcc", "#2a2620", "#4a6d4a"],
    Component: lazy(() => import("@/home/themes/Field")),
  },
  {
    id: "neon",
    name: "Neon",
    mood: "Arcade cabinet",
    note: "Attract mode: the marquee plays itself, and hovering a card swaps the still for gameplay.",
    palette: ["#07060c", "#22e6ff", "#ff2fb0"],
    Component: lazy(() => import("@/home/themes/Neon")),
  },
  {
    id: "gallery",
    name: "Gallery",
    mood: "Museum wall",
    note: "Four works hung with brass plaques and a salon wall behind. The whitespace is the design.",
    palette: ["#f2efe9", "#3d3a34", "#8c7434"],
    Component: lazy(() => import("@/home/themes/Gallery")),
  },
  {
    id: "swiss",
    name: "Swiss",
    mood: "International style",
    note: "A visible twelve-column grid, one typeface, one red. Nothing on the page is positioned by eye.",
    palette: ["#fafafa", "#111111", "#e2231a"],
    Component: lazy(() => import("@/home/themes/Swiss")),
  },
  {
    id: "blueprint",
    name: "Blueprint",
    mood: "Technical drawing",
    note: "Cyanotype, dimension lines, and a title block filled in with what the repo actually knows.",
    palette: ["#0d2a5c", "#dceaff", "#7fa8dd"],
    Component: lazy(() => import("@/home/themes/Blueprint")),
  },
  {
    id: "sunrise",
    name: "Sunrise",
    mood: "One long sky",
    note: "Violet to peach top to bottom, and no boxes anywhere — the honest test of whether the art is good.",
    palette: ["#241539", "#cf6146", "#fbe3c4"],
    Component: lazy(() => import("@/home/themes/Sunrise")),
  },
  {
    id: "console",
    name: "Console",
    mood: "Ten-foot interface",
    note: "Hero and side-scrolling rails, driven by the arrow keys. The only one you can use without a mouse.",
    palette: ["#0c0f14", "#4ade80", "#e6edf5"],
    Component: lazy(() => import("@/home/themes/Console")),
  },
  {
    id: "storybook",
    name: "Storybook",
    mood: "Picture book",
    note: "A book opened flat, one world per spread, an index at the back. The only layout with a beginning.",
    palette: ["#fdf6e8", "#3b2f26", "#c0442f"],
    Component: lazy(() => import("@/home/themes/Storybook")),
  },
];

export const themeById = (id: string | undefined): HomeTheme | undefined =>
  HOME_THEMES.find((t) => t.id === id);

/** Next/previous, wrapping — the picker's arrows never dead-end. */
export function stepTheme(id: string, dir: 1 | -1): HomeTheme {
  const i = HOME_THEMES.findIndex((t) => t.id === id);
  const n = HOME_THEMES.length;
  return HOME_THEMES[((i < 0 ? 0 : i) + dir + n) % n];
}
