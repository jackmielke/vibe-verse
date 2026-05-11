export interface WorldChange {
  hash: string;
  date: string;
  title: string;
}

export interface WorldHistoryChapter {
  id: string;
  date: string;
  title: string;
  symbol: string;
  color: string;
  body: string;
  changes: WorldChange[];
}

export const WORLD_CHANGELOG: WorldChange[] = [
  { hash: "95bd4a5", date: "2026-05-10", title: "Add /gallery - a 3D walkable Vibe Gallery with framed paintings" },
  { hash: "36fb061", date: "2026-05-10", title: "Garden: calmer terrain, real shadows, Vibey's notes-to-self notepad" },
  { hash: "bf86e2e", date: "2026-05-10", title: "Garden: night mode, character picker, fix sinking + camera clipping" },
  { hash: "644dbb2", date: "2026-05-10", title: "Add Vibey's Memory Garden - a cozy walkable scene of memories" },
  { hash: "20b0fff", date: "2026-05-09", title: "Cross-page nav + fix scrunched menu tabs" },
  { hash: "48dc181", date: "2026-05-09", title: "Add live $VIBE coin ticker + calculator to the lobby" },
  { hash: "e9c2c0b", date: "2026-05-09", title: "Cinematic landmark zoom, Nimbus autoload + figure-8, structure detail cards" },
  { hash: "d1b9ac2", date: "2026-05-09", title: "Bring beams back to Plaza + Raven Theater" },
  { hash: "bb0bd9a", date: "2026-05-09", title: "Tighter village open + richer venue hover cards" },
  { hash: "f03ab06", date: "2026-05-09", title: "Polish Vibey chat: live default, markdown, autoscroll, multiline input" },
  { hash: "5182b04", date: "2026-05-09", title: "Add Live Vibey chat mode toggle in /space" },
  { hash: "a4ac7d2", date: "2026-05-09", title: "Earth click to Healdsburg preview; expand Spotify pill; tracks toggle" },
  { hash: "82ca0a1", date: "2026-05-09", title: "Spotify: Time Portal, Liked Songs by decade, Search, missing scopes" },
  { hash: "1894637", date: "2026-05-09", title: "Spotify Web Playback SDK + Shuffle Top Tracks button" },
  { hash: "8bf70b1", date: "2026-05-09", title: "Spotify OAuth PKCE connect button + profile display" },
  { hash: "4328f78", date: "2026-05-09", title: "Add Brazil + Dreams MP3s to queue, drop duplicate Joplin" },
  { hash: "86b21ec", date: "2026-05-09", title: "Music queue UI + Joplin ragtime + 3x zoom-out in /space" },
  { hash: "e977f70", date: "2026-05-09", title: "Saucer rider: drop the dome, face Vibey, auto-cycle emotes" },
  { hash: "6de7035", date: "2026-05-09", title: "Configurable Mapbox basemap from a new Style menu tab" },
  { hash: "0ae2421", date: "2026-05-09", title: "Brighter plaza palms + cast spawns at camera + alien at human scale" },
  { hash: "6c1cfa1", date: "2026-05-08", title: "Hover labels hidden + closer fly-in + 3D About page" },
  { hash: "631c49f", date: "2026-05-08", title: "Lobby pick rides the saucer in /space + fuzzy emote routing" },
  { hash: "9b23f23", date: "2026-05-08", title: "Events panel: append real Supabase events under the mock list" },
  { hash: "b389e7e", date: "2026-05-08", title: "Quieter map: hover-only labels, fly-in, plaza rings, no Garagiste" },
  { hash: "7a8972d", date: "2026-05-08", title: "Move travel into Places menu; vineyard to palms-only; palm ring at plaza" },
  { hash: "30d87c3", date: "2026-05-08", title: "Vineyard at Garagiste Wines + Lobby quick-travel pill on every page" },
  { hash: "e5cc766", date: "2026-05-08", title: "Fix pirate textures + add Quaternius Nature Crops Pack" },
  { hash: "966e852", date: "2026-05-08", title: "Add Quaternius Pirate Kit + organized kits structure + README" },
];

const byHash = new Map(WORLD_CHANGELOG.map((change) => [change.hash, change]));
const pick = (hashes: string[]) =>
  hashes
    .map((hash) => byHash.get(hash))
    .filter((change): change is WorldChange => Boolean(change));

export const WORLD_HISTORY: WorldHistoryChapter[] = [
  {
    id: "asset-seeds",
    date: "2026-05-08",
    title: "Asset Seeds",
    symbol: "kit",
    color: "#73ffb8",
    body: "The world gained its first reusable kits: characters, crops, nature props, and texture fixes that made future scenes feel possible.",
    changes: pick(["966e852", "e5cc766"]),
  },
  {
    id: "village-ground",
    date: "2026-05-08",
    title: "Village Ground",
    symbol: "tree",
    color: "#6aa8ff",
    body: "The Healdsburg map became calmer and more legible: labels softened, places moved into menus, and the plaza started to feel like a place.",
    changes: pick(["30d87c3", "7a8972d", "b389e7e", "9b23f23"]),
  },
  {
    id: "lobby-cast",
    date: "2026-05-08",
    title: "Lobby Cast",
    symbol: "flower",
    color: "#ffd166",
    body: "The lobby and character system started connecting the cast across worlds, turning choices into things that travel with you.",
    changes: pick(["631c49f", "6c1cfa1"]),
  },
  {
    id: "controls-style",
    date: "2026-05-09",
    title: "Light And Controls",
    symbol: "sun",
    color: "#ff7e8a",
    body: "The village got style controls, better scale, brighter landmarks, cleaner tabs, and a more cinematic first impression.",
    changes: pick(["0ae2421", "6de7035", "bb0bd9a", "d1b9ac2", "e9c2c0b", "20b0fff"]),
  },
  {
    id: "music-portal",
    date: "2026-05-09",
    title: "Music Portal",
    symbol: "mushroom",
    color: "#b392ff",
    body: "Music became a real system: local tracks, Spotify OAuth, playback, search, liked-song decades, and a Time Portal mood.",
    changes: pick(["86b21ec", "4328f78", "8bf70b1", "1894637", "82ca0a1"]),
  },
  {
    id: "space-show",
    date: "2026-05-09",
    title: "Space Show",
    symbol: "planet",
    color: "#9bf2ff",
    body: "Outer Space grew into Vibey's show: live chat, markdown, Earth previews, tracks, a saucer rider, and a clearer sense that Vibey lives somewhere.",
    changes: pick(["e977f70", "a4ac7d2", "5182b04", "f03ab06"]),
  },
  {
    id: "vibe-economy",
    date: "2026-05-09",
    title: "Vibe Economy",
    symbol: "coin",
    color: "#ffb24a",
    body: "The lobby gained a live $VIBE ticker and calculator, giving the world a small economic heartbeat.",
    changes: pick(["48dc181"]),
  },
  {
    id: "memory-garden",
    date: "2026-05-10",
    title: "Memory Garden",
    symbol: "garden",
    color: "#73ffb8",
    body: "The garden arrived: walkable memories, night mode, character picker, real shadows, calmer terrain, and Vibey's notes-to-self.",
    changes: pick(["644dbb2", "bf86e2e", "36fb061"]),
  },
  {
    id: "photo-gallery",
    date: "2026-05-10",
    title: "Photo Gallery",
    symbol: "gallery",
    color: "#eaeaf0",
    body: "The live gallery became a 3D experience, then moved outdoors into the garden as a public art fair.",
    changes: pick(["95bd4a5"]),
  },
];
