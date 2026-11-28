/**
 * Which course this Vibe Kart session races.
 *
 * Read once from the address: `/rainbow-road`, `/prism-skyway` or
 * `?track=prism` (also `rainbow`) race Prism Skyway; everything else races
 * Sunset Bluff. A course is chosen before the engine boots, because the track,
 * the scenery and the light are all built for it; changing course is a page
 * navigation, which is also what makes a course a link you can share.
 */
export type KartCourse = "sunset" | "prism";

export const PRISM_PATHS = ["/rainbow-road", "/prism-skyway", "/skyway"];

export function kartCourse(): KartCourse {
  if (typeof window === "undefined") return "sunset";
  const path = window.location.pathname.replace(/\/+$/, "");
  if (PRISM_PATHS.includes(path)) return "prism";
  const t = new URLSearchParams(window.location.search).get("track")?.toLowerCase();
  return t === "prism" || t === "rainbow" || t === "skyway" ? "prism" : "sunset";
}

/** Where to send somebody who wants the other course, keeping any room code. */
export function courseHref(course: KartCourse, room?: string | null): string {
  const base = course === "prism" ? "/rainbow-road" : "/kart";
  return room ? `${base}?room=${encodeURIComponent(room)}` : base;
}

/** Rooms are per course, so two friends on different courses never share a grid. */
export function coursePrefix(): string {
  return kartCourse() === "prism" ? "prism-" : "";
}
