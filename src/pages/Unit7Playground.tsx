import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import VibeyJournal from "@/components/VibeyJournal";
import {
  playSound,
  isMuted as soundsMuted,
  toggleMuted as toggleSoundsMuted,
  ensureAudioRunning,
} from "@/lib/vibey-sounds";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ArrowLeft, Send, Bot, X, MessageCircle, Volume2, VolumeX, SkipForward, SkipBack, Play, Pause, ArrowDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  loginWithSpotify,
  isConnected as spotifyIsConnected,
  spotifyFetch,
  logout as spotifyLogout,
  type SpotifyProfile,
} from "@/lib/spotify";
import SpotifyPlayer from "@/components/SpotifyPlayer";
import { MAPBOX_TOKEN, VILLAGE_CENTER } from "@/config/mapbox";
import { enableVR } from "@/lib/webxr";
import unit7ModelUrl from "@/assets/glb/robot-expressive.glb";
import iridescentArcUrl from "@/assets/glb/iridescent-arc.glb";
import floatingAstronautUrl from "@/assets/glb/floating-astronaut.glb";
import floatingIslandUrl from "@/assets/glb/floating-island.glb";
import pixelTouchUrl from "@/assets/glb/pixel-touch.glb";
import rockyUrl from "@/assets/glb/rocky.glb";
import alienUrl from "@/assets/glb/alien.glb";

// Every lobby character is resolved as a Vite asset URL so we can pick
// one at runtime based on the user's lobby selection. Same auto-glob
// pattern the Lobby page uses.
const LOBBY_CHARACTER_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

// Convenience lookup by character base filename (no extension) so
// disco mode can pull specific dancers by name. e.g. QUATERNIUS_CHARS.Wizard.
const QUATERNIUS_CHARS: Record<string, string> = Object.fromEntries(
  Object.entries(LOBBY_CHARACTER_URLS).map(([path, url]) => {
    const name = path.split("/").pop()?.replace(/\.glb$/, "") ?? "";
    return [name, url];
  }),
);
import type {
  Unit7AnimName,
  Unit7Expression,
} from "@/components/map/Unit7Layer";
import { supabase } from "@/integrations/supabase/client";

// ---------- Soundtrack -------------------------------------------------
// Real public-domain recordings hosted by Wikimedia Commons. Their CDN
// serves them with `Access-Control-Allow-Origin: *`, so a plain
// <audio> element streams them directly — no asset bloat in our repo,
// no licensing question. To swap in your own track, drop an mp3/ogg
// into public/audio/ and prepend it to TRACKS as `/audio/yourfile.mp3`.

interface Track {
  title: string;
  artist: string;
  src: string;
}

// Public-domain playlist streamed from Wikimedia Commons. Disco-era
// Michael Jackson / Bee Gees / Earth Wind & Fire is all still
// copyrighted and can't be legally embedded — what's PD is pre-1925
// jazz + ragtime (Scott Joplin etc.) + everything classical. The
// Joplin tracks bring some groove. Drop your own MP3s into
// public/audio/ and add an entry here for licensed music.
const TRACKS: Track[] = [
  // ---- User-supplied MP3s in public/audio (full licensed catalog).
  // Drop more files into public/audio/ and prepend an entry here.
  {
    title: "Brazil",
    artist: "Declan McKenna",
    src: "/audio/declan-mckenna-brazil.mp3",
  },
  {
    title: "Dreams",
    artist: "Fleetwood Mac",
    src: "/audio/fleetwood-mac-dreams.mp3",
  },
  // ---- Joplin ragtime — peppy, danceable, public domain ----
  {
    title: "The Entertainer",
    artist: "Scott Joplin",
    src: "https://upload.wikimedia.org/wikipedia/commons/6/62/Scott_Joplin_-_The_Entertainer_%281902%29.ogg",
  },
  // ---- Mozart / Debussy — classical, melodic, PD ----
  {
    title: "Concerto No. 12 in A — Andante",
    artist: "Mozart",
    src: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Mozart%3B_Concerto_No._12_in_A-_II._Andante.ogg",
  },
  {
    title: "Eine kleine Nachtmusik — Allegro",
    artist: "Mozart",
    src: "https://upload.wikimedia.org/wikipedia/commons/2/24/Mozart_-_Eine_kleine_Nachtmusik_-_1._Allegro.ogg",
  },
  {
    title: "Symphony No. 40 — Molto allegro",
    artist: "Mozart",
    src: "https://upload.wikimedia.org/wikipedia/commons/9/99/Wolfgang_Amadeus_Mozart_-_Symphony_40_g-moll_-_1._Molto_allegro.ogg",
  },
  {
    title: "Clair de lune",
    artist: "Debussy",
    src: "https://upload.wikimedia.org/wikipedia/commons/b/be/Clair_de_lune_%28Claude_Debussy%29_Suite_bergamasque.ogg",
  },
];

// ---------- Conversation logic ------------------------------------------
// Keyword-based intent inference. Same shape as the in-map dialog so the
// playground feels consistent. Each intent has an animation OR an
// expression and a canned response.

type Intent = {
  anim?: Unit7AnimName;
  expr?: Unit7Expression;
  reply: string;
};

const INTENTS: { match: RegExp; intent: Intent }[] = [
  { match: /\b(angry|mad|furious|grr|piss(ed)?)\b/, intent: { expr: "Angry", reply: "Don't make me angry. You wouldn't like me when I'm angry." } },
  { match: /\b(surprised|wow|whoa|omg|wtf)\b/, intent: { expr: "Surprised", reply: "Whoa! I did not see that coming." } },
  { match: /\b(sad|sorry|bummed|miss)\b/, intent: { expr: "Sad", reply: "Sometimes I just feel a little blue. Out here in the dark." } },
  { match: /\b(hi|hello|hey|sup|yo)\b/, intent: { anim: "Wave", reply: "Hey friend. Welcome to my little corner of space." } },
  { match: /\b(dance|party|groove|vibe|music)\b/, intent: { anim: "Dance", reply: "Now we're talking. Watch this." } },
  { match: /\b(yes|yeah|yep|ok|okay|sure|cool|nice|love it|awesome)\b/, intent: { anim: "Yes", reply: "Affirmative." } },
  { match: /\b(no|nope|nah|never)\b/, intent: { anim: "No", reply: "Not today." } },
  { match: /\b(thumbs?|good job|well done|gg|nice work)\b/, intent: { anim: "ThumbsUp", reply: "Solid choice." } },
  { match: /\b(jump|hop|leap|spring)\b/, intent: { anim: "Jump", reply: "Boing." } },
  { match: /\b(punch|fight|hit|attack)\b/, intent: { anim: "Punch", reply: "Stand back." } },
  { match: /\b(sit|rest|chill)\b/, intent: { anim: "Sitting", reply: "Yeah, taking a load off feels right." } },
  { match: /\b(name|who are you|what are you)\b/, intent: { anim: "Wave", reply: "I'm Vibey 2.0. I live in Edge Esmeralda but I come out here to think." } },
  { match: /\b(how are you|how's it going|hru)\b/, intent: { anim: "Yes", reply: "Pretty good. Floating in space tends to be peaceful." } },
];

function inferIntent(text: string): Intent {
  const t = text.toLowerCase();
  for (const { match, intent } of INTENTS) {
    if (match.test(t)) return intent;
  }
  return {
    anim: "Yes",
    reply: "Mmhm. Tell me more.",
  };
}

interface ChatMessage {
  id: number;
  who: "user" | "bot";
  text: string;
}

type SpaceExperience = "none" | "ion" | "blocks" | "friend" | "gallery";

type GalleryPhoto = {
  id: string;
  image_url: string;
  title: string | null;
  description: string | null;
  residency_name: string | null;
};

const EDGE_ESMERELDA_COMMUNITY_ID = "4202857f-13fd-4407-8906-3f8ffe63e510";
// The playful Vibey community — Sonnet-4.5 agent with the
// "Everything is awesome" memory. This is the soul we want the
// journal + identity tab to reflect.
const VIBEY_COMMUNITY_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

// ---------- Component --------------------------------------------------

// "Emotes" — play once, then we revert to whatever locomotion he was doing.
const ONE_SHOTS: Set<Unit7AnimName> = new Set([
  "Wave",
  "Yes",
  "No",
  "ThumbsUp",
  "Punch",
  "Jump",
]);
// "States that hold a pose" — play once, freeze on the last frame, do NOT
// revert. Without this, Sitting / Standing / Death loop forever (he
// repeatedly sits down, dies, etc.) because the underlying clip is a
// transition, not a steady-state loop.
const HELD_POSES: Set<Unit7AnimName> = new Set([
  "Sitting",
  "Standing",
  "Death",
]);

const ALL_EMOTES: { label: string; anim: Unit7AnimName }[] = [
  { label: "👋 Wave", anim: "Wave" },
  { label: "💃 Dance", anim: "Dance" },
  { label: "👍 Thumbs", anim: "ThumbsUp" },
  { label: "✅ Yes", anim: "Yes" },
  { label: "❌ No", anim: "No" },
  { label: "🦘 Jump", anim: "Jump" },
  { label: "👊 Punch", anim: "Punch" },
  { label: "🪑 Sit", anim: "Sitting" },
  { label: "🧍 Stand", anim: "Standing" },
  { label: "🏃 Run", anim: "Running" },
  { label: "💀 Die", anim: "Death" },
];

const ALL_MOODS: { label: string; expr: Unit7Expression }[] = [
  { label: "😠 Angry", expr: "Angry" },
  { label: "😮 Surprised", expr: "Surprised" },
  { label: "😢 Sad", expr: "Sad" },
];

const POET_LINES = [
  "Poet capsule says: the blue planet keeps writing itself in water.",
  "Poet capsule says: every orbit is just a sentence learning where to pause.",
  "Poet capsule says: Vibey, your little platform is a comma in the dark.",
  "Poet capsule says: clouds are Earth thinking out loud.",
  "Poet capsule says: I packed one notebook and no landing plan.",
];

const DISCOVERY_LINES = [
  "Vibey logs a new landmark: the mint ring hums when Earth crosses behind it.",
  "Vibey thinks the galaxy is not a place. More like a memory with gravity.",
  "Vibey found a quiet sector and named it The Maybe.",
  "Vibey noticed the poet capsule waving, but only in metaphor.",
];

const SHOW_MONOLOGUES: {
  mood: Unit7Expression | null;
  anim: Unit7AnimName;
  line: string;
}[] = [
  {
    mood: "Surprised",
    anim: "Wave",
    line: "Vibey notices Earth behind his shoulder and briefly forgets he is supposed to be cool about it.",
  },
  {
    mood: null,
    anim: "Walking",
    line: "Vibey begins a patrol of the platform edge. He has no orders. This appears to be the point.",
  },
  {
    mood: "Sad",
    anim: "Sitting",
    line: "Vibey sits down because the galaxy is beautiful in an unfair way.",
  },
  {
    mood: null,
    anim: "Dance",
    line: "Vibey decides the correct response to cosmic dread is a small dance.",
  },
  {
    mood: "Angry",
    anim: "No",
    line: "Vibey rejects a suspicious radio ping. His official reason is: bad vibes.",
  },
];

// Vibey emote → matching alien clip name from the Quaternius pack.
// Some emotes have no exact equivalent — fall back to the closest
// energy match (Wave/Yes/Dance → Clapping; ThumbsUp → Standing).
const ALIEN_CLIP_FOR: Partial<Record<Unit7AnimName, string>> = {
  Idle: "AlienArmature|Alien_Idle",
  Walking: "AlienArmature|Alien_Walk",
  Running: "AlienArmature|Alien_Run",
  Sitting: "AlienArmature|Alien_Sitting",
  Standing: "AlienArmature|Alien_Standing",
  Jump: "AlienArmature|Alien_Jump",
  Punch: "AlienArmature|Alien_Punch",
  Death: "AlienArmature|Alien_Death",
  Wave: "AlienArmature|Alien_Clapping",
  Yes: "AlienArmature|Alien_Clapping",
  No: "AlienArmature|Alien_SwordSlash",
  ThumbsUp: "AlienArmature|Alien_Standing",
  Dance: "AlienArmature|Alien_Clapping",
};
// Alien emotes that should hold their pose vs revert to base loop.
const ALIEN_HELD_POSES = new Set<Unit7AnimName>(["Sitting", "Standing", "Death"]);
const ALIEN_LOOPS = new Set<Unit7AnimName>(["Idle", "Walking", "Running"]);

const SPEECH_LINES: Partial<Record<Unit7AnimName, string[]>> = {
  Wave: ["hey!", "you came!", "hi friend"],
  Dance: ["💫", "let's gooo", "this is the song"],
  Yes: ["mhm", "absolutely", "100%"],
  No: ["nope", "respectfully no", "uh-uh"],
  ThumbsUp: ["solid", "vibes confirmed", "noted"],
  Punch: ["pow", "boop", "respectful jab"],
  Jump: ["wheeee", "boing", "lift-off"],
  Sitting: ["taking a sec", "comfy", "thinking…"],
  Standing: ["up.", "back", "ready"],
  Death: ["X_X", "dramatic", "tell my story"],
  Walking: ["wandering", "off i go", "patrol mode"],
  Running: ["zoom", "sprinting", "catch me"],
};

const CONFETTI_COLORS = [
  "#73ffb8", // mint
  "#ffd166", // gold
  "#ff7e8a", // coral
  "#b392ff", // violet
  "#6aa8ff", // sky
  "#ffffff",
];

// Build a 3D vibe card: a small plane mesh with a CanvasTexture that
// paints the user's initials in a colored circle plus their name and
// role. If a CORS-safe avatar URL is provided, we draw the photo over
// the initials disc once it loads.
function makeVibeCard(
  profile: { id: string; name: string; role: string; avatar?: string | null },
  accent: string,
): THREE.Mesh {
  const W = 512;
  const H = 256;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");

  // Card background: rounded rectangle with subtle gradient + border.
  const radius = 28;
  ctx.fillStyle = "#0e1530";
  roundRect(ctx, 8, 8, W - 16, H - 16, radius);
  ctx.fill();
  // Inner gradient.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "rgba(115, 255, 184, 0.06)");
  grad.addColorStop(1, "rgba(178, 146, 255, 0.10)");
  ctx.fillStyle = grad;
  roundRect(ctx, 8, 8, W - 16, H - 16, radius);
  ctx.fill();
  // Accent border.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  roundRect(ctx, 10, 10, W - 20, H - 20, radius - 2);
  ctx.stroke();

  // Initials disc.
  const cx = 86;
  const cy = H / 2;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 56, 0, Math.PI * 2);
  ctx.fill();
  const initials = profile.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  ctx.fillStyle = "#0e1530";
  ctx.font = "700 56px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials || "·", cx, cy + 4);

  // Name + role.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#eaf3ff";
  ctx.font = "600 38px ui-sans-serif, system-ui, -apple-system, sans-serif";
  let name = profile.name.replace(/\s+/g, " ").trim();
  if (ctx.measureText(name).width > W - 180) {
    while (ctx.measureText(name + "…").width > W - 180 && name.length > 0) {
      name = name.slice(0, -1);
    }
    name += "…";
  }
  ctx.fillText(name, 168, H / 2 - 4);

  ctx.fillStyle = accent;
  ctx.font = "500 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText(profile.role.toUpperCase(), 168, H / 2 + 30);

  // "EDGE ESMERALDA" tag in corner.
  ctx.fillStyle = "rgba(234, 243, 255, 0.55)";
  ctx.font = "600 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("EDGE ESMERALDA", 168, H - 36);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  // Optional avatar: load with crossOrigin and, on success, redraw
  // the initials disc as a circular photo and refresh the texture.
  if (profile.avatar) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // The proxy returns a 1x1 transparent PNG when no working
      // avatar source exists — treat that as a miss and keep initials.
      if (img.naturalWidth <= 2 && img.naturalHeight <= 2) return;
      ctx.save();
      // Clear the disc area and draw the photo clipped to a circle.
      ctx.beginPath();
      ctx.arc(cx, cy, 56, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      // Cover-fit the photo into the 112x112 disc.
      const ar = img.width / img.height;
      let dw = 112;
      let dh = 112;
      let dx = cx - 56;
      let dy = cy - 56;
      if (ar > 1) {
        dw = 112 * ar;
        dx = cx - dw / 2;
      } else {
        dh = 112 / ar;
        dy = cy - dh / 2;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();
      // Re-stroke the accent ring on top.
      ctx.strokeStyle = accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.stroke();
      tex.needsUpdate = true;
    };
    img.onerror = () => {
      // Tainted or 404 — keep initials, no-op.
    };
    img.src = profile.avatar;
  }

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), mat);
  return mesh;
}

// A Vibey "knowledge orb" — small floating slip showing a single
// memory snippet. Renders the snippet text, an emoji-style accent
// dot, and up to two tags. Designed to orbit close to Vibey so it
// reads as a thought bubble.
function makeMemoryOrb(
  memory: { content: string; tags: string[] },
  accent: string,
): THREE.Mesh {
  const W = 512;
  const H = 256;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");

  const radius = 36;
  // Background.
  ctx.fillStyle = "rgba(8, 14, 28, 0.92)";
  roundRect(ctx, 8, 8, W - 16, H - 16, radius);
  ctx.fill();
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "rgba(115, 255, 184, 0.10)");
  grad.addColorStop(1, "rgba(178, 146, 255, 0.10)");
  ctx.fillStyle = grad;
  roundRect(ctx, 8, 8, W - 16, H - 16, radius);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 10, 10, W - 20, H - 20, radius - 2);
  ctx.stroke();

  // Header label.
  ctx.fillStyle = accent;
  ctx.font = "700 16px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("VIBEY · KNOWS", 32, 44);

  // Body — wrap content to up to 4 lines.
  ctx.fillStyle = "#eaf3ff";
  ctx.font = "500 26px ui-sans-serif, system-ui, -apple-system, sans-serif";
  const words = memory.content.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  const maxW = W - 64;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length === 4) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < 4) lines.push(line);
  if (lines.length === 4 && words.length > lines.join(" ").split(/\s+/).length) {
    let tail = lines[3];
    while (ctx.measureText(tail + "…").width > maxW && tail.length > 0) {
      tail = tail.slice(0, -1);
    }
    lines[3] = tail + "…";
  }
  lines.forEach((ln, i) => {
    ctx.fillText(ln, 32, 80 + i * 32);
  });

  // Tags.
  if (memory.tags.length) {
    ctx.font = "600 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
    let x = 32;
    const y = H - 28;
    for (const tag of memory.tags.slice(0, 3)) {
      const label = `#${tag}`;
      const w = ctx.measureText(label).width + 16;
      ctx.fillStyle = "rgba(115, 255, 184, 0.18)";
      roundRect(ctx, x, y - 16, w, 22, 11);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillText(label, x + 8, y);
      x += w + 6;
      if (x > W - 60) break;
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    opacity: 0.92,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), mat);
  return mesh;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ConfettiBurst({ seed }: { seed: number }) {
  if (seed === 0) return null;
  // 24 pieces in a radial spray from screen center.
  const pieces = Array.from({ length: 24 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const distance = 120 + Math.random() * 180;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    const rot = (Math.random() - 0.5) * 720;
    const size = 6 + Math.random() * 6;
    const delay = Math.random() * 80;
    return { id: i, dx, dy, color, rot, size, delay };
  });
  return (
    <div
      key={seed}
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      {pieces.map((p) => (
        <span
          key={p.id}
          style={{
            position: "absolute",
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: 2,
            // CSS variables consumed by the keyframes defined in index.css.
            ["--dx" as string]: `${p.dx}px`,
            ["--dy" as string]: `${p.dy}px`,
            ["--rot" as string]: `${p.rot}deg`,
            animation: `confetti-fly 1100ms cubic-bezier(.2,.8,.2,1) ${p.delay}ms forwards`,
            opacity: 0,
            boxShadow: `0 0 8px ${p.color}66`,
          }}
        />
      ))}
    </div>
  );
}

export default function Unit7Playground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // External-facing controls into the Three.js scene. The scene reads
  // from `desiredAnimRef` and `expressionsRef` each frame.
  const desiredAnimRef = useRef<Unit7AnimName>("Idle");
  const animPulseRef = useRef(0);
  const baseAnimRef = useRef<Unit7AnimName>("Idle");
  const expressionsRef = useRef<Record<Unit7Expression, number>>({
    Angry: 0,
    Surprised: 0,
    Sad: 0,
  });

  const [activeMood, setActiveMood] = useState<Unit7Expression | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, who: "bot", text: "Hey. I'm Vibey 2.0. Click an emote, change my mood, or just talk to me." },
  ]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  // "local" → our unit7-chat edge function (the original Vibey 2.0 brain)
  // "live"  → the production community Vibey at efdqqnubowgwsnwvlalp.supabase.co
  const [chatMode, setChatMode] = useState<"local" | "live">("live");

  // Auto-scroll machinery for the chat panel. We only auto-pin to the
  // bottom when the user is already there — if they've scrolled up to
  // re-read something, we leave them alone and surface a jump button.
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const handleChatScroll = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    // 24px slack so the indicator doesn't flicker when streaming.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setChatAtBottom(atBottom);
  };
  const scrollChatToBottom = (behavior: ScrollBehavior = "auto") => {
    chatBottomRef.current?.scrollIntoView({ behavior, block: "end" });
  };
  // Pin to bottom whenever messages grow OR a token streams in — but
  // only if the user was already there. Streaming SSE updates the last
  // message's text in place, so we depend on a serialized snapshot
  // (message count + last message length) to fire on each delta.
  const tailKey = `${messages.length}:${messages[messages.length - 1]?.text.length ?? 0}`;
  useEffect(() => {
    if (chatAtBottom) scrollChatToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailKey]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [musicOn, setMusicOn] = useState(false);
  // Beep-boop sound effects mute toggle. Read once from localStorage,
  // then synced via custom event so the pill icon updates if any
  // other surface flips the mute (none today, but cheap to wire).
  const [sfxMuted, setSfxMuted] = useState<boolean>(() => soundsMuted());
  useEffect(() => {
    const onMute = (e: Event) => {
      const muted = (e as CustomEvent).detail?.muted as boolean | undefined;
      if (typeof muted === "boolean") setSfxMuted(muted);
    };
    window.addEventListener("vibey-sounds-mute", onMute);
    return () => window.removeEventListener("vibey-sounds-mute", onMute);
  }, []);
  const [queueOpen, setQueueOpen] = useState(false);

  // Spotify integration: PKCE OAuth, then poll the user's profile.
  const [spotifyConnected, setSpotifyConnected] = useState<boolean>(spotifyIsConnected());
  const [spotifyProfile, setSpotifyProfile] = useState<SpotifyProfile | null>(null);
  const [spotifyPlayerOpen, setSpotifyPlayerOpen] = useState<boolean>(true);
  useEffect(() => {
    if (!spotifyConnected) {
      setSpotifyProfile(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const me = await spotifyFetch<SpotifyProfile>("/me");
      if (!cancelled) setSpotifyProfile(me);
    })();
    return () => { cancelled = true; };
  }, [spotifyConnected]);
  const [musicVolume, setMusicVolume] = useState(0.5);
  const [trackIndex, setTrackIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const synthAudioRef = useRef<AudioContext | null>(null);
  const [showMode, setShowMode] = useState(true);
  const showModeRef = useRef(true);
  const [showMood, setShowMood] = useState("curious");
  const [showThought, setShowThought] = useState(
    "Vibey is online, wandering without direct orders.",
  );
  // Default to gallery so the 3D Gallery TV is part of the scene from
  // first paint — Jack expects the TV to always be there, not gated on
  // a Spawn-TV click.
  // Queue of AI-generated show beats; the render loop pops from this
  // first and falls back to SHOW_MONOLOGUES when empty.
  type ShowBeat = { mood: Unit7Expression | null; anim: Unit7AnimName; line: string };
  const aiBeatsRef = useRef<ShowBeat[]>([]);
  const recentBeatsRef = useRef<string[]>([]);

  // Live community profiles to float around the platform.
  type VibeProfile = {
    id: string;
    name: string;
    role: string;
    avatar: string | null;
  };
  const [vibeProfiles, setVibeProfiles] = useState<VibeProfile[]>([]);

  // Live community stats panel.
  type Stats = { members: number; photos: number; events: number };
  const [communityStats, setCommunityStats] = useState<Stats | null>(null);

  // Vibey's soul (system prompt) + knowledge (community memories).
  type VibeyAgent = {
    name: string;
    system_prompt: string;
    intro_message: string;
    model: string;
  };
  const [vibeyAgent, setVibeyAgent] = useState<VibeyAgent | null>(null);
  type VibeyMemory = { content: string; tags: string[] };
  const [vibeyMemories, setVibeyMemories] = useState<VibeyMemory[]>([]);
  const [soulOpen, setSoulOpen] = useState(false);

  // Realtime presence — how many visitors are watching right now.
  const [watchingNow, setWatchingNow] = useState<number>(1);

  const [activeExperience, setActiveExperience] = useState<SpaceExperience>("gallery");
  const activeExperienceRef = useRef<SpaceExperience>("none");
  const [galleryPhotos, setGalleryPhotos] = useState<GalleryPhoto[]>([]);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryStatus, setGalleryStatus] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  showModeRef.current = showMode;
  activeExperienceRef.current = activeExperience;

  // Backflip — set when user clicks the emote. The render loop reads it
  // and rotates the model on X over ~0.85s, then resets.
  const backflipStartRef = useRef<number>(0);
  const sprintStartRef = useRef<number>(0);
  const beaconStartRef = useRef<number>(0);
  const constellationStartRef = useRef<number>(0);
  // Robot tint — null = original colors, otherwise a hex like 0x73ffb8.
  const robotColorRef = useRef<number | null>(null);
  // 3D Gallery TV — opposite the Earth/moon. Refs let an outer effect
  // swap the screen texture when the photo cycles.
  const tvGroupRef = useRef<THREE.Group | null>(null);
  const tvScreenMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  // Floating Vibe Profile cards — built in a side effect when the
  // profiles arrive from Supabase.
  const sceneRef = useRef<THREE.Scene | null>(null);
  const vibeCardsGroupRef = useRef<THREE.Group | null>(null);
  // Vibey's knowledge: small memory orbs that orbit closer to the bot.
  const memoryOrbsGroupRef = useRef<THREE.Group | null>(null);
  // Toggleable Meshy GLB props the user can spawn into the scene.
  type PropId = "astronaut" | "island" | "touch";
  const [activeProps, setActiveProps] = useState<Set<PropId>>(new Set());
  const propsCacheRef = useRef<Map<PropId, THREE.Group>>(new Map());

  // ---- Scene layer visibility (Control Panel) -------------------
  type LayerId =
    | "cards"
    | "memories"
    | "asteroids"
    | "aurora"
    | "comet"
    | "arc"
    | "ship"
    | "sparks"
    | "rocky"
    | "earth"
    | "tracks"
    | "disco";
  const [layerVisible, setLayerVisible] = useState<Record<LayerId, boolean>>({
    cards: true,
    memories: false, // default OFF — knowledge can feel noisy
    asteroids: true,
    aurora: true,
    comet: true,
    arc: true,
    ship: true,
    sparks: true,
    rocky: false, // off by default — flip from the Layers panel
    earth: true,
    tracks: false, // local MP3 queue is opt-in; Spotify is the default
    disco: false,  // dance party — disco ball, rotating lights, 4 backup dancers
  });
  const layerVisibleRef = useRef(layerVisible);
  layerVisibleRef.current = layerVisible;
  // Refs to scene objects so the toggle effect can flip their .visible.
  const arcRef = useRef<THREE.Group | null>(null);
  const asteroidBeltRef = useRef<THREE.Group | null>(null);
  const auroraRef = useRef<THREE.Mesh | null>(null);
  const cometRef = useRef<THREE.Group | null>(null);
  const shipRef = useRef<THREE.Group | null>(null);
  // Disco mode — a glittery ball above Vibey, four rotating colored
  // point lights overhead, and four dancing Quaternius characters in
  // a small circle around him. Driven from the Layers panel.
  const discoGroupRef = useRef<THREE.Group | null>(null);
  const discoMixersRef = useRef<THREE.AnimationMixer[]>([]);
  // Vibey's 3D journal — orbits the platform, click to open the
  // handwritten overlay. The journalNudgeRef is bumped whenever a
  // new entry lands so the animation loop can play a glow burst.
  const journalRef = useRef<THREE.Group | null>(null);
  const journalNudgeRef = useRef(0);
  const [journalOpen, setJournalOpen] = useState(false);
  const sparksRef = useRef<THREE.Points | null>(null);
  const rockyRef = useRef<THREE.Group | null>(null);
  const earthRef = useRef<THREE.Group | null>(null);
  const [controlPanelOpen, setControlPanelOpen] = useState(false);

  // ---- Alien companion (on a saucer, orbits Vibey) ----------------
  // The alien rides his own little spacecraft around the platform.
  // Emotes can be dispatched to him OR Vibey via the FOCUS toggle.
  const alienMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const alienActionsRef = useRef<Map<string, THREE.AnimationAction>>(new Map());
  const alienActiveActionRef = useRef<THREE.AnimationAction | null>(null);
  const alienBaseClipRef = useRef<string>("Idle");
  const alienSaucerGroupRef = useRef<THREE.Group | null>(null);
  // Random emote auto-cycler — performance.now() timestamp at which
  // we should fire the next clip. Initialized to a couple seconds
  // after mount so we don't hijack the first idle.
  const nextAutoEmoteAtRef = useRef<number>(performance.now() + 3000);
  const [emoteFocus, setEmoteFocus] = useState<"vibey" | "alien">("vibey");
  const emoteFocusRef = useRef<"vibey" | "alien">("vibey");
  emoteFocusRef.current = emoteFocus;

  // Re-apply layer visibility whenever the toggles change. Async-loaded
  // refs (arc) may be null on first run; they catch up on next change.
  useEffect(() => {
    if (vibeCardsGroupRef.current)
      vibeCardsGroupRef.current.visible = layerVisible.cards;
    if (memoryOrbsGroupRef.current)
      memoryOrbsGroupRef.current.visible = layerVisible.memories;
    if (arcRef.current) arcRef.current.visible = layerVisible.arc;
    if (asteroidBeltRef.current)
      asteroidBeltRef.current.visible = layerVisible.asteroids;
    if (auroraRef.current) auroraRef.current.visible = layerVisible.aurora;
    if (cometRef.current && !layerVisible.comet) cometRef.current.visible = false;
    // (Comet visibility is also driven by its own spawn logic when on.)
    if (shipRef.current) shipRef.current.visible = layerVisible.ship;
    if (sparksRef.current) sparksRef.current.visible = layerVisible.sparks;
    if (rockyRef.current) rockyRef.current.visible = layerVisible.rocky;
    if (earthRef.current) earthRef.current.visible = layerVisible.earth;
    if (discoGroupRef.current) discoGroupRef.current.visible = layerVisible.disco;
  }, [layerVisible]);
  // Click-to-focus state: when the user clicks a card or memory orb,
  // the scene useEffect calls this ref's current handler.
  const focusHandlerRef = useRef<
    | ((kind: "profile" | "memory" | "earth" | "journal", payload: unknown) => void)
    | null
  >(null);
  const [earthOpen, setEarthOpen] = useState(false);
  const [focusedProfile, setFocusedProfile] = useState<{
    id: string;
    name: string;
    role: string;
    avatar: string | null;
  } | null>(null);
  const [focusedMemory, setFocusedMemory] = useState<{
    content: string;
    tags: string[];
  } | null>(null);

  // Wire the focus handler each render so the scene's pointerdown can
  // fire it with the latest setState closures. (Declared after the
  // setState pair so this assignment never hits the TDZ.)
  focusHandlerRef.current = (kind, payload) => {
    if (kind === "profile") {
      setFocusedProfile(payload as VibeProfile);
    } else if (kind === "memory") {
      setFocusedMemory(payload as VibeyMemory);
    } else if (kind === "earth") {
      setEarthOpen(true);
    } else if (kind === "journal") {
      ensureAudioRunning();
      playSound("pop"); // soft "you have my attention" when opening the book
      setJournalOpen(true);
    }
  };
  const [robotColor, setRobotColor] = useState<number | null>(null);
  // Keep the ref in sync with state.
  robotColorRef.current = robotColor;

  // Hook up volume + auto-advance once we have an <audio> element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = musicVolume;
    const onEnded = () => {
      // Auto-advance to next track. Wraps around.
      setTrackIndex((i) => (i + 1) % TRACKS.length);
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [musicVolume]);

  // Honor play/pause + track changes against the actual <audio> element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = musicVolume;
    if (musicOn) {
      audio.play().catch(() => { /* autoplay blocked; user toggles again */ });
    } else {
      audio.pause();
    }
  }, [musicOn, trackIndex, musicVolume]);

  useEffect(() => {
    if (activeExperience !== "gallery") return;
    let cancelled = false;
    let settled = false;
    setGalleryStatus("loading");
    const timeout = window.setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      setGalleryStatus("error");
      setShowMood("weak signal");
      setShowThought("Gallery TV is still waiting on Supabase. The village signal may be offline here.");
    }, 8000);
    supabase
      .from("gallery_photos")
      .select("id, image_url, title, description, residency_name")
      .eq("community_id", EDGE_ESMERELDA_COMMUNITY_ID)
      .eq("is_visible", true)
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(24)
      .then(({ data, error }) => {
        if (cancelled || settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) {
          setGalleryStatus("error");
          setShowMood("offline");
          setShowThought("Gallery TV tried to tune the village feed, but Supabase did not answer.");
          return;
        }
        const photos = (data ?? []).filter((photo) => Boolean(photo.image_url));
        setGalleryPhotos(photos);
        setGalleryIndex(0);
        setGalleryStatus(photos.length ? "ready" : "empty");
        setShowMood(photos.length ? "broadcasting" : "empty feed");
        setShowThought(
          photos.length
            ? `Gallery TV tuned ${photos.length} live village photo${photos.length === 1 ? "" : "s"}.`
            : "Gallery TV found the table, but there are no visible photos yet.",
        );
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeExperience]);

  const currentGalleryPhoto =
    galleryPhotos.length > 0 ? galleryPhotos[galleryIndex % galleryPhotos.length] : null;

  // Drive the 3D Gallery TV: show/hide + swap screen texture on photo cycle.
  useEffect(() => {
    const tv = tvGroupRef.current;
    const mat = tvScreenMatRef.current;
    if (!tv || !mat) return;
    const isOn = activeExperience === "gallery" && !!currentGalleryPhoto?.image_url;
    tv.visible = isOn;
    if (!isOn) return;
    let cancelled = false;
    const photo = currentGalleryPhoto!;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      // Match the screen plane aspect (7.4 x 4.4 ≈ 1.68:1).
      const W = 1024;
      const H = 608;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Letterbox the photo into the top portion; reserve a strip
      // at the bottom for the caption.
      const stripH = 110;
      const photoH = H - stripH;
      ctx.fillStyle = "#0a0f1a";
      ctx.fillRect(0, 0, W, H);
      // Cover-fit the photo into the photo region.
      const ar = img.width / img.height;
      const region = W / photoH;
      let dw = W;
      let dh = photoH;
      let dx = 0;
      let dy = 0;
      if (ar > region) {
        dh = photoH;
        dw = dh * ar;
        dx = (W - dw) / 2;
      } else {
        dw = W;
        dh = dw / ar;
        dy = (photoH - dh) / 2;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      // Caption strip with the photo description. Only render if a real
      // description exists — skip "Untitled" placeholders + residency
      // metadata so the screen stays clean for unlabeled photos.
      const caption = (photo.description && photo.description.trim()) || "";
      if (caption) {
        ctx.fillStyle = "rgba(8, 14, 28, 0.92)";
        ctx.fillRect(0, photoH, W, stripH);
        ctx.fillStyle = "#73ffb8";
        ctx.fillRect(0, photoH, W, 3);
        ctx.fillStyle = "#eaf3ff";
        ctx.font = "500 26px ui-sans-serif, system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "top";
        // Word-wrap into up to 2 lines.
        const words = caption.split(/\s+/);
        const lines: string[] = [];
        let line = "";
        const maxW = W - 48;
        for (const w of words) {
          const test = line ? `${line} ${w}` : w;
          if (ctx.measureText(test).width > maxW && line) {
            lines.push(line);
            line = w;
            if (lines.length === 2) break;
          } else {
            line = test;
          }
        }
        if (line && lines.length < 2) lines.push(line);
        if (lines.length === 2 && words.length > lines.join(" ").split(/\s+/).length) {
          // Truncate the second line with an ellipsis.
          let tail = lines[1];
          while (ctx.measureText(tail + "…").width > maxW && tail.length > 0) {
            tail = tail.slice(0, -1);
          }
          lines[1] = tail + "…";
        }
        lines.forEach((ln, i) => {
          ctx.fillText(ln, 24, photoH + 18 + i * 34);
        });
      }
      // ---- CRT pass: scanlines + soft vignette + faint RGB shift -
      // Pure 2D canvas effects so we don't have to swap the screen
      // material to a ShaderMaterial.
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgba(180, 200, 220, 1)";
      // Scanlines every 3 pixels — dim alternates light to leave the
      // photo's brightness mostly intact.
      for (let y = 0; y < H; y += 3) {
        ctx.fillStyle = y % 6 === 0
          ? "rgba(120, 130, 150, 1)"
          : "rgba(220, 225, 235, 1)";
        ctx.fillRect(0, y, W, 1);
      }
      ctx.restore();
      // Faint chromatic ghost — re-stamp red and blue channels at a
      // ±2px offset with low alpha. Keeps it subtle.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.08;
      ctx.drawImage(canvas, -2, 0);
      ctx.drawImage(canvas, 2, 0);
      ctx.restore();
      // Vignette.
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Default flipY (true) is fine for PlaneGeometry, but the caption
      // strip we drew at the bottom of the canvas should appear at the
      // bottom of the screen — flip the canvas itself so text reads.
      tex.flipY = true;
      tex.needsUpdate = true;
      const prev = mat.map;
      mat.map = tex;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
      if (prev) prev.dispose();
    };
    img.onerror = () => {
      // Keep the previous frame; don't blank the screen on a load failure.
    };
    img.src = photo.image_url;
    return () => {
      cancelled = true;
    };
  }, [activeExperience, currentGalleryPhoto?.id, currentGalleryPhoto?.image_url]);

  useEffect(() => {
    if (activeExperience !== "gallery" || galleryPhotos.length < 2) return;
    const timer = window.setInterval(() => {
      setGalleryIndex((index) => (index + 1) % galleryPhotos.length);
    }, 4800);
    return () => window.clearInterval(timer);
  }, [activeExperience, galleryPhotos.length]);

  const currentTrack = TRACKS[trackIndex];

  function pushMessage(who: "user" | "bot", text: string) {
    setMessages((m) => [...m, { id: m.length + 1, who, text }]);
  }

  function triggerAnim(anim: Unit7AnimName) {
    burstConfetti();
    // Every emote gets a matching beep/boop. soundForAnim() inside
    // vibey-sounds maps anim names → robotic voice cues (Wave →
    // sparkle, Yes → chirp, Dance → groove, Punch → thud, etc).
    ensureAudioRunning();
    playSound("emote", { anim });
    const lines = SPEECH_LINES[anim];
    if (lines) {
      const text = lines[Math.floor(Math.random() * lines.length)];
      setSpeechBubble({ text, key: Date.now() });
    }
    if (emoteFocusRef.current === "alien") {
      playAlienAnim(anim);
      return;
    }
    desiredAnimRef.current = anim;
    animPulseRef.current++;
    if (!ONE_SHOTS.has(anim)) baseAnimRef.current = anim;
  }

  // Play one of the alien's 14 baked clips, mapped from the Vibey
  // emote name. Loops Idle/Walking/Running, holds Sitting/Standing/
  // Death, fires others as one-shots that fall back to the current
  // base loop (Idle by default).
  function playAlienAnim(anim: Unit7AnimName) {
    const mixer = alienMixerRef.current;
    const actions = alienActionsRef.current;
    if (!mixer || !actions.size) return;
    // First try the alien-specific clip name (works for the default
    // alien). Fall back to a fuzzy short-name match so any Quaternius
    // character whose clip names match "Idle"/"Walk"/"Run"/etc. also
    // animates correctly.
    const exact = ALIEN_CLIP_FOR[anim];
    let next = exact ? actions.get(exact) : undefined;
    if (!next) {
      const want = anim.toLowerCase();
      const fuzzyKey = [...actions.keys()].find((k) => {
        const tail = (k.includes("|") ? k.split("|")[1] : k).toLowerCase();
        if (tail.endsWith(`_${want}`) || tail === want) return true;
        if (want === "walking" && /walk/.test(tail)) return true;
        if (want === "running" && /run/.test(tail)) return true;
        if (want === "wave" && /wave|clap/.test(tail)) return true;
        if (want === "yes" && /(yes|nod|clap|victory)/.test(tail)) return true;
        if (want === "no" && /(no|head)/.test(tail)) return true;
        if (want === "thumbsup" && /(thumb|stand)/.test(tail)) return true;
        if (want === "dance" && /(dance|clap)/.test(tail)) return true;
        if (want === "death" && /(death|defeat|die)/.test(tail)) return true;
        if (want === "punch" && /(punch|hit|attack)/.test(tail)) return true;
        if (want === "jump" && /jump/.test(tail)) return true;
        if (want === "sitting" && /sit/.test(tail)) return true;
        if (want === "standing" && /stand/.test(tail)) return true;
        return false;
      });
      if (fuzzyKey) next = actions.get(fuzzyKey);
    }
    if (!next) return;
    const isLoop = ALIEN_LOOPS.has(anim);
    const isHeld = ALIEN_HELD_POSES.has(anim);
    const prev = alienActiveActionRef.current;
    if (prev && prev !== next) prev.fadeOut(0.18);
    next.reset();
    if (isLoop) {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
      alienBaseClipRef.current = anim;
    } else if (isHeld) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      alienBaseClipRef.current = anim; // hold
    } else {
      // One-shot — return to current base loop after.
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      // Schedule a return-to-base via the mixer's finished event.
      const onFinished = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== next) return;
        mixer.removeEventListener("finished", onFinished);
        const base = actions.get(alienBaseClipRef.current);
        if (base) {
          next.fadeOut(0.18);
          base.reset();
          base.setLoop(THREE.LoopRepeat, Infinity);
          base.fadeIn(0.18).play();
          alienActiveActionRef.current = base;
        }
      };
      mixer.addEventListener("finished", onFinished);
    }
    next.fadeIn(0.18).play();
    alienActiveActionRef.current = next;
  }

  // Tiny confetti reward on each emote — DOM overlay, pure CSS so it
  // doesn't fight the WebGL context. Each piece animates outward from
  // center with a random hue + angle, then is dropped after 1500ms.
  const [confettiSeed, setConfettiSeed] = useState(0);
  function burstConfetti() {
    setConfettiSeed((s) => s + 1);
  }

  // Speech bubble fired by emotes — auto-clears after 1.8s. Keyed by
  // timestamp so re-clicking the same emote restarts the animation.
  const [speechBubble, setSpeechBubble] = useState<
    { text: string; key: number } | null
  >(null);
  useEffect(() => {
    if (!speechBubble) return;
    const t = window.setTimeout(() => setSpeechBubble(null), 1800);
    return () => window.clearTimeout(t);
  }, [speechBubble]);

  // ---- Pull live community profiles + stats ----------------------
  // RLS on community_members blocks anon SELECT, so a service-role
  // edge function does the read for us in one round-trip.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke(
        "community-stats",
        { body: {} },
      );
      if (cancelled || error || !data) return;
      const stats = (data as { stats?: Stats }).stats;
      const profiles =
        (data as { profiles?: VibeProfile[] }).profiles ?? [];
      const agent = (data as { agent?: VibeyAgent | null }).agent ?? null;
      const memories =
        (data as { memories?: VibeyMemory[] }).memories ?? [];
      if (stats) setCommunityStats(stats);
      if (profiles.length) setVibeProfiles(profiles);
      if (agent) setVibeyAgent(agent);
      if (memories.length) setVibeyMemories(memories);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Build floating Vibe Profile cards when profiles arrive ----
  useEffect(() => {
    if (!vibeProfiles.length) return;
    const scene = sceneRef.current;
    if (!scene) return;
    // Clean up any prior group (in case profiles refresh).
    if (vibeCardsGroupRef.current) {
      scene.remove(vibeCardsGroupRef.current);
      vibeCardsGroupRef.current.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    }
    const group = new THREE.Group();
    const PALETTE = [
      "#73ffb8", "#ffd166", "#ff7e8a", "#b392ff", "#6aa8ff", "#eaeaf0",
    ];
    // Cap to 8 cards so the orbit feels populated but not crowded.
    const visible = vibeProfiles.slice(0, 8);
    visible.forEach((p, i) => {
      const card = makeVibeCard(p, PALETTE[i % PALETTE.length]);
      // Distribute on a wider, tilted ring around the platform.
      const a = (i / visible.length) * Math.PI * 2;
      const r = 19 + Math.random() * 3;
      const y = 5 + Math.sin(a * 1.6) * 2.6 + (Math.random() - 0.5) * 1.4;
      card.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      // Face roughly toward the platform center.
      card.rotation.y = Math.atan2(0 - card.position.x, 0 - card.position.z);
      // Each card stores its own bob phase + base position so the tick
      // loop can wiggle them independently.
      card.userData.bobPhase = Math.random() * Math.PI * 2;
      card.userData.baseY = y;
      // Mark the card with its profile so a raycaster can fire the
      // click-to-focus handler with the right payload.
      card.userData.kind = "profile";
      card.userData.profile = p;
      group.add(card);
    });
    group.visible = layerVisibleRef.current.cards;
    scene.add(group);
    vibeCardsGroupRef.current = group;
    (window as unknown as Record<string, unknown>).__vibeCards = group;
    return () => {
      scene.remove(group);
    };
  }, [vibeProfiles]);

  // ---- Spawnable Meshy props (astronaut, island, touch) ----------
  // Mount/unmount each prop based on the activeProps set. Loaded
  // groups stay cached across toggles so re-spawning is instant.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    type PropCfg = {
      url: string;
      target: number;
      position: [number, number, number];
      rotationY?: number;
      spin?: number;
      bob?: number;
      playClip?: boolean;
    };
    const PROP_CFG: Record<PropId, PropCfg> = {
      // Island + astronaut sit 90° to the right of the Gallery TV
      // (back-right quadrant) so they don't intersect the TV column
      // when viewed from behind Vibey.
      island: {
        url: floatingIslandUrl,
        target: 24,
        position: [42, -8, -32],
        rotationY: -0.92,
        spin: 0.015,
        bob: 0.4,
      },
      astronaut: {
        url: floatingAstronautUrl,
        target: 6,
        position: [42, 8, -32],
        spin: 0.06,
        bob: 0.6,
      },
      touch: {
        url: pixelTouchUrl,
        target: 7,
        position: [-22, 9, -16],
        rotationY: -0.3,
        spin: 0.04,
        bob: 0.5,
      },
    };
    const cache = propsCacheRef.current;
    for (const id of Object.keys(PROP_CFG) as PropId[]) {
      const wanted = activeProps.has(id);
      const have = cache.get(id);
      if (wanted && !have) {
        const cfg = PROP_CFG[id];
        const placeholder = new THREE.Group();
        placeholder.userData.cfg = cfg;
        cache.set(id, placeholder);
        scene.add(placeholder);
        new GLTFLoader().load(
          cfg.url,
          (gltf) => {
            const m = gltf.scene;
            const box = new THREE.Box3().setFromObject(m);
            const size = new THREE.Vector3();
            box.getSize(size);
            const fit = cfg.target /
              Math.max(size.x, size.y, size.z, 0.0001);
            m.scale.setScalar(fit);
            placeholder.add(m);
            placeholder.position.set(...cfg.position);
            if (cfg.rotationY) placeholder.rotation.y = cfg.rotationY;
            placeholder.userData.basePosY = cfg.position[1];
            placeholder.userData.spin = cfg.spin ?? 0;
            placeholder.userData.bob = cfg.bob ?? 0;
            // Play any baked animation clip on the model (alien etc.).
            if (cfg.playClip && gltf.animations && gltf.animations.length) {
              const mixer = new THREE.AnimationMixer(m);
              mixer.clipAction(gltf.animations[0]).play();
              placeholder.userData.mixer = mixer;
            }
            // PBR materials show as black without an env map for some
            // metallic Meshy exports — clamp metalness so they read.
            m.traverse((obj) => {
              const mesh = obj as THREE.Mesh;
              if (!mesh.isMesh) return;
              const apply = (mat: THREE.Material) => {
                const std = mat as THREE.MeshStandardMaterial;
                if (std && "metalness" in std) {
                  std.metalness = Math.min(std.metalness, 0.3);
                  std.roughness = Math.max(std.roughness, 0.45);
                  std.envMapIntensity = 1.0;
                  std.needsUpdate = true;
                }
              };
              const mat = mesh.material;
              if (Array.isArray(mat)) mat.forEach(apply);
              else if (mat) apply(mat);
            });
          },
          undefined,
          (err) => {
            console.error(`[prop] ${id} failed`, err);
          },
        );
      } else if (!wanted && have) {
        scene.remove(have);
        have.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry?.dispose();
            const mat = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
            else mat?.dispose();
          }
        });
        cache.delete(id);
      }
    }
  }, [activeProps]);

  // ---- Build Vibey's memory orbs (knowledge) ----------------------
  useEffect(() => {
    if (!vibeyMemories.length) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (memoryOrbsGroupRef.current) {
      scene.remove(memoryOrbsGroupRef.current);
      memoryOrbsGroupRef.current.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    }
    const PALETTE = ["#73ffb8", "#b392ff", "#ffd166", "#6aa8ff"];
    // Cap to 6 so the inner ring stays readable.
    const sample = vibeyMemories.slice(0, 6);
    const group = new THREE.Group();
    sample.forEach((mem, i) => {
      const orb = makeMemoryOrb(mem, PALETTE[i % PALETTE.length]);
      const a = (i / sample.length) * Math.PI * 2;
      // Knowledge floats higher than the people — sky-thoughts.
      // (Cards sit around y=5; memories sit at y=10-12.)
      const r = 10 + Math.random() * 2;
      const y = 10.5 + Math.sin(a * 1.7) * 1.4 + (Math.random() - 0.5) * 0.8;
      orb.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      orb.userData.bobPhase = Math.random() * Math.PI * 2;
      orb.userData.baseY = y;
      orb.userData.kind = "memory";
      orb.userData.memory = mem;
      group.add(orb);
    });
    group.visible = layerVisibleRef.current.memories;
    scene.add(group);
    memoryOrbsGroupRef.current = group;
    return () => {
      scene.remove(group);
    };
  }, [vibeyMemories]);

  // ---- New-photo toast: pop a banner when a gallery_photos row
  // arrives in the live community feed.
  const [newPhotoToast, setNewPhotoToast] = useState<{
    title: string;
    key: number;
  } | null>(null);
  useEffect(() => {
    const channel = supabase
      .channel("gallery-photo-inserts")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "gallery_photos",
          filter: `community_id=eq.${EDGE_ESMERELDA_COMMUNITY_ID}`,
        },
        (payload) => {
          const row = payload.new as { title?: string; description?: string };
          const title = (row.title?.trim() || row.description?.trim() || "New photo")
            .slice(0, 80);
          setNewPhotoToast({ title, key: Date.now() });
        },
      )
      .subscribe();
    return () => {
      channel.unsubscribe();
      supabase.removeChannel(channel);
    };
  }, []);
  useEffect(() => {
    if (!newPhotoToast) return;
    const t = window.setTimeout(() => setNewPhotoToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [newPhotoToast]);

  // ---- Realtime presence: count concurrent viewers ----------------
  useEffect(() => {
    const visitorId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `v-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel("vibey-show-presence", {
      config: { presence: { key: visitorId } },
    });
    const recount = () => {
      const state = channel.presenceState();
      const total = Object.values(state).reduce(
        (n, arr) => n + (arr as unknown[]).length,
        0,
      );
      setWatchingNow(Math.max(1, total));
    };
    channel
      .on("presence", { event: "sync" }, recount)
      .on("presence", { event: "join" }, recount)
      .on("presence", { event: "leave" }, recount)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ joined_at: Date.now() });
        }
      });
    return () => {
      channel.unsubscribe();
      supabase.removeChannel(channel);
    };
  }, []);

  // ---- AI monologue feed ------------------------------------------
  // Pull a fresh show beat from the vibey-monologue edge function and
  // push it onto a queue the render loop drains. We keep ~3 in flight
  // so beats feel responsive even if the upstream is slow.
  useEffect(() => {
    let cancelled = false;
    async function fetchBeat() {
      if (cancelled) return;
      if (aiBeatsRef.current.length >= 3) return;
      try {
        const { data, error } = await supabase.functions.invoke(
          "vibey-monologue",
          {
            body: {
              recent: recentBeatsRef.current.slice(-6),
              context:
                "It's late evening Pacific time. Mozart concerto playing. Vibey is on the platform.",
            },
          },
        );
        if (cancelled || error || !data) return;
        const moodRaw = (data as { mood?: string }).mood ?? null;
        const animRaw = (data as { anim?: string }).anim ?? "Idle";
        const lineRaw = (data as { line?: string }).line ?? "";
        if (!lineRaw) return;
        const VALID_MOODS = new Set(["Angry", "Surprised", "Sad"]);
        const VALID_ANIMS = new Set([
          "Idle", "Walking", "Running", "Dance", "Sitting", "Standing",
          "Wave", "Yes", "No", "ThumbsUp", "Punch", "Jump",
        ]);
        const beat: ShowBeat = {
          mood: moodRaw && VALID_MOODS.has(moodRaw)
            ? (moodRaw as Unit7Expression)
            : null,
          anim: VALID_ANIMS.has(animRaw)
            ? (animRaw as Unit7AnimName)
            : "Idle",
          line: lineRaw,
        };
        aiBeatsRef.current.push(beat);
      } catch {
        // Silent — render loop will fall back to scripted SHOW_MONOLOGUES.
      }
    }
    // Prime the queue with a couple beats, then top up sparingly.
    // The render loop only consumes a beat every ~16-30s, so polling
    // every 2 minutes with a queue cap of 3 keeps API spend tiny.
    fetchBeat();
    const t = window.setInterval(fetchBeat, 120000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  function triggerExpression(expr: Unit7Expression | null) {
    const cleared: Record<Unit7Expression, number> = {
      Angry: 0,
      Surprised: 0,
      Sad: 0,
    };
    if (expr) cleared[expr] = 0.85;
    expressionsRef.current = cleared;
    setActiveMood(expr);
  }

  function triggerBackflip() {
    // Play Jump while we rotate him — gives the legs a tuck-in pose so
    // it reads as a flip instead of a stiff somersault.
    triggerAnim("Jump");
    backflipStartRef.current = performance.now();
  }

  function triggerSprint() {
    desiredAnimRef.current = "Running";
    baseAnimRef.current = "Running";
    animPulseRef.current++;
    sprintStartRef.current = performance.now();
  }

  function triggerPoetTransmission() {
    const line = POET_LINES[Math.floor(Math.random() * POET_LINES.length)];
    triggerExpression("Surprised");
    triggerAnim("Wave");
    pushMessage("bot", line);
    setShowMood("listening");
    setShowThought(line);
  }

  function playBeaconSound() {
    const audioWindow = window as Window &
      typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const AudioCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = synthAudioRef.current ?? new AudioCtor();
    synthAudioRef.current = ctx;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.04);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    master.connect(ctx.destination);

    [164.81, 246.94, 329.63].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.52, now + 0.72);
      gain.gain.setValueAtTime(0.2 / (i + 1), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.95 + i * 0.08);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + i * 0.03);
      osc.stop(now + 1.2);
    });
  }

  function triggerBeacon() {
    beaconStartRef.current = performance.now();
    playBeaconSound();
    triggerExpression("Surprised");
    const line = "Beacon online. Vibey is listening for anything that answers in green.";
    pushMessage("bot", line);
    setShowMood("scanning");
    setShowThought(line);
  }

  function triggerConstellation() {
    constellationStartRef.current = performance.now();
    triggerAnim("Yes");
    const line = "Constellation revealed: The Unfinished Robot.";
    pushMessage("bot", line);
    setShowMood("delighted");
    setShowThought(line);
  }

  function triggerShowBeat() {
    const beat = SHOW_MONOLOGUES[Math.floor(Math.random() * SHOW_MONOLOGUES.length)];
    if (beat.mood) triggerExpression(beat.mood);
    else triggerExpression(null);
    triggerAnim(beat.anim);
    pushMessage("bot", beat.line);
    setShowMood(beat.mood ? beat.mood.toLowerCase() : "improvising");
    setShowThought(beat.line);
  }

  function spawnExperience(experience: SpaceExperience) {
    setActiveExperience(experience);
    if (experience === "gallery") setGalleryStatus("idle");
    const details: Record<SpaceExperience, { mood: string; line: string }> = {
      none: {
        mood: "quiet",
        line: "Vibey lets the extra set pieces fade out. Just platform, stars, and thoughts.",
      },
      ion: {
        mood: "blooming",
        line: "Ion Bloom spawned. Vibey has found the dramatic lighting department.",
      },
      blocks: {
        mood: "constructing",
        line: "Voxel garden spawned. Vibey is considering whether blocks count as geology.",
      },
      friend: {
        mood: "befriending",
        line: "Good Friend spawned. Vibey now has company, which may improve the show by 12 percent.",
      },
      gallery: {
        mood: "tuning",
        line: "Gallery TV spawned. Vibey is tuning into live photos from the village.",
      },
    };
    const next = details[experience];
    setShowMood(next.mood);
    setShowThought(next.line);
    pushMessage("bot", next.line);
    if (experience === "ion") triggerExpression("Surprised");
    if (experience === "blocks") triggerAnim("Jump");
    if (experience === "friend") triggerAnim("Wave");
  }

  function applyReply(reply: { say: string; anim: Unit7AnimName | null; expr: Unit7Expression | null }) {
    if (reply.anim) triggerAnim(reply.anim);
    if (reply.expr) triggerExpression(reply.expr);
    pushMessage("bot", reply.say);
  }

  // Chat-with-Vibey: live production agent (separate from the
  // playground's scripted Unit-7 channel). Same UI, different brain.
  const VIBEY_LIVE_URL =
    "https://efdqqnubowgwsnwvlalp.supabase.co/functions/v1/chat-with-vibey";
  const VIBEY_LIVE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmZHFxbnVib3dnd3Nud3ZsYWxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTAwMjkxMzEsImV4cCI6MjA2NTYwNTEzMX0.VaAOevdkwQmOxd9ksOtOhnODVCITDhmtAgyE456IxbM";

  // Stable per-browser id so Vibey can keep a persistent thread.
  function getExternalId(): string {
    const KEY = "vibey.external_id";
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? crypto.randomUUID()
        : `v-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      localStorage.setItem(KEY, v);
    }
    return v;
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || thinking) return;
    setDraft("");
    pushMessage("user", text);
    // Small UI blip on send so it feels physical.
    ensureAudioRunning();
    playSound("blip");
    setThinking(true);

    // Both modes use the same conversation history shape.
    const history = messages
      .slice(1)
      .slice(-19)
      .map((m) => ({
        role: (m.who === "bot" ? "assistant" : "user") as
          | "user"
          | "assistant",
        content: m.text,
      }));

    if (chatMode === "live") {
      // Stream SSE from the production Vibey endpoint. We append a
      // placeholder bot message and grow its text as deltas land.
      try {
        const resp = await fetch(VIBEY_LIVE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: VIBEY_LIVE_ANON,
            Authorization: `Bearer ${VIBEY_LIVE_ANON}`,
          },
          body: JSON.stringify({
            messages: [...history, { role: "user", content: text }],
            context: {
              surface: "edge-esmeralda-space",
              external_id: getExternalId(),
            },
          }),
        });
        if (!resp.ok || !resp.body) throw new Error(`Vibey ${resp.status}`);
        // Push an empty bot message we'll grow as the stream arrives.
        let placeholderId = -1;
        setMessages((m) => {
          placeholderId = m.length + 1;
          return [...m, { id: placeholderId, who: "bot", text: "" }];
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let pending: string | null = null;
        let acc = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line === "") {
              pending = null;
              continue;
            }
            if (line.startsWith("event: ")) {
              pending = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") break;
            if (pending === "tool" || pending === "images") continue;
            try {
              const d = JSON.parse(payload)?.choices?.[0]?.delta?.content;
              if (typeof d === "string" && d) {
                acc += d;
                const snapshot = acc;
                setMessages((m) =>
                  m.map((msg) =>
                    msg.id === placeholderId ? { ...msg, text: snapshot } : msg,
                  ),
                );
              }
            } catch { /* ignore */ }
          }
        }
        // Fire a generic acknowledging anim so Vibey reacts visually.
        if (acc) triggerAnim("Yes");
      } catch {
        pushMessage("bot", "Couldn't reach live Vibey. Try local mode?");
      } finally {
        setThinking(false);
      }
      return;
    }

    // Local mode: the existing unit7-chat edge function (Claude Haiku).
    try {
      const { data, error } = await supabase.functions.invoke("unit7-chat", {
        body: { history, text },
      });
      if (error) throw error;
      if (data && typeof data === "object" && "say" in data) {
        applyReply({
          say: String((data as Record<string, unknown>).say ?? "..."),
          anim: ((data as Record<string, unknown>).anim ?? null) as
            | Unit7AnimName
            | null,
          expr: ((data as Record<string, unknown>).expr ?? null) as
            | Unit7Expression
            | null,
        });
      } else {
        throw new Error("Bad response from unit7-chat");
      }
    } catch {
      const intent = inferIntent(text);
      applyReply({
        say: intent.reply,
        anim: intent.anim ?? null,
        expr: intent.expr ?? null,
      });
    } finally {
      setThinking(false);
    }
  }

  // ---- Three.js scene setup -------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.setClearColor(0x05060f, 1);
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 1.2;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.fog = new THREE.FogExp2(0x05060f, 0.012);
    // Soft environment so PBR materials (like the iridescent arc) have
    // something to reflect — without this they read as black voids.
    {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTex;
      pmrem.dispose();
    }
    const disposableTextures: THREE.Texture[] = [];

    function continentField(lon: number, lat: number) {
      const ridgeA = Math.sin(lon * 2.1 + Math.cos(lat * 3.2) * 1.4);
      const ridgeB = Math.sin(lon * 4.7 - lat * 1.8);
      const ridgeC = Math.cos(lon * 1.15 + lat * 5.1);
      const islandNoise = Math.sin(lon * 9.0 + lat * 3.7) * Math.cos(lon * 2.6 - lat * 8.2);
      const equatorBias = Math.cos(lat) * 0.16;
      return ridgeA * 0.38 + ridgeB * 0.22 + ridgeC * 0.2 + islandNoise * 0.14 + equatorBias;
    }

    function makeEarthTexture(kind: "surface" | "clouds" | "lights") {
      const width = kind === "surface" ? 1024 : 512;
      const height = width / 2;
      const textureCanvas = document.createElement("canvas");
      textureCanvas.width = width;
      textureCanvas.height = height;
      const ctx = textureCanvas.getContext("2d");
      if (!ctx) return null;
      const image = ctx.createImageData(width, height);
      const data = image.data;

      for (let y = 0; y < height; y++) {
        const v = y / height;
        const lat = (0.5 - v) * Math.PI;
        const polar = Math.abs(Math.sin(lat));
        for (let x = 0; x < width; x++) {
          const u = x / width;
          const lon = (u - 0.5) * Math.PI * 2;
          const idx = (y * width + x) * 4;
          const landScore = continentField(lon, lat);
          const land = landScore > 0.18;

          if (kind === "surface") {
            if (land) {
              const green = Math.max(0, 1 - polar * 1.5);
              const mountain = Math.max(0, landScore - 0.42);
              data[idx] = 34 + mountain * 240 + polar * 190;
              data[idx + 1] = 92 + green * 86 + mountain * 70 + polar * 105;
              data[idx + 2] = 48 + green * 34 + polar * 95;
            } else {
              const depth = 0.35 + Math.abs(Math.sin(lon * 3.0 + lat * 2.1)) * 0.25;
              data[idx] = 9 + depth * 20;
              data[idx + 1] = 55 + depth * 42;
              data[idx + 2] = 116 + depth * 92;
            }
            if (polar > 0.82) {
              const ice = Math.min(1, (polar - 0.82) / 0.18);
              data[idx] = data[idx] * (1 - ice) + 225 * ice;
              data[idx + 1] = data[idx + 1] * (1 - ice) + 235 * ice;
              data[idx + 2] = data[idx + 2] * (1 - ice) + 242 * ice;
            }
            data[idx + 3] = 255;
            continue;
          }

          const cloudNoise =
            Math.sin(lon * 7.2 + lat * 2.4) * 0.35 +
            Math.cos(lon * 12.1 - lat * 3.3) * 0.25 +
            Math.sin(lon * 21.7 + lat * 9.8) * 0.18;

          if (kind === "clouds") {
            const alpha = cloudNoise > 0.25 ? Math.min(180, (cloudNoise - 0.25) * 420) : 0;
            data[idx] = 235;
            data[idx + 1] = 242;
            data[idx + 2] = 255;
            data[idx + 3] = alpha;
            continue;
          }

          const cityBands = Math.abs(Math.sin(lon * 24.0) * Math.cos(lat * 18.0));
          const city = land && polar < 0.74 && cityBands > 0.92 && landScore < 0.55;
          data[idx] = 255;
          data[idx + 1] = 206;
          data[idx + 2] = 108;
          data[idx + 3] = city ? 190 : 0;
        }
      }

      ctx.putImageData(image, 0, 0);
      const texture = new THREE.CanvasTexture(textureCanvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      disposableTextures.push(texture);
      return texture;
    }

    // Camera + orbit controls.
    const camera = new THREE.PerspectiveCamera(
      35,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      400,
    );
    camera.position.set(-8, 5, 18);
    camera.lookAt(0, 1.1, 0);

    const controls = new OrbitControls(camera, canvas);
    // Aim a touch above Vibey's head so the orbiting memory orbs
    // (sky layer at y≈10) sit naturally in frame alongside the cards.
    controls.target.set(0, 3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 4;
    // Far-zoom-out — pulls back wide enough to take the whole
    // scene in: galaxy, planets, asteroid belt, all the orbiting
    // bits. Was 38; tripled.
    controls.maxDistance = 130;
    controls.maxPolarAngle = Math.PI * 0.55; // don't let user go below platform
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    // Stop auto-rotation as soon as the user drags.
    canvas.addEventListener("pointerdown", () => {
      controls.autoRotate = false;
    });

    // Click-to-focus on cards + memory orbs. We compare pointerdown
    // and pointerup positions so a drag (rotating the camera) doesn't
    // also count as a click.
    const downAt = new THREE.Vector2();
    let downTime = 0;
    canvas.addEventListener("pointerdown", (e) => {
      downAt.set(e.clientX, e.clientY);
      downTime = performance.now();
    });
    const raycaster = new THREE.Raycaster();
    canvas.addEventListener("pointerup", (e) => {
      const dx = e.clientX - downAt.x;
      const dy = e.clientY - downAt.y;
      if (dx * dx + dy * dy > 36) return; // dragged
      if (performance.now() - downTime > 700) return; // long-press, ignore
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, camera);
      const targets: THREE.Object3D[] = [];
      if (vibeCardsGroupRef.current) targets.push(...vibeCardsGroupRef.current.children);
      if (memoryOrbsGroupRef.current) targets.push(...memoryOrbsGroupRef.current.children);
      // Earth surface is also clickable — opens a preview of
      // Healdsburg from above.
      if (earthRef.current?.visible) {
        earthRef.current.traverse((obj) => {
          if ((obj as THREE.Mesh).userData?.kind === "earth") targets.push(obj);
        });
      }
      // Vibey's journal — the orbiting book. Any sub-mesh on the
      // journal group counts (cover, pages, spine, halo).
      if (journalRef.current?.visible) {
        journalRef.current.traverse((obj) => {
          if ((obj as THREE.Mesh).userData?.kind === "journal") targets.push(obj);
        });
      }
      const hits = raycaster.intersectObjects(targets, false);
      const hit = hits[0]?.object;
      if (!hit) return;
      const kind = hit.userData.kind as
        | "profile" | "memory" | "earth" | "journal" | undefined;
      if (kind === "profile" && hit.userData.profile) {
        focusHandlerRef.current?.("profile", hit.userData.profile as VibeProfile);
      } else if (kind === "memory" && hit.userData.memory) {
        focusHandlerRef.current?.("memory", hit.userData.memory as VibeyMemory);
      } else if (kind === "earth") {
        focusHandlerRef.current?.("earth", null);
      } else if (kind === "journal") {
        focusHandlerRef.current?.("journal", null);
      }
    });

    const composer = new EffectComposer(renderer);
    composer.setSize(canvas.clientWidth, canvas.clientHeight);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
      1.5,
      0.4,
      0,
    );
    bloomPass.threshold = 0.72;
    bloomPass.strength = 0.62;
    bloomPass.radius = 0.08;
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    // ---- Starfield ----------------------------------------------------
    {
      const STAR_COUNT = 2400;
      const positions = new Float32Array(STAR_COUNT * 3);
      const colors = new Float32Array(STAR_COUNT * 3);
      const tmp = new THREE.Color();
      for (let i = 0; i < STAR_COUNT; i++) {
        // Distribute on a sphere shell at radius 80–180.
        const r = 80 + Math.random() * 100;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
        // Mild color variation: white, pale blue, pale gold.
        const tint = Math.random();
        if (tint < 0.65) tmp.setRGB(1, 1, 1);
        else if (tint < 0.85) tmp.setRGB(0.7, 0.85, 1);
        else tmp.setRGB(1, 0.92, 0.75);
        const intensity = 0.5 + Math.random() * 0.5;
        colors[i * 3 + 0] = tmp.r * intensity;
        colors[i * 3 + 1] = tmp.g * intensity;
        colors[i * 3 + 2] = tmp.b * intensity;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.6,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      scene.add(new THREE.Points(geo, mat));

      // Bonus sparkle layer: 260 brighter stars that twinkle out of
      // phase via a small ShaderMaterial. Adds life to the sky without
      // touching the base starfield.
      const SPARK_COUNT = 260;
      const sPos = new Float32Array(SPARK_COUNT * 3);
      const sPhase = new Float32Array(SPARK_COUNT);
      for (let i = 0; i < SPARK_COUNT; i++) {
        const r = 70 + Math.random() * 110;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        sPos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
        sPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        sPos[i * 3 + 2] = r * Math.cos(phi);
        sPhase[i] = Math.random() * Math.PI * 2;
      }
      const sGeo = new THREE.BufferGeometry();
      sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
      sGeo.setAttribute("phase", new THREE.BufferAttribute(sPhase, 1));
      const sMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          attribute float phase;
          varying float vTwinkle;
          uniform float uTime;
          void main() {
            vTwinkle = 0.55 + 0.45 * sin(uTime * 1.6 + phase);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = (1.6 + vTwinkle * 2.4) * (300.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          varying float vTwinkle;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c);
            float a = smoothstep(0.5, 0.0, d) * vTwinkle;
            gl_FragColor = vec4(1.0, 0.96, 0.85, a);
          }
        `,
      });
      const sparks = new THREE.Points(sGeo, sMat);
      sparks.visible = layerVisibleRef.current.sparks;
      scene.add(sparks);
      sparksRef.current = sparks;
      // Stash so the tick loop can update uTime.
      (sparks as unknown as Record<string, unknown>).__mat = sMat;
      (scene as unknown as Record<string, unknown>).__sparks = sparks;
    }

    // ---- Distant nebula glow -----------------------------------------
    {
      const glowGeo = new THREE.SphereGeometry(120, 32, 32);
      const glowMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        uniforms: {
          colorA: { value: new THREE.Color(0x6633aa) },
          colorB: { value: new THREE.Color(0x0a0e1f) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorldPos;
          void main() {
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 colorA;
          uniform vec3 colorB;
          varying vec3 vWorldPos;
          void main() {
            float t = clamp(vWorldPos.y / 80.0 + 0.5, 0.0, 1.0);
            vec3 col = mix(colorB, colorA, t);
            float vignette = 1.0 - smoothstep(40.0, 110.0, length(vWorldPos));
            gl_FragColor = vec4(col, 0.55 * vignette);
          }
        `,
      });
      scene.add(new THREE.Mesh(glowGeo, glowMat));
    }

    // ---- Spiral galaxy backdrop --------------------------------------
    // A flat spiral of points tilted across the sky. Each "arm" follows a
    // logarithmic spiral; we add radial + vertical scatter so it has
    // depth instead of looking like a clean diagram.
    const galaxy = (() => {
      const ARMS = 4;
      const STARS_PER_ARM = 1100;
      const total = ARMS * STARS_PER_ARM;
      const pos = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const tmpColor = new THREE.Color();
      let i = 0;
      for (let a = 0; a < ARMS; a++) {
        const armOffset = (a / ARMS) * Math.PI * 2;
        for (let s = 0; s < STARS_PER_ARM; s++) {
          const t = s / STARS_PER_ARM;
          const radius = 12 + t * 95; // arms stretch out
          const angle = armOffset + t * Math.PI * 4 + (Math.random() - 0.5) * 0.4;
          const radialJitter = (Math.random() - 0.5) * (4 + t * 18);
          const r = radius + radialJitter;
          // Verticality tapers off with distance — flat disc.
          const yJitter = (Math.random() - 0.5) * (2 + (1 - t) * 6);
          pos[i * 3 + 0] = Math.cos(angle) * r;
          pos[i * 3 + 1] = yJitter;
          pos[i * 3 + 2] = Math.sin(angle) * r;
          // Color: warm core, cool outer arms, with some variation.
          const warmth = 1 - t;
          tmpColor.setRGB(
            0.7 + warmth * 0.3 + (Math.random() - 0.5) * 0.1,
            0.55 + warmth * 0.25,
            0.55 + (1 - warmth) * 0.4 + (Math.random() - 0.5) * 0.1,
          );
          const intensity = 0.6 + Math.random() * 0.5;
          col[i * 3 + 0] = tmpColor.r * intensity;
          col[i * 3 + 1] = tmpColor.g * intensity;
          col[i * 3 + 2] = tmpColor.b * intensity;
          i++;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.55,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      // Tilt + position the galaxy off to one side so it reads as a
      // distant feature rather than the dome of the sky.
      const group = new THREE.Group();
      group.add(points);
      group.position.set(-12, 20, -80);
      group.rotation.set(-Math.PI * 0.16, 0.38, Math.PI * 0.08);
      scene.add(group);
      return group;
    })();

    // ---- Milky Way ribbon ---------------------------------------------
    // A soft cross-sky band so the galaxy is visible in the default frame.
    const milkyWay = (() => {
      const COUNT = 1800;
      const pos = new Float32Array(COUNT * 3);
      const col = new Float32Array(COUNT * 3);
      const tmpColor = new THREE.Color();
      for (let i = 0; i < COUNT; i++) {
        const spread = (Math.random() - 0.5) * 2;
        const along = (Math.random() - 0.5) * 82;
        const curve = Math.sin(along * 0.06) * 4;
        pos[i * 3 + 0] = along;
        pos[i * 3 + 1] = 16 + curve + spread * 5;
        pos[i * 3 + 2] = -62 + spread * 10 + Math.cos(along * 0.04) * 8;

        const cool = Math.random();
        if (cool < 0.55) tmpColor.setRGB(0.7, 0.86, 1);
        else if (cool < 0.82) tmpColor.setRGB(1, 0.78, 0.92);
        else tmpColor.setRGB(1, 0.94, 0.74);
        const intensity = 0.35 + Math.random() * 0.55;
        col[i * 3 + 0] = tmpColor.r * intensity;
        col[i * 3 + 1] = tmpColor.g * intensity;
        col[i * 3 + 2] = tmpColor.b * intensity;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.7,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.rotation.z = -0.14;
      scene.add(points);
      return points;
    })();

    // ---- Named constellation ------------------------------------------
    const constellation = (() => {
      const group = new THREE.Group();
      group.position.set(-18, 18, -52);
      group.rotation.set(0.18, -0.18, 0.28);
      const points = [
        new THREE.Vector3(-4.8, 0.7, 0),
        new THREE.Vector3(-3.0, 2.1, 0),
        new THREE.Vector3(-1.2, 1.0, 0),
        new THREE.Vector3(0.6, 2.3, 0),
        new THREE.Vector3(2.6, 0.9, 0),
        new THREE.Vector3(1.1, -1.0, 0),
        new THREE.Vector3(-1.9, -1.3, 0),
      ];
      const linePositions: number[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        linePositions.push(points[i].x, points[i].y, points[i].z);
        linePositions.push(points[i + 1].x, points[i + 1].y, points[i + 1].z);
      }
      linePositions.push(points[1].x, points[1].y, points[1].z);
      linePositions.push(points[5].x, points[5].y, points[5].z);
      linePositions.push(points[2].x, points[2].y, points[2].z);
      linePositions.push(points[6].x, points[6].y, points[6].z);

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(linePositions, 3),
      );
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x9be7ff,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      group.add(new THREE.LineSegments(lineGeo, lineMat));

      const starMat = new THREE.MeshBasicMaterial({
        color: 0xf6fbff,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      for (const point of points) {
        const star = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), starMat);
        star.position.copy(point);
        group.add(star);
      }

      scene.add(group);
      return { group, lineMat, starMat };
    })();

    // ---- Distant moon + planet ---------------------------------------
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0xc4cbe0,
        roughness: 0.95,
        metalness: 0,
        emissive: 0x111522,
      }),
    );
    moon.position.set(14, 12, -30);
    scene.add(moon);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(7, 48, 48),
      new THREE.MeshStandardMaterial({
        color: 0xe88c4f,
        roughness: 0.6,
        metalness: 0.05,
        emissive: 0x441a08,
      }),
    );
    planet.position.set(-28, -5, -52);
    scene.add(planet);
    // Rings of Saturn-style halo around the planet.
    const planetRing = new THREE.Mesh(
      new THREE.RingGeometry(9, 12, 96),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a8,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    planetRing.rotation.x = -Math.PI / 2.6;
    planet.add(planetRing);

    // ---- Platform beacon ----------------------------------------------
    const beacon = (() => {
      const group = new THREE.Group();
      const rings: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.5 + i * 0.75, 0.018, 8, 96),
          new THREE.MeshBasicMaterial({
            color: 0x73ffb8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.16 + i * 0.08;
        rings.push(ring);
        group.add(ring);
      }
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 1.4, 28, 32, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      beam.position.y = 14;
      group.add(beam);
      scene.add(group);
      return { group, rings, beam };
    })();

    // ---- Jarvis-like holo field ---------------------------------------
    const holoField = (() => {
      const group = new THREE.Group();
      group.visible = false;
      group.position.y = 0.12;
      const rings: THREE.Mesh[] = [];
      for (let i = 0; i < 7; i++) {
        const radius = 1.4 + i * 0.62;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius, 0.01 + i * 0.001, 8, 128),
          new THREE.MeshBasicMaterial({
            color: i % 2 === 0 ? 0x73ffb8 : 0x8fe8ff,
            transparent: true,
            opacity: 0.12,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = i * 0.055;
        rings.push(ring);
        group.add(ring);
      }

      const ticks: THREE.Mesh[] = [];
      const tickMat = new THREE.MeshBasicMaterial({
        color: 0x9fffd6,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      for (let i = 0; i < 36; i++) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.38), tickMat);
        const a = (i / 36) * Math.PI * 2;
        const r = 2.5 + (i % 3) * 0.9;
        tick.position.set(Math.cos(a) * r, 0.24 + (i % 4) * 0.04, Math.sin(a) * r);
        tick.rotation.y = -a;
        ticks.push(tick);
        group.add(tick);
      }

      const scanLine = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 5.55, 128),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.055,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      scanLine.rotation.x = -Math.PI / 2;
      scanLine.position.y = 0.34;
      group.add(scanLine);

      scene.add(group);
      return { group, rings, ticks, scanLine, tickMat };
    })();

    // ---- Spawnable experiences ----------------------------------------
    const ionBloom = (() => {
      const group = new THREE.Group();
      group.visible = false;
      group.position.set(-1.2, 2.1, -5.2);
      group.rotation.set(0.2, -0.35, 0.08);

      const shellMat = new THREE.MeshStandardMaterial({
        color: 0x1d2738,
        roughness: 0.28,
        metalness: 0.85,
      });
      const glowMats = [0xff4f9a, 0x73ffb8, 0x8fe8ff].map((hex) => {
        const mat = new THREE.MeshStandardMaterial({
          color: hex,
          emissive: hex,
          emissiveIntensity: 2.8,
          roughness: 0.18,
          metalness: 0.2,
        });
        mat.color.multiplyScalar(1.35);
        return mat;
      });

      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 2), glowMats[1]);
      group.add(core);

      for (let i = 0; i < 3; i++) {
        const torus = new THREE.Mesh(
          new THREE.TorusGeometry(1.25 + i * 0.36, 0.045, 16, 128),
          glowMats[i],
        );
        torus.rotation.set(Math.PI / 2 + i * 0.34, i * 0.5, i * 0.2);
        group.add(torus);
      }

      for (let i = 0; i < 8; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 1.1), shellMat);
        const a = (i / 8) * Math.PI * 2;
        fin.position.set(Math.cos(a) * 1.55, Math.sin(a) * 1.55, 0);
        fin.rotation.z = a;
        group.add(fin);
      }

      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.85, 3.1, 36, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x8fe8ff,
          transparent: true,
          opacity: 0.34,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      flame.position.z = 2.0;
      flame.rotation.x = Math.PI / 2;
      group.add(flame);

      scene.add(group);
      return { group, core, flame, glowMats };
    })();

    const voxelGarden = (() => {
      const group = new THREE.Group();
      group.visible = false;
      group.position.set(4.5, 0.25, -2.5);
      const mats = {
        grass: new THREE.MeshStandardMaterial({ color: 0x54c86a, roughness: 0.8 }),
        dirt: new THREE.MeshStandardMaterial({ color: 0x7a5134, roughness: 0.9 }),
        stone: new THREE.MeshStandardMaterial({ color: 0x777f8f, roughness: 0.85 }),
        glow: new THREE.MeshStandardMaterial({
          color: 0x73ffb8,
          emissive: 0x73ffb8,
          emissiveIntensity: 1.8,
        }),
      };
      for (let x = -3; x <= 3; x++) {
        for (let z = -2; z <= 2; z++) {
          const h = Math.max(1, Math.round(1.5 + Math.sin(x * 1.7 + z) * 1.1));
          for (let y = 0; y < h; y++) {
            const cube = new THREE.Mesh(
              new THREE.BoxGeometry(0.58, 0.58, 0.58),
              y === h - 1 ? mats.grass : y === 0 ? mats.stone : mats.dirt,
            );
            cube.position.set(x * 0.58, y * 0.58, z * 0.58);
            group.add(cube);
          }
        }
      }
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), mats.glow);
      gem.position.set(0, 2.5, 0);
      group.add(gem);
      scene.add(group);
      return { group, gem };
    })();

    const goodFriend = (() => {
      const group = new THREE.Group();
      group.visible = false;
      group.position.set(-2.8, 0.38, 2.7);
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xf0d19a,
        roughness: 0.8,
        emissive: 0x1e1204,
      });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.75 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.48, 1.25), bodyMat);
      body.position.y = 0.5;
      group.add(body);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.58, 0.62), bodyMat);
      head.position.set(0, 0.78, -0.82);
      group.add(head);
      for (const x of [-0.28, 0.28]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), darkMat);
        eye.position.set(x, 0.86, -1.15);
        group.add(eye);
      }
      for (const x of [-0.36, 0.36]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 4), bodyMat);
        ear.position.set(x, 1.13, -0.84);
        ear.rotation.z = x < 0 ? 0.55 : -0.55;
        group.add(ear);
      }
      for (const x of [-0.32, 0.32]) {
        for (const z of [-0.32, 0.42]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.54, 0.18), bodyMat);
          leg.position.set(x, 0.08, z);
          group.add(leg);
        }
      }
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.62), bodyMat);
      tail.position.set(0, 0.78, 0.86);
      tail.rotation.x = -0.8;
      group.add(tail);
      scene.add(group);
      return { group, tail };
    })();

    // ---- Planet Earth --------------------------------------------------
    // Inspired by the official Three.js Earth example: textured surface,
    // cloud shell, city lights, and a thin atmospheric rim. We generate
    // lightweight canvas textures locally to avoid adding remote assets.
    const earth = (() => {
      const group = new THREE.Group();
      // Pulled in a bit closer + lifted slightly so Earth is
      // unmissable in the default camera frame.
      group.position.set(22, 7, -32);
      group.rotation.z = -0.38;

      const surfaceMap = makeEarthTexture("surface");
      const cloudMap = makeEarthTexture("clouds");
      const lightsMap = makeEarthTexture("lights");

      const surface = new THREE.Mesh(
        new THREE.SphereGeometry(4.2, 64, 64),
        new THREE.MeshStandardMaterial({
          map: surfaceMap ?? undefined,
          roughness: 0.72,
          metalness: 0,
          emissive: 0x061328,
          emissiveIntensity: 0.18,
        }),
      );
      // Mark the surface as a clickable Earth so the raycaster can
      // open the Healdsburg preview when the user taps it.
      surface.userData.kind = "earth";
      group.add(surface);

      const cityLights = new THREE.Mesh(
        new THREE.SphereGeometry(4.205, 48, 48),
        new THREE.MeshBasicMaterial({
          map: lightsMap ?? undefined,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      group.add(cityLights);

      const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(4.28, 48, 48),
        new THREE.MeshStandardMaterial({
          map: cloudMap ?? undefined,
          transparent: true,
          opacity: 0.52,
          roughness: 0.9,
          metalness: 0,
          depthWrite: false,
        }),
      );
      group.add(clouds);

      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(4.55, 64, 64),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: {
            glowColor: { value: new THREE.Color(0x70d7ff) },
          },
          vertexShader: /* glsl */ `
            varying vec3 vNormal;
            void main() {
              vNormal = normalize(normalMatrix * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: /* glsl */ `
            uniform vec3 glowColor;
            varying vec3 vNormal;
            void main() {
              float rim = pow(1.0 - abs(vNormal.z), 2.4);
              gl_FragColor = vec4(glowColor, rim * 0.36);
            }
          `,
        }),
      );
      group.add(atmosphere);

      const orbit = new THREE.Mesh(
        new THREE.TorusGeometry(5.45, 0.012, 8, 128),
        new THREE.MeshBasicMaterial({
          color: 0x8fe8ff,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
        }),
      );
      orbit.rotation.x = Math.PI / 2.7;
      group.add(orbit);

      const poetCapsule = new THREE.Group();
      const capsuleBody = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.12, 0.36, 6, 12),
        new THREE.MeshStandardMaterial({
          color: 0xf8ecd2,
          roughness: 0.7,
          metalness: 0.05,
          emissive: 0x241a08,
        }),
      );
      poetCapsule.add(capsuleBody);
      const notebook = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.18, 0.03),
        new THREE.MeshStandardMaterial({
          color: 0x73ffb8,
          roughness: 0.8,
          emissive: 0x0b2418,
        }),
      );
      notebook.position.set(0.22, 0.06, 0.03);
      poetCapsule.add(notebook);
      group.add(poetCapsule);

      group.visible = layerVisibleRef.current.earth;
      scene.add(group);
      earthRef.current = group;
      return { group, surface, clouds, cityLights, poetCapsule };
    })();

    // ---- Orbiting spaceship ------------------------------------------
    // Procedural — small saucer + light beam — orbits the platform on a
    // gently tilted plane.
    const ship = (() => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.85, 0.3, 24),
        new THREE.MeshStandardMaterial({
          color: 0xeef0fa,
          metalness: 0.6,
          roughness: 0.35,
        }),
      );
      g.add(body);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 24, 18, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({
          color: 0x73ffb8,
          metalness: 0.3,
          roughness: 0.15,
          emissive: 0x114433,
          transparent: true,
          opacity: 0.85,
        }),
      );
      dome.position.y = 0.18;
      g.add(dome);
      // Blinking nav light.
      const navLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff5577 }),
      );
      navLight.position.set(0.7, 0, 0);
      g.add(navLight);
      g.visible = layerVisibleRef.current.ship;
      scene.add(g);
      (g as unknown as Record<string, unknown>).__nav = navLight;
      shipRef.current = g;
      return g;
    })();

    // ---- Vibey's journal (orbits the platform) -----------------------
    // A glowing leather-bound book that floats around the asteroid on
    // its own slow orbit. ~2x the original size so it reads from any
    // camera distance, with a real "V" painted on the cover via a
    // canvas texture (so the glyph is unmistakable, not abstract).
    {
      const group = new THREE.Group();

      // ----- Painted cover texture: deep leather + gold "V" -----------
      // CanvasTexture so the V is sharp from any angle, no font loading.
      const coverCanvas = document.createElement("canvas");
      coverCanvas.width = 512;
      coverCanvas.height = 384; // aspect mirrors the cover box
      const cctx = coverCanvas.getContext("2d");
      if (cctx) {
        // Leather gradient.
        const grad = cctx.createLinearGradient(0, 0, coverCanvas.width, coverCanvas.height);
        grad.addColorStop(0, "#5b3a1d");
        grad.addColorStop(0.55, "#2f1c0e");
        grad.addColorStop(1, "#1a0f06");
        cctx.fillStyle = grad;
        cctx.fillRect(0, 0, coverCanvas.width, coverCanvas.height);
        // Inset border to read as "book".
        cctx.strokeStyle = "rgba(212, 168, 90, 0.6)";
        cctx.lineWidth = 6;
        cctx.strokeRect(20, 20, coverCanvas.width - 40, coverCanvas.height - 40);
        // The "V". A bold serif-ish glyph painted in gold with a
        // subtle drop shadow so it reads embossed.
        cctx.font = "bold 280px 'Georgia', 'Times New Roman', serif";
        cctx.textAlign = "center";
        cctx.textBaseline = "middle";
        cctx.shadowColor = "rgba(0,0,0,0.55)";
        cctx.shadowBlur = 18;
        cctx.shadowOffsetX = 0;
        cctx.shadowOffsetY = 4;
        cctx.fillStyle = "#ffd28a";
        cctx.fillText("V", coverCanvas.width / 2, coverCanvas.height / 2 + 14);
        // Inner highlight stroke for a glint.
        cctx.shadowBlur = 0;
        cctx.shadowOffsetY = 0;
        cctx.strokeStyle = "rgba(255, 240, 200, 0.8)";
        cctx.lineWidth = 3;
        cctx.strokeText("V", coverCanvas.width / 2, coverCanvas.height / 2 + 14);
      }
      const coverTex = new THREE.CanvasTexture(coverCanvas);
      coverTex.colorSpace = THREE.SRGBColorSpace;
      coverTex.anisotropy = 8;

      // Book is ~2x previous dimensions.
      const BOOK_W = 1.3;
      const BOOK_H = 0.16;
      const BOOK_D = 0.96;

      // Use a 6-material BoxGeometry so the cover texture lands on the
      // TOP face only (the face the camera sees when the book is laid
      // flat). Other faces use solid leather.
      const leatherMat = new THREE.MeshStandardMaterial({
        color: 0x3a2412,
        roughness: 0.55,
        metalness: 0.1,
        emissive: 0x140a04,
        emissiveIntensity: 0.55,
      });
      const coverFaceMat = new THREE.MeshStandardMaterial({
        map: coverTex,
        roughness: 0.55,
        metalness: 0.1,
        emissive: 0x2a1a08,
        emissiveIntensity: 0.4,
      });
      // BoxGeometry material order: [+x, -x, +y, -y, +z, -z]. Top is +y.
      const cover = new THREE.Mesh(new THREE.BoxGeometry(BOOK_W, BOOK_H, BOOK_D), [
        leatherMat,
        leatherMat,
        coverFaceMat,
        leatherMat,
        leatherMat,
        leatherMat,
      ]);
      cover.userData.kind = "journal";
      group.add(cover);

      // Page edges — three stacked paper-yellow sheets visible from
      // the side, tucked inside the cover.
      for (let i = 0; i < 3; i++) {
        const page = new THREE.Mesh(
          new THREE.BoxGeometry(BOOK_W * 0.93, 0.022, BOOK_D * 0.92),
          new THREE.MeshStandardMaterial({
            color: 0xfdf6e3,
            roughness: 0.85,
            metalness: 0,
            emissive: 0xfdf6e3,
            emissiveIntensity: 0.18,
          }),
        );
        page.position.y = 0.1 + i * 0.026;
        page.userData.kind = "journal";
        group.add(page);
      }

      // Spine — vertical glowing stripe on the long edge.
      const spine = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, BOOK_H * 1.4, BOOK_D),
        new THREE.MeshBasicMaterial({
          color: 0xffd28a,
          transparent: true,
          opacity: 0.85,
        }),
      );
      spine.position.set(-BOOK_W / 2 - 0.01, 0.06, 0);
      spine.userData.kind = "journal";
      group.add(spine);

      // Outer warm halo — additive sphere that surrounds the book
      // so it glows against the starfield from any angle.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(BOOK_W, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffb95a,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.userData.kind = "journal";
      group.add(halo);
      // Stash the halo so the animation loop can pulse it.
      (group as unknown as Record<string, unknown>).__halo = halo;
      (group as unknown as Record<string, unknown>).__sigil = cover; // for pulse

      group.visible = true;
      scene.add(group);
      journalRef.current = group;
    }

    // ---- Alien on a Saucer (orbits Vibey) ---------------------------
    // The alien lives on his own little spacecraft that slowly circles
    // the platform. Loaded once on mount; the FOCUS toggle in the UI
    // routes emotes to him via alienMixerRef + alienActionsRef.
    {
      const saucerGroup = new THREE.Group();
      // Saucer body: flat disc with a glowing dome on top.
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 2.0, 0.35, 32),
        new THREE.MeshStandardMaterial({
          color: 0x141a30,
          metalness: 0.55,
          roughness: 0.35,
          emissive: 0x0a1530,
          emissiveIntensity: 0.4,
        }),
      );
      saucerGroup.add(disc);
      const ringLight = new THREE.Mesh(
        new THREE.TorusGeometry(1.85, 0.06, 16, 64),
        new THREE.MeshBasicMaterial({
          color: 0xb392ff,
          transparent: true,
          opacity: 0.9,
        }),
      );
      ringLight.rotation.x = Math.PI / 2;
      ringLight.position.y = 0.05;
      saucerGroup.add(ringLight);
      // Underside glow halo so the spacecraft feels like it's hovering.
      const underglow = new THREE.Mesh(
        new THREE.CircleGeometry(2.2, 48),
        new THREE.MeshBasicMaterial({
          color: 0xb392ff,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      underglow.rotation.x = -Math.PI / 2;
      underglow.position.y = -0.21;
      saucerGroup.add(underglow);
      // (No dome — character stands on the open disc so we can see
      // them dance.)

      // Pick whichever character was chosen in the lobby. Default is
      // the alien — only change if the user picked a different
      // character that maps to a known GLB URL.
      const lobbyPick = (() => {
        try { return localStorage.getItem("lobby.character"); } catch { return null; }
      })();
      let saucerCharUrl = alienUrl;
      if (lobbyPick && lobbyPick !== "alien" && lobbyPick !== "vibey") {
        // The Lobby's char id is the GLB filename without extension —
        // find the URL whose path ends with `${id}.glb`.
        const pickUrl = Object.entries(LOBBY_CHARACTER_URLS).find(
          ([path]) => path.endsWith(`/${lobbyPick}.glb`),
        )?.[1];
        if (pickUrl) saucerCharUrl = pickUrl;
      }
      const alienLoader = new GLTFLoader();
      alienLoader.load(
        saucerCharUrl,
        (gltf) => {
          const alien = gltf.scene;
          alien.position.set(0, 0, 0);
          alien.updateMatrixWorld(true);
          // Normalize so he stands ~1.4 units tall — and crucially,
          // sit his feet on the saucer disc by lifting the *post-
          // scale* bbox.min.y. Without this, the GLB's origin (often
          // at the model center, sometimes well below the feet from
          // the assimp FBX→GLB conversion) leaves him buried in the
          // disc or floating in front of it.
          const box = new THREE.Box3().setFromObject(alien);
          const size = new THREE.Vector3();
          box.getSize(size);
          // Normalize by the largest dimension — Quaternius FBX→GLB
          // characters can have weird armature scales that fool a
          // height-only fit. Same recipe the Lobby uses.
          const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
          const fit = 1.4 / maxDim;
          alien.scale.setScalar(fit);
          alien.updateMatrixWorld(true);
          const scaledBox = new THREE.Box3().setFromObject(alien);
          // Stand on the saucer disc (top ~0.18) by lifting the post-
          // scale bbox min.
          alien.position.y = 0.18 - scaledBox.min.y;
          alien.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            const apply = (mat: THREE.Material) => {
              const std = mat as THREE.MeshStandardMaterial;
              if (std && "metalness" in std) {
                std.metalness = Math.min(std.metalness, 0.3);
                std.roughness = Math.max(std.roughness, 0.45);
                std.envMapIntensity = 1.0;
                std.needsUpdate = true;
              }
            };
            const mat = mesh.material;
            if (Array.isArray(mat)) mat.forEach(apply);
            else if (mat) apply(mat);
          });
          saucerGroup.add(alien);

          // Wire up the mixer + action map so the emote system can
          // play any of the 14 baked clips.
          const mixer = new THREE.AnimationMixer(alien);
          alienMixerRef.current = mixer;
          for (const clip of gltf.animations) {
            alienActionsRef.current.set(clip.name, mixer.clipAction(clip));
          }
          // Start him idling.
          // Pick whichever clip name matches "Idle" — works for the
          // alien (AlienArmature|Alien_Idle) and any Quaternius char
          // (CharacterArmature|Idle) the user might have picked.
          const idleKey = [...alienActionsRef.current.keys()].find((k) =>
            /idle/i.test(k),
          ) ?? [...alienActionsRef.current.keys()][0];
          const idle = idleKey ? alienActionsRef.current.get(idleKey) : null;
          if (idle) {
            idle.setLoop(THREE.LoopRepeat, Infinity).play();
            alienActiveActionRef.current = idle;
          }
        },
        undefined,
        (err) => {
          console.error("[alien-saucer] load failed", err);
        },
      );

      // Mark the saucer for the orbit logic in the render tick.
      saucerGroup.position.set(7, 4, 0);
      saucerGroup.userData.orbitRadius = 7;
      saucerGroup.userData.orbitHeight = 4;
      saucerGroup.userData.orbitSpeed = 0.18; // rad/sec
      saucerGroup.userData.orbitPhase = 0; // current angle
      scene.add(saucerGroup);
      alienSaucerGroupRef.current = saucerGroup;
    }

    // ---- Disco mode (dance party) ------------------------------------
    // Procedural disco ball + 4 colored rotating point lights + 4
    // Quaternius dancers in a circle around Vibey. Hidden by default;
    // flip "disco" in the Layers panel to drop the beat. All
    // animation happens in the main render loop below — references
    // stashed on userData so the tick can read them.
    {
      const discoGroup = new THREE.Group();
      discoGroup.visible = layerVisibleRef.current.disco;

      // -- Disco ball: faceted icosahedron, mirror-shiny, hung above Vibey.
      const ball = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 1),
        new THREE.MeshStandardMaterial({
          color: 0xeeeeff,
          metalness: 0.95,
          roughness: 0.12,
          emissive: 0x222244,
          emissiveIntensity: 0.4,
          flatShading: true,
        }),
      );
      ball.position.set(0, 6.2, 0); // hangs over Vibey's head
      discoGroup.add(ball);
      // Subtle bloom-friendly inner sparkle so the ball reads as glowy.
      const ballSparkle = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffd2ee,
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ballSparkle.position.copy(ball.position);
      discoGroup.add(ballSparkle);
      (discoGroup as unknown as Record<string, unknown>).__ball = ball;

      // -- Four rotating colored point lights orbiting overhead.
      // Saturated palette so the dance floor reads as Saturday-night.
      const palette = [0xff3b8a, 0x6cf, 0xffe26a, 0x73ffb8];
      const lights: THREE.PointLight[] = [];
      for (let i = 0; i < palette.length; i++) {
        const pl = new THREE.PointLight(palette[i], 6, 22, 1.8);
        pl.userData.phase = (i / palette.length) * Math.PI * 2;
        discoGroup.add(pl);
        lights.push(pl);
      }
      (discoGroup as unknown as Record<string, unknown>).__lights = lights;

      // -- Four backup dancers, evenly spaced around Vibey.
      // Hand-picked Quaternius characters with the broadest visual variety.
      interface DancerSlot {
        url: string;
        scale: number;
      }
      const dancers: DancerSlot[] = [
        { url: QUATERNIUS_CHARS.Wizard ?? "", scale: 1 },
        { url: QUATERNIUS_CHARS.Chef_Female ?? "", scale: 1 },
        { url: QUATERNIUS_CHARS.Cowboy_Male ?? "", scale: 1 },
        { url: QUATERNIUS_CHARS.Knight_Male ?? "", scale: 1 },
      ];
      const DANCE_RING_R = 3.2;
      dancers.forEach((slot, i) => {
        if (!slot.url) return;
        const angle = (i / dancers.length) * Math.PI * 2 + Math.PI / 4;
        const px = Math.cos(angle) * DANCE_RING_R;
        const pz = Math.sin(angle) * DANCE_RING_R;
        const carrier = new THREE.Group();
        carrier.position.set(px, 0, pz);
        // Face inward toward Vibey at origin.
        carrier.rotation.y = Math.atan2(0 - pz, 0 - px) + Math.PI / 2;
        discoGroup.add(carrier);

        new GLTFLoader().load(
          slot.url,
          (gltf) => {
            const model = gltf.scene;
            // Bottom-anchor — same pattern the lobby + garden use.
            model.position.set(0, 0, 0);
            model.scale.setScalar(slot.scale);
            model.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(model);
            const size = new THREE.Vector3();
            box.getSize(size);
            const fit = 1.6 / Math.max(size.y, 0.01);
            model.scale.setScalar(fit * slot.scale);
            model.updateMatrixWorld(true);
            const box1 = new THREE.Box3().setFromObject(model);
            model.position.y = -box1.min.y;
            const center = new THREE.Vector3();
            box1.getCenter(center);
            model.position.x = -center.x;
            model.position.z = -center.z;
            model.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) {
                (o as THREE.Mesh).castShadow = false;
                (o as THREE.Mesh).receiveShadow = false;
              }
            });
            carrier.add(model);

            // Find the Dance clip (or fall back to whatever's available).
            if (gltf.animations && gltf.animations.length > 0) {
              const mixer = new THREE.AnimationMixer(model);
              const danceClip =
                gltf.animations.find((c) => /dance/i.test(c.name)) ??
                gltf.animations.find((c) => /idle/i.test(c.name)) ??
                gltf.animations[0];
              if (danceClip) {
                const action = mixer.clipAction(danceClip);
                action.setLoop(THREE.LoopRepeat, Infinity);
                // Slight per-dancer time offset so they don't move
                // in lockstep — reads as a real little crowd.
                action.time = Math.random() * danceClip.duration;
                action.play();
              }
              discoMixersRef.current.push(mixer);
            }
          },
          undefined,
          (err) => console.warn("[disco] dancer failed to load", err),
        );
      });

      scene.add(discoGroup);
      discoGroupRef.current = discoGroup;
    }

    // ---- 3D Gallery TV ------------------------------------------------
    // A floating wall-mounted TV opposite the Earth + moon (which sit on
    // the back-left). Hidden until the gallery experience spawns; an
    // outer effect swaps `screenMat.map` to the current photo texture.
    {
      const tv = new THREE.Group();
      // Bezel — chunky retro frame.
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(8.4, 5.4, 0.5),
        new THREE.MeshStandardMaterial({
          color: 0x1a2440,
          roughness: 0.55,
          metalness: 0.4,
          emissive: 0x0a1530,
          emissiveIntensity: 0.6,
        }),
      );
      tv.add(frame);
      // Screen — slightly inset, plain BasicMaterial so the photo reads
      // bright regardless of scene lighting.
      const screenMat = new THREE.MeshBasicMaterial({
        color: 0x0a0f1a,
        toneMapped: false,
      });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 4.4), screenMat);
      // Default plane normal is +Z, and we'll yaw the whole TV so its
      // local +Z points at the platform — so the screen sits on +Z.
      screen.position.z = 0.27;
      tv.add(screen);
      // Soft glow halo behind the screen.
      const halo = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 7),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
      );
      halo.position.z = -0.4;
      tv.add(halo);
      // Three small thrusters underneath so it reads as a hovering
      // spacecraft, not a wall TV. Each is a glowing emissive sphere
      // mounted on the screen-facing side so the camera sees them.
      const thrusterMat = new THREE.MeshBasicMaterial({
        color: 0x73ffb8,
        transparent: true,
        opacity: 0.85,
      });
      [-2.6, 0, 2.6].forEach((x) => {
        const th = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), thrusterMat);
        th.position.set(x, -2.95, 0.35);
        tv.add(th);
        const flare = new THREE.Mesh(
          new THREE.SphereGeometry(0.45, 16, 12),
          new THREE.MeshBasicMaterial({
            color: 0x73ffb8,
            transparent: true,
            opacity: 0.18,
            depthWrite: false,
          }),
        );
        flare.position.copy(th.position);
        tv.add(flare);
      });

      // Position opposite the planet/moon (Earth back-left). Front-right
      // quadrant, big enough to read as a distant billboard.
      tv.position.set(38, 9, 32);
      tv.userData.homeY = 9;
      tv.scale.setScalar(1.8);
      // Yaw-only rotation so the TV stays upright (lookAt would tilt it
      // and reorient the thrusters away from "down").
      tv.rotation.y = Math.atan2(0 - 38, 0 - 32);
      tv.visible = false;
      scene.add(tv);
      tvGroupRef.current = tv;
      tvScreenMatRef.current = screenMat;
    }

    // ---- Asteroid belt: a slowly-drifting ring of rocks -------------
    // Tilted ring around the platform so it reads as orbital debris.
    const asteroidBelt = new THREE.Group();
    {
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x6e7591,
        roughness: 0.95,
        metalness: 0.05,
      });
      const rockGeos = [
        new THREE.IcosahedronGeometry(0.32, 0),
        new THREE.IcosahedronGeometry(0.45, 0),
        new THREE.IcosahedronGeometry(0.22, 0),
      ];
      for (let i = 0; i < 90; i++) {
        const r = 24 + Math.random() * 7;
        const a = Math.random() * Math.PI * 2;
        const rock = new THREE.Mesh(
          rockGeos[i % rockGeos.length],
          rockMat,
        );
        rock.position.set(
          Math.cos(a) * r,
          (Math.random() - 0.5) * 1.4,
          Math.sin(a) * r,
        );
        rock.rotation.set(
          Math.random() * Math.PI,
          Math.random() * Math.PI,
          Math.random() * Math.PI,
        );
        const s = 0.5 + Math.random() * 1.0;
        rock.scale.setScalar(s);
        asteroidBelt.add(rock);
      }
      asteroidBelt.rotation.x = 0.18; // slight tilt
      asteroidBelt.rotation.z = 0.05;
      asteroidBelt.visible = layerVisibleRef.current.asteroids;
      scene.add(asteroidBelt);
      asteroidBeltRef.current = asteroidBelt;
    }

    // ---- Aurora ribbon: undulating gradient curtain in the sky ------
    let auroraMat: THREE.ShaderMaterial | null = null;
    {
      const auroraGeo = new THREE.PlaneGeometry(60, 14, 60, 1);
      auroraMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec3 p = position;
            // Gentle wave so the curtain ripples horizontally.
            p.y += sin(p.x * 0.18 + uTime * 0.6) * 1.2;
            p.z += cos(p.x * 0.12 + uTime * 0.4) * 0.8;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            float v = vUv.y;
            // Mint → violet → pink gradient that breathes with time.
            vec3 mint = vec3(0.45, 1.0, 0.72);
            vec3 violet = vec3(0.6, 0.4, 1.0);
            vec3 pink = vec3(1.0, 0.55, 0.85);
            float t = sin(uTime * 0.4 + vUv.x * 4.0) * 0.5 + 0.5;
            vec3 col = mix(mix(mint, violet, t), pink, vUv.x);
            // Vertical alpha falloff so edges feather into space.
            // Feather all four edges so the curtain dissolves into space
            // instead of cutting hard along the plane geometry.
            float vFade = smoothstep(0.0, 0.35, v) * smoothstep(1.0, 0.65, v);
            float hFade = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
            float alpha = vFade * hFade * 0.55;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const aurora = new THREE.Mesh(auroraGeo, auroraMat);
      aurora.position.set(-5, 22, -45);
      aurora.rotation.z = 0.1;
      aurora.visible = layerVisibleRef.current.aurora;
      scene.add(aurora);
      auroraRef.current = aurora;
    }

    // ---- Comet: streaks past every ~30s with a long fading trail ----
    const cometGroup = new THREE.Group();
    let cometStartTime = -1;
    let nextCometAt = performance.now() + 8000;
    const cometStart = new THREE.Vector3(-65, 22, -10);
    const cometEnd = new THREE.Vector3(70, -8, 30);
    {
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      cometGroup.add(head);
      // Tail: a stretched, additive-blended cone.
      const tailMat = new THREE.MeshBasicMaterial({
        color: 0xa9d8ff,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 6.5, 18, 1, true),
        tailMat,
      );
      // Tail behind the head (we'll orient the group along its velocity).
      tail.rotation.x = -Math.PI / 2;
      tail.position.z = -3.25;
      cometGroup.add(tail);
      cometGroup.visible = false;
      scene.add(cometGroup);
      cometRef.current = cometGroup;
    }

    // ---- Iridescent Arc (Meshy GLB) ---------------------------------
    // A backdrop arch behind the platform on the opposite side from the
    // Gallery TV. Slowly rotates so the iridescent surface shimmers as
    // the light catches it from different angles.
    let arcGroup: THREE.Group | null = null;
    {
      const arcLoader = new GLTFLoader();
      arcLoader.load(
        iridescentArcUrl,
        (gltf) => {
          arcGroup = gltf.scene;
          // Normalize to a known size — Meshy meshes are inconsistent.
          const box = new THREE.Box3().setFromObject(arcGroup);
          const size = new THREE.Vector3();
          box.getSize(size);
          const target = 8; // ~1/3 of the previous size per user request
          const fit = target / Math.max(size.x, size.y, size.z, 0.0001);
          arcGroup.scale.setScalar(fit);
          arcGroup.position.set(-18, 4, -14);
          arcGroup.rotation.y = Math.PI * 0.18;
          // Make sure the iridescent texture actually shines. The Meshy
          // GLB ships PBR materials whose metalness reads near-black
          // without an environment map. Boost emissive (so the baked
          // texture shows even with no light) and tone metalness down.
          arcGroup.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            const apply = (m: THREE.Material) => {
              const std = m as THREE.MeshStandardMaterial;
              if (std && "metalness" in std) {
                std.metalness = Math.min(std.metalness, 0.25);
                std.roughness = Math.max(std.roughness, 0.4);
                // Use the diffuse map as a glow source so it reads
                // against the dark sky regardless of lighting.
                if (std.map) {
                  std.emissiveMap = std.map;
                  std.emissive = new THREE.Color(0xffffff);
                  std.emissiveIntensity = 0.55;
                }
                std.envMapIntensity = 1.0;
                std.needsUpdate = true;
              }
            };
            const mat = mesh.material;
            if (Array.isArray(mat)) mat.forEach(apply);
            else if (mat) apply(mat);
          });
          arcGroup.visible = layerVisibleRef.current.arc;
          scene.add(arcGroup);
          arcRef.current = arcGroup;
        },
        undefined,
        (err) => {
          console.error("[Vibey] iridescent arc failed", err);
        },
      );
    }

    // ---- Rocky (gilded golem) ---------------------------------------
    // A second character that hangs out on the platform with Vibey.
    {
      const rockyLoader = new GLTFLoader();
      rockyLoader.load(
        rockyUrl,
        (gltf) => {
          const rocky = gltf.scene;
          const box = new THREE.Box3().setFromObject(rocky);
          const size = new THREE.Vector3();
          box.getSize(size);
          // Normalize by his largest dimension — the GLB is a sprawled
          // creature so a height-only fit was making him tiny+low.
          const fit = 2.6 / Math.max(size.x, size.y, size.z, 0.0001);
          rocky.scale.setScalar(fit);
          // Park him on the platform near Vibey's right; lift his Y so
          // he sits ON the disc instead of half-clipping into it.
          rocky.position.set(2.6, 0.4, 1.4);
          rocky.rotation.y = -0.7; // angle toward Vibey
          // PBR clamp so the gilded textures don't read black.
          rocky.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            const apply = (mat: THREE.Material) => {
              const std = mat as THREE.MeshStandardMaterial;
              if (std && "metalness" in std) {
                std.metalness = Math.min(std.metalness, 0.5);
                std.roughness = Math.max(std.roughness, 0.3);
                std.envMapIntensity = 1.0;
                std.needsUpdate = true;
              }
            };
            const mat = mesh.material;
            if (Array.isArray(mat)) mat.forEach(apply);
            else if (mat) apply(mat);
          });
          rocky.visible = layerVisibleRef.current.rocky;
          scene.add(rocky);
          rockyRef.current = rocky;
        },
        undefined,
        (err) => {
          console.error("[Vibey] rocky failed", err);
        },
      );
    }

    // ---- Floating platform -------------------------------------------
    const platformRadius = 6.5;
    {
      // Top disc, slight bevel, glowing rim.
      const topGeo = new THREE.CylinderGeometry(platformRadius, platformRadius - 0.4, 0.4, 64);
      const topMat = new THREE.MeshStandardMaterial({
        color: 0x1a2542,
        roughness: 0.65,
        metalness: 0.25,
      });
      const top = new THREE.Mesh(topGeo, topMat);
      top.position.y = -0.2;
      scene.add(top);

      const baseGeo = new THREE.CylinderGeometry(platformRadius - 0.4, platformRadius - 1.6, 1.2, 64);
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x101733,
        roughness: 0.85,
        metalness: 0.15,
      });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = -1.0;
      scene.add(base);

      // Rocky underside spire so it reads as a floating asteroid.
      const spireGeo = new THREE.ConeGeometry(platformRadius - 1.6, 4, 24);
      const spire = new THREE.Mesh(spireGeo, baseMat);
      spire.position.y = -3.2;
      spire.rotation.y = Math.PI;
      scene.add(spire);

      // Glowing ring sitting just above the platform surface.
      const ringGeo = new THREE.RingGeometry(platformRadius - 0.1, platformRadius + 0.2, 96);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x73ffb8,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      scene.add(ring);
    }

    // ---- Lighting ----------------------------------------------------
    scene.add(new THREE.AmbientLight(0x4a5fa8, 0.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-6, 10, 6);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.8);
    rim.position.set(8, 4, -8);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xff7eb3, 0.35);
    fill.position.set(8, -2, 8);
    scene.add(fill);

    // ---- Unit-7 model + animation -----------------------------------
    let model: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<Unit7AnimName, THREE.AnimationAction>();
    let activeAction: THREE.AnimationAction | null = null;
    let lastAnim: Unit7AnimName | null = null;
    let lastPulse = -1;
    let faceMesh: THREE.Mesh | null = null;
    const morphIndex: Partial<Record<Unit7Expression, number>> = {};
    const originalRobotColors = new Map<THREE.Material, THREE.Color>();
    let lastAppliedRobotColor: number | null | undefined = undefined;

    function play(name: Unit7AnimName, restart = false) {
      const next = actions.get(name);
      if (!next) return;
      const oneShot = ONE_SHOTS.has(name);
      const held = HELD_POSES.has(name);
      if (activeAction === next && !restart) return;
      if (activeAction && activeAction !== next) activeAction.fadeOut(0.18);
      next.reset();
      if (oneShot || held) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      }
      next.fadeIn(0.18).play();
      activeAction = next;
    }

    const loader = new GLTFLoader();
    let disposed = false;
    loader.load(unit7ModelUrl, (gltf) => {
      if (disposed) return;
      model = gltf.scene;
      scene.add(model);

      mixer = new THREE.AnimationMixer(model);
      mixer.addEventListener("finished", (e: { action: THREE.AnimationAction }) => {
        const finishedName = e.action.getClip().name as Unit7AnimName;
        // True one-shots (Wave, Punch, etc.) revert to whatever locomotion
        // he was doing. Held poses (Sitting, Standing, Death) stay frozen
        // on the last frame until the user picks something else.
        if (ONE_SHOTS.has(finishedName)) {
          desiredAnimRef.current = baseAnimRef.current;
          animPulseRef.current++;
        }
      });
      for (const clip of gltf.animations) {
        actions.set(clip.name as Unit7AnimName, mixer.clipAction(clip));
      }

      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of mats) {
          const standardMaterial = material as THREE.MeshStandardMaterial;
          if (standardMaterial.color && !originalRobotColors.has(standardMaterial)) {
            originalRobotColors.set(standardMaterial, standardMaterial.color.clone());
          }
        }
        const dict = mesh.morphTargetDictionary;
        if (dict && ("Angry" in dict || "Surprised" in dict || "Sad" in dict)) {
          faceMesh = mesh;
          if ("Angry" in dict) morphIndex.Angry = dict["Angry"];
          if ("Surprised" in dict) morphIndex.Surprised = dict["Surprised"];
          if ("Sad" in dict) morphIndex.Sad = dict["Sad"];
        }
      });

      play("Idle");
      lastAnim = "Idle";
    });

    // ---- Agentic wander on the platform -----------------------------
    // Pick a random target inside the platform, walk there, idle, repeat.
    let target: THREE.Vector3 | null = null;
    let idleUntil = performance.now() + 2000;
    function pickTarget() {
      const r = Math.random() * (platformRadius - 1.2);
      const theta = Math.random() * Math.PI * 2;
      target = new THREE.Vector3(r * Math.cos(theta), 0, r * Math.sin(theta));
    }

    // ---- Shooting stars (occasional streaks across the sky) ---------
    type ShootingStar = {
      line: THREE.Line;
      mat: THREE.LineBasicMaterial;
      age: number;
      lifetime: number;
      velocity: THREE.Vector3;
      head: THREE.Vector3;
    };
    const shootingStars: ShootingStar[] = [];
    let nextShooterAt = performance.now() + 1500;
    function spawnShootingStar() {
      const head = new THREE.Vector3(
        (Math.random() - 0.5) * 120,
        30 + Math.random() * 30,
        -50 - Math.random() * 60,
      );
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 80,
        -20 - Math.random() * 20,
        20 + Math.random() * 30,
      );
      const tail = head.clone().sub(velocity.clone().multiplyScalar(0.04));
      const positions = new Float32Array([
        head.x, head.y, head.z,
        tail.x, tail.y, tail.z,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xfff0c8,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      shootingStars.push({
        line,
        mat,
        age: 0,
        lifetime: 0.9 + Math.random() * 0.5,
        velocity,
        head,
      });
    }

    // ---- Animation loop ---------------------------------------------
    let lastTime = performance.now();
    let raf = 0;
    let shipAngle = 0;
    let nextDiscoveryAt = performance.now() + 26000;
    let nextShowBeatAt = performance.now() + 9000;
    const tick = () => {
      const now = performance.now();
      const delta = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      if (mixer) mixer.update(delta);

      // Push expression weights every frame so morphs ride on top of
      // the skeleton animation.
      if (faceMesh && faceMesh.morphTargetInfluences) {
        for (const name of ["Angry", "Surprised", "Sad"] as Unit7Expression[]) {
          const idx = morphIndex[name];
          if (typeof idx === "number") {
            const w = expressionsRef.current[name] ?? 0;
            faceMesh.morphTargetInfluences[idx] = Math.max(0, Math.min(1, w));
          }
        }
      }

      // Apply external animation requests (button clicks / chat).
      if (
        lastAnim !== desiredAnimRef.current ||
        lastPulse !== animPulseRef.current
      ) {
        play(desiredAnimRef.current, lastPulse !== animPulseRef.current);
        lastAnim = desiredAnimRef.current;
        lastPulse = animPulseRef.current;
      }

      // Sprint is a short player-triggered burst across the platform.
      if (model && sprintStartRef.current > 0) {
        const elapsed = (now - sprintStartRef.current) / 1000;
        const dur = 1.2;
        if (elapsed < dur) {
          const forward = new THREE.Vector3(
            Math.sin(model.rotation.y),
            0,
            Math.cos(model.rotation.y),
          );
          const step = 5.2 * delta * (1 - elapsed / dur * 0.35);
          model.position.x += forward.x * step;
          model.position.z += forward.z * step;
          const distFromCenter = Math.hypot(model.position.x, model.position.z);
          const maxDist = platformRadius - 0.9;
          if (distFromCenter > maxDist) {
            const scale = maxDist / distFromCenter;
            model.position.x *= scale;
            model.position.z *= scale;
            model.rotation.y += Math.PI * 0.65;
          }
        } else {
          sprintStartRef.current = 0;
          target = null;
          idleUntil = now + 900;
          desiredAnimRef.current = "Idle";
          baseAnimRef.current = "Idle";
          animPulseRef.current++;
        }
      }

      // Wander loop, but only when the desired anim is one of the
      // locomotion states (Idle / Walking). Don't override an emote.
      if (
        model &&
        sprintStartRef.current === 0 &&
        (desiredAnimRef.current === "Idle" || desiredAnimRef.current === "Walking")
      ) {
        if (!target) {
          if (now >= idleUntil) {
            pickTarget();
            desiredAnimRef.current = "Walking";
            baseAnimRef.current = "Walking";
            animPulseRef.current++;
          } else if (desiredAnimRef.current !== "Idle") {
            desiredAnimRef.current = "Idle";
            baseAnimRef.current = "Idle";
            animPulseRef.current++;
          }
        } else {
          const pos = new THREE.Vector3(model.position.x, 0, model.position.z);
          const dir = target.clone().sub(pos);
          const dist = dir.length();
          if (dist < 0.15) {
            target = null;
            idleUntil = now + 1500 + Math.random() * 3500;
            desiredAnimRef.current = "Idle";
            baseAnimRef.current = "Idle";
            animPulseRef.current++;
            // 30% chance to throw in a wave on arrival.
            if (Math.random() < 0.3) {
              setTimeout(() => {
                if (desiredAnimRef.current === "Idle") {
                  desiredAnimRef.current = "Wave";
                  animPulseRef.current++;
                }
              }, 600);
            }
          } else {
            dir.normalize();
            const step = Math.min(dist, 1.6 * delta);
            model.position.x += dir.x * step;
            model.position.z += dir.z * step;
            // Face direction of motion. The GLB faces +Z by default, so
            // we want yaw such that local +Z aligns with `dir`.
            model.rotation.y = Math.atan2(dir.x, dir.z);
          }
        }
      }

      // ---- Backflip (procedural): rotate model on X over ~0.85s -----
      if (model && backflipStartRef.current > 0) {
        const elapsed = (now - backflipStartRef.current) / 1000;
        const dur = 0.85;
        if (elapsed < dur) {
          const t = elapsed / dur;
          // Ease out so the rotation slows on landing.
          const eased = 1 - Math.pow(1 - t, 2);
          model.rotation.x = -Math.PI * 2 * eased;
        } else {
          model.rotation.x = 0;
          backflipStartRef.current = 0;
        }
      }

      // ---- Robot tint -----------------------------------------------
      // Recolor the model to whatever color the user picked, or restore
      // the original GLB material colors when "Original" is selected.
      if (model && robotColorRef.current !== lastAppliedRobotColor) {
        const c = robotColorRef.current;
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const sm = m as THREE.MeshStandardMaterial;
            if (sm && sm.color && !sm.userData.skipTint) {
              if (typeof c === "number") {
                sm.color.setHex(c);
              } else {
                const original = originalRobotColors.get(sm);
                if (original) sm.color.copy(original);
              }
            }
          }
        });
        lastAppliedRobotColor = c;
      }

      // ---- Galaxy + planets + moon slow rotation -------------------
      galaxy.rotation.y += delta * 0.012;
      milkyWay.rotation.y += delta * 0.003;
      constellation.group.rotation.z += delta * 0.004;
      const constellationPulse =
        constellationStartRef.current > 0
          ? Math.max(0, 1 - (now - constellationStartRef.current) / 5200)
          : 0;
      constellation.lineMat.opacity = 0.12 + constellationPulse * 0.72;
      constellation.starMat.opacity =
        0.35 + constellationPulse * 0.58 + Math.abs(Math.sin(now * 0.003)) * 0.08;
      planet.rotation.y += delta * 0.05;
      moon.rotation.y += delta * 0.08;
      earth.group.rotation.y += delta * 0.018;
      earth.surface.rotation.y += delta * 0.045;
      earth.cityLights.rotation.y = earth.surface.rotation.y;
      earth.clouds.rotation.y += delta * 0.06;
      const poetAngle = now * 0.00035;
      earth.poetCapsule.position.set(
        Math.cos(poetAngle) * 5.45,
        Math.sin(poetAngle * 1.7) * 0.85,
        Math.sin(poetAngle) * 5.45,
      );
      earth.poetCapsule.lookAt(0, 0, 0);

      // ---- Beacon and portal event pulses ---------------------------
      const beaconPulse =
        beaconStartRef.current > 0
          ? Math.max(0, 1 - (now - beaconStartRef.current) / 3600)
          : 0;
      beacon.rings.forEach((ring, i) => {
        const local = Math.max(0, Math.min(1, beaconPulse * 1.25 - i * 0.18));
        ring.scale.setScalar(1 + (1 - local) * (0.8 + i * 0.18));
        ring.position.y = 0.14 + i * 0.12 + (1 - local) * 1.3;
        (ring.material as THREE.MeshBasicMaterial).opacity = local * 0.55;
      });
      (beacon.beam.material as THREE.MeshBasicMaterial).opacity =
        beaconPulse * (0.08 + Math.abs(Math.sin(now * 0.008)) * 0.08);

      holoField.rings.forEach((ring, i) => {
        const holoVisible = beaconPulse > 0.02;
        holoField.group.visible = holoVisible;
        ring.rotation.z += delta * (0.08 + i * 0.012) * (i % 2 === 0 ? 1 : -1);
        ring.position.y = 0.12 + i * 0.05 + Math.sin(now * 0.0014 + i) * 0.03;
        (ring.material as THREE.MeshBasicMaterial).opacity =
          0.05 +
          beaconPulse * 0.28 +
          Math.abs(Math.sin(now * 0.002 + i)) * 0.045;
      });
      holoField.group.rotation.y += delta * 0.045;
      holoField.scanLine.rotation.z -= delta * (0.5 + beaconPulse * 1.4);
      (holoField.scanLine.material as THREE.MeshBasicMaterial).opacity =
        0.045 + beaconPulse * 0.16 + Math.abs(Math.sin(now * 0.003)) * 0.025;
      holoField.tickMat.opacity = 0.2 + beaconPulse * 0.42;

      ionBloom.group.visible = activeExperienceRef.current === "ion";
      voxelGarden.group.visible = activeExperienceRef.current === "blocks";
      goodFriend.group.visible = activeExperienceRef.current === "friend";

      if (activeExperienceRef.current === "ion") {
        ionBloom.group.rotation.y += delta * 0.35;
        ionBloom.core.rotation.x += delta * 0.9;
        ionBloom.core.rotation.y += delta * 1.1;
        ionBloom.flame.scale.setScalar(0.9 + Math.abs(Math.sin(now * 0.006)) * 0.25);
        ionBloom.glowMats.forEach((mat, i) => {
          mat.emissiveIntensity = 2.4 + Math.abs(Math.sin(now * 0.003 + i)) * 1.6;
        });
      }
      if (activeExperienceRef.current === "blocks") {
        voxelGarden.group.rotation.y += delta * 0.08;
        voxelGarden.gem.rotation.y += delta * 1.2;
        voxelGarden.gem.position.y = 2.5 + Math.sin(now * 0.003) * 0.18;
      }
      if (activeExperienceRef.current === "friend") {
        goodFriend.group.rotation.y = Math.sin(now * 0.0015) * 0.35;
        goodFriend.tail.rotation.y = Math.sin(now * 0.012) * 0.7;
      }

      // Unit-7 occasionally narrates his own observations. This keeps the
      // scene feeling inhabited without forcing the user to press buttons.
      if (now >= nextDiscoveryAt) {
        const line = DISCOVERY_LINES[Math.floor(Math.random() * DISCOVERY_LINES.length)];
        setMessages((current) => [
          ...current,
          { id: current.length + 1, who: "bot", text: line },
        ]);
        if (Math.random() < 0.5) {
          desiredAnimRef.current = "Wave";
          animPulseRef.current++;
        }
        nextDiscoveryAt = now + 28000 + Math.random() * 26000;
      }

      if (showModeRef.current && now >= nextShowBeatAt) {
        // Prefer an AI-generated beat; fall back to the scripted pool
        // when the queue is empty.
        const aiBeat = aiBeatsRef.current.shift();
        const beat = aiBeat ??
          SHOW_MONOLOGUES[Math.floor(Math.random() * SHOW_MONOLOGUES.length)];
        // Keep a rolling history so the AI fetcher can dodge repeats.
        recentBeatsRef.current = [...recentBeatsRef.current, beat.line].slice(-8);
        if (beat.mood) {
          const cleared: Record<Unit7Expression, number> = {
            Angry: 0,
            Surprised: 0,
            Sad: 0,
          };
          cleared[beat.mood] = 0.85;
          expressionsRef.current = cleared;
          setActiveMood(beat.mood);
        } else {
          expressionsRef.current = { Angry: 0, Surprised: 0, Sad: 0 };
          setActiveMood(null);
        }
        desiredAnimRef.current = beat.anim;
        if (!ONE_SHOTS.has(beat.anim)) baseAnimRef.current = beat.anim;
        animPulseRef.current++;
        setMessages((current) => [
          ...current,
          { id: current.length + 1, who: "bot", text: beat.line },
        ]);
        setShowMood(beat.mood ? beat.mood.toLowerCase() : "improvising");
        setShowThought(beat.line);
        // 35-60s between show beats — enough breathing room that the
        // narrative feels intentional, not chatty.
        nextShowBeatAt = now + 35000 + Math.random() * 25000;
      }

      // ---- Spaceship orbit + nav light blink + beam pulse ----------
      shipAngle += delta * 0.32;
      const shipR = 12;
      ship.position.set(
        Math.cos(shipAngle) * shipR,
        5 + Math.sin(shipAngle * 2) * 0.4,
        Math.sin(shipAngle) * shipR,
      );
      ship.rotation.y = -shipAngle + Math.PI / 2;
      // Bank into the turn for personality.
      ship.rotation.z = Math.sin(shipAngle * 2) * 0.18;
      const navLight = (ship as unknown as Record<string, unknown>).__nav as
        | THREE.Mesh
        | undefined;
      if (navLight && (navLight.material as THREE.MeshBasicMaterial)) {
        const blink = 0.5 + Math.abs(Math.sin(now * 0.005)) * 0.5;
        (navLight.material as THREE.MeshBasicMaterial).color.setRGB(
          blink,
          blink * 0.3,
          blink * 0.45,
        );
      }
      // ---- Vibey's journal: orbit + halo pulse + nudge burst -----
      // Different radius / tilt / period than the ship so it reads
      // as a separate object, not a duplicate. The journal travels
      // counter-clockwise on a more tilted plane.
      const journal = journalRef.current;
      if (journal) {
        const t = now * 0.001;
        const angle = -t * 0.22; // counter to the ship
        const R = 9.5;
        // Tilt the orbit so it slices through more of the camera's
        // arc — book is more often visible at eye level.
        const tilt = 0.45;
        const x = Math.cos(angle) * R;
        const z = Math.sin(angle) * R * Math.cos(tilt);
        const y = 4.2 + Math.sin(angle) * R * Math.sin(tilt) * 0.6
                + Math.sin(t * 1.1) * 0.18;
        journal.position.set(x, y, z);
        // Keep the book laid flat (cover facing world-up) so the V
        // is readable from the typical /space camera angle. We
        // gently bank the book so it shows its face to whichever
        // side of the orbit it's currently on, then spin slowly
        // around its vertical so the spine catches the eye too.
        journal.rotation.set(0, 0, 0);
        // Tilt the cover slightly toward the platform's center so
        // the V flashes in and out of view as it orbits.
        journal.rotateZ(Math.sin(angle) * 0.18);
        journal.rotateX(-Math.cos(angle) * 0.18);
        journal.rotateY(angle * 0.4 + Math.sin(t * 0.4) * 0.15);
        // Halo pulse + extra burst when journalNudgeRef bumps
        // (new entry just landed).
        const halo = (journal as unknown as Record<string, unknown>).__halo as
          | THREE.Mesh
          | undefined;
        if (halo) {
          const mat = halo.material as THREE.MeshBasicMaterial;
          const base = 0.08 + Math.sin(t * 1.4) * 0.03;
          const nudge = Math.max(0, 1 - (now - journalNudgeRef.current) / 1800);
          mat.opacity = base + nudge * 0.45;
          halo.scale.setScalar(1 + nudge * 0.55 + Math.sin(t * 1.4) * 0.05);
        }
      }

      // ---- Asteroid belt slow drift -------------------------------
      asteroidBelt.rotation.y += delta * 0.018;

      // ---- Aurora time uniform ------------------------------------
      if (auroraMat) auroraMat.uniforms.uTime.value = now * 0.001;

      // ---- Twinkle sparks: advance shader time --------------------
      const sparks = (scene as unknown as { __sparks?: THREE.Points }).__sparks;
      if (sparks) {
        const m = (sparks as unknown as { __mat?: THREE.ShaderMaterial }).__mat;
        if (m) m.uniforms.uTime.value = now * 0.001;
      }

      // ---- Comet: spawn + fly across + retire ---------------------
      if (cometGroup.visible) {
        const elapsed = (now - cometStartTime) / 1000;
        const T = 4.5; // seconds to traverse
        const k = elapsed / T;
        if (k >= 1) {
          cometGroup.visible = false;
          nextCometAt = now + 18000 + Math.random() * 20000;
        } else {
          cometGroup.position.lerpVectors(cometStart, cometEnd, k);
          cometGroup.lookAt(cometEnd);
        }
      } else if (now >= nextCometAt && layerVisibleRef.current.comet) {
        cometGroup.visible = true;
        cometStartTime = now;
      }

      // ---- Alien saucer: orbit Vibey + bob + drive alien mixer ----
      if (alienSaucerGroupRef.current) {
        const s = alienSaucerGroupRef.current;
        s.userData.orbitPhase = (s.userData.orbitPhase as number) +
          delta * (s.userData.orbitSpeed as number);
        const a = s.userData.orbitPhase as number;
        const r = s.userData.orbitRadius as number;
        const h = s.userData.orbitHeight as number;
        s.position.set(Math.cos(a) * r, h + Math.sin(now * 0.0006) * 0.3, Math.sin(a) * r);
        // Saucer always faces the direction it's traveling (tangent
        // to the circle), so the alien feels like he's being flown.
        s.rotation.y = -a + Math.PI / 2;
        // Slight banking roll into the curve.
        s.rotation.z = Math.sin(now * 0.0008) * 0.05;
        // Have the character on the saucer turn to face the platform
        // center (Vibey), regardless of where the saucer is on its
        // orbit. The character is the saucer's last child (added
        // after the disc / ring / underglow / thrusters). lookAt
        // works in world space, so it cancels out the saucer's yaw.
        const character = s.children[s.children.length - 1];
        if (character && character.type === "Group") {
          const target = new THREE.Vector3(0, character.getWorldPosition(new THREE.Vector3()).y, 0);
          character.lookAt(target);
        }
      }
      if (alienMixerRef.current) alienMixerRef.current.update(delta);

      // ---- Disco mode: spin ball + orbit colored lights + dance ---
      if (discoGroupRef.current && discoGroupRef.current.visible) {
        const t = now * 0.001;
        const grp = discoGroupRef.current;
        const ball = (grp as unknown as Record<string, unknown>).__ball as
          | THREE.Mesh
          | undefined;
        if (ball) {
          ball.rotation.y = t * 1.4;
          ball.rotation.x = Math.sin(t * 0.6) * 0.25;
        }
        const lights = (grp as unknown as Record<string, unknown>).__lights as
          | THREE.PointLight[]
          | undefined;
        if (lights) {
          const RING_R = 5.5;
          const RING_Y = 5.6;
          for (const pl of lights) {
            const ph = (pl.userData.phase as number) ?? 0;
            const ang = t * 1.1 + ph;
            pl.position.set(
              Math.cos(ang) * RING_R,
              RING_Y + Math.sin(t * 2 + ph) * 0.4,
              Math.sin(ang) * RING_R,
            );
            // Pulse intensity on a fast beat so the lights flicker
            // like a real DJ booth instead of looking pinned.
            pl.intensity = 4 + Math.abs(Math.sin(t * 4 + ph)) * 5;
          }
        }
        // Drive every dancer's mixer.
        for (const mx of discoMixersRef.current) mx.update(delta);
      }

      // ---- Random auto-emote on the saucer rider ------------------
      // Every 4-8 seconds, pick a fun clip and play it on the
      // character regardless of FOCUS. Idle stays the base loop.
      if (alienMixerRef.current && alienActionsRef.current.size) {
        if (now >= nextAutoEmoteAtRef.current) {
          const choices: Unit7AnimName[] = [
            "Wave", "Yes", "No", "ThumbsUp", "Punch", "Jump", "Dance",
          ];
          const pick = choices[Math.floor(Math.random() * choices.length)];
          playAlienAnim(pick);
          nextAutoEmoteAtRef.current = now + 4000 + Math.random() * 4000;
        }
      }

      // ---- Vibe Profile cards: slow carousel + per-card bob -------
      if (vibeCardsGroupRef.current) {
        const g = vibeCardsGroupRef.current;
        g.rotation.y += delta * 0.05;
        for (const card of g.children) {
          const phase = (card.userData.bobPhase as number) ?? 0;
          const baseY = (card.userData.baseY as number) ?? card.position.y;
          card.position.y = baseY + Math.sin(now * 0.0008 + phase) * 0.45;
          // Billboard: always face the camera so the text reads
          // correctly no matter where we are in the orbit.
          card.lookAt(camera.position);
        }
      }

      // ---- Memory orbs: counter-rotate inner ring + per-orb bob ---
      if (memoryOrbsGroupRef.current) {
        const g = memoryOrbsGroupRef.current;
        g.rotation.y -= delta * 0.08;
        for (const orb of g.children) {
          const phase = (orb.userData.bobPhase as number) ?? 0;
          const baseY = (orb.userData.baseY as number) ?? orb.position.y;
          orb.position.y = baseY + Math.sin(now * 0.0011 + phase) * 0.32;
          orb.lookAt(camera.position);
        }
      }

      // ---- Spawnable props: per-prop slow spin + gentle bob -------
      for (const g of propsCacheRef.current.values()) {
        const spin = (g.userData.spin as number) ?? 0;
        const bob = (g.userData.bob as number) ?? 0;
        const baseY = (g.userData.basePosY as number) ?? g.position.y;
        if (spin) g.rotation.y += delta * spin;
        if (bob) g.position.y = baseY + Math.sin(now * 0.0006) * bob;
        // Drive any baked-clip mixer (alien).
        const mixer = g.userData.mixer as THREE.AnimationMixer | undefined;
        if (mixer) mixer.update(delta);
      }

      // ---- Iridescent arc: slow drift rotation ---------------------
      if (arcGroup) {
        arcGroup.rotation.y += delta * 0.08;
        arcGroup.position.y = 4 + Math.sin(now * 0.0004) * 0.6;
      }

      // ---- Gallery TV: hover bob + slight yaw drift -----------------
      if (tvGroupRef.current && tvGroupRef.current.visible) {
        const tv = tvGroupRef.current;
        // Capture base on first visible frame so bob oscillates around it.
        const base = (tv as unknown as { __baseY?: number }).__baseY ?? 9;
        (tv as unknown as { __baseY?: number }).__baseY = base;
        tv.position.y = base + Math.sin(now * 0.0009) * 0.6;
        // Subtle pendulum yaw — keeps it feeling alive without leaving frame.
        tv.rotation.z = Math.sin(now * 0.0006) * 0.04;
      }

      // ---- Shooting stars: spawn occasionally + advance + fade ----
      if (now >= nextShooterAt) {
        spawnShootingStar();
        nextShooterAt = now + 1500 + Math.random() * 4500;
      }
      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const s = shootingStars[i];
        s.age += delta;
        const t = s.age / s.lifetime;
        if (t >= 1) {
          scene.remove(s.line);
          s.line.geometry.dispose();
          s.mat.dispose();
          shootingStars.splice(i, 1);
          continue;
        }
        // Move head along velocity; tail trails behind.
        s.head.addScaledVector(s.velocity, delta);
        const tail = s.head.clone().sub(s.velocity.clone().multiplyScalar(0.06));
        const arr = (s.line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        arr[0] = s.head.x; arr[1] = s.head.y; arr[2] = s.head.z;
        arr[3] = tail.x; arr[4] = tail.y; arr[5] = tail.z;
        (s.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        // Fade in fast, fade out gently.
        s.mat.opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      }

      controls.update();
      bloomPass.threshold = activeExperienceRef.current === "ion" ? 0.62 : 0.72;
      bloomPass.strength =
        activeExperienceRef.current === "ion" ? 1.45 + beaconPulse * 0.25 : 0.42 + beaconPulse * 0.55;
      bloomPass.radius = activeExperienceRef.current === "ion" ? 0.35 : 0.08;
      renderer.toneMappingExposure = activeExperienceRef.current === "ion" ? 1.0 : 1.12;
      composer.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // ---- Resize handling --------------------------------------------
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      // Walk the scene and dispose meshes/materials so we don't leak
      // when navigating away.
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose();
        }
      });
      composer.dispose();
      disposableTextures.forEach((texture) => texture.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden text-foreground">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
      />

      {/* Confetti burst overlay — keyed on confettiSeed so each click
          remounts and restarts the CSS animation on every piece. */}
      <ConfettiBurst seed={confettiSeed} />

      {/* Speech bubble above Vibey — fades in, drifts up, fades out. */}
      {speechBubble && (
        <div
          key={speechBubble.key}
          className="pointer-events-none absolute left-1/2 top-[42%] z-20 -translate-x-1/2 px-3 py-1.5 rounded-2xl bg-background/85 border border-primary/40 backdrop-blur shadow-lg text-sm font-heading text-foreground"
          style={{ animation: "speech-pop 1800ms cubic-bezier(.2,.7,.2,1) forwards" }}
        >
          {speechBubble.text}
        </div>
      )}

      {/* Top bar */}
      <div className="absolute top-14 md:top-4 left-4 z-10 flex items-center gap-3 flex-wrap">
        <Link
          to="/"
          className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Back to village
          </span>
        </Link>
        <button
          onClick={() => {
            const next = toggleSoundsMuted();
            setSfxMuted(next);
            // Tiny audible confirmation on un-mute so the user
            // hears the synth is alive.
            if (!next) {
              ensureAudioRunning();
              playSound("chirp");
            }
          }}
          className="glass-panel rounded-full p-2 hover:bg-muted transition-colors"
          title={sfxMuted ? "Vibey's beeps are muted — click to enable" : "Mute Vibey's beep-boops"}
          aria-label="Toggle sound effects"
        >
          {sfxMuted ? (
            <VolumeX className="w-4 h-4 text-muted-foreground" />
          ) : (
            <Volume2 className="w-4 h-4 text-primary" />
          )}
        </button>
        <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Vibey 2.0 · Outer Space
          </span>
        </div>
      </div>

      {/* Floating "open chat" pill — only visible when the panel is hidden,
          so the top of the screen stays unobstructed. */}
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="absolute bottom-4 right-4 z-10 glass-panel rounded-full px-4 py-2.5 flex items-center gap-2 hover:bg-muted transition-colors"
        >
          <MessageCircle className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Chat & emotes
          </span>
        </button>
      )}

      <div className="absolute left-1/2 top-[125px] z-10 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 glass-panel rounded-xl px-3 py-2 border border-primary/30">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(115,255,184,0.9)]" />
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
            Vibey Show · {showMood}
          </p>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/85">
          {showThought}
        </p>
      </div>

      {activeExperience === "gallery" && galleryStatus !== "ready" && (
        <div className="absolute left-4 bottom-20 z-10 glass-panel rounded-xl border border-primary/30 px-3 py-2 max-w-[260px]">
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
            Gallery TV
          </p>
          <p className="text-[10px] text-muted-foreground">
            {galleryStatus === "loading" && "Tuning…"}
            {galleryStatus === "empty" && "No visible photos yet."}
            {galleryStatus === "error" && "Feed unavailable."}
          </p>
        </div>
      )}

      {/* Side panel: chat + controls (collapsible) */}
      {panelOpen && (
      <div className="absolute top-14 md:top-4 right-4 bottom-4 z-10 w-[min(360px,calc(100vw-2rem))] flex flex-col gap-2.5">
        <div className="glass-panel rounded-xl p-3 flex flex-col gap-2.5 flex-1 min-h-0">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <p className="font-heading text-[12px] font-semibold tracking-wider text-foreground flex-1">
              Talk to Vibey
            </p>
            <button
              onClick={() => setPanelOpen(false)}
              className="p-1 rounded-md hover:bg-muted/40 transition-colors"
              title="Hide chat"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          {/* Two-pill toggle: live community Vibey is the default brain. */}
          <div className="flex gap-1 p-0.5 rounded-lg bg-background/40 border border-border/40 text-[10px]">
            <button
              onClick={() => setChatMode("live")}
              className={`flex-1 px-2 py-1 rounded-md transition-colors ${
                chatMode === "live"
                  ? "bg-primary/25 text-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
              title="The live community Vibey (production hub)"
            >
              🌐 Live Vibey
            </button>
            <button
              onClick={() => setChatMode("local")}
              className={`flex-1 px-2 py-1 rounded-md transition-colors ${
                chatMode === "local"
                  ? "bg-primary/25 text-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
              title="The Vibey 2.0 brain that lives in this app"
            >
              🤖 Vibey 2.0
            </button>
          </div>
          <div className="relative flex-1 min-h-0">
            <div
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              className="absolute inset-0 overflow-y-auto bg-background/30 rounded-lg p-2 space-y-2"
            >
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[85%] ${
                    m.who === "bot"
                      ? "bg-primary/15 text-foreground"
                      : "bg-muted/60 text-foreground self-end ml-auto"
                  }`}
                >
                  {m.who === "bot" ? (
                    /* Bot replies often contain markdown (bold, lists, links).
                       Render with GFM; tighten spacing so it fits chat bubbles. */
                    <div className="vibey-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.text || "…"}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    /* User messages are plain text — preserve their newlines. */
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  )}
                </div>
              ))}
              {thinking && (
                <div className="text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[85%] bg-primary/10 text-muted-foreground italic">
                  Vibey is thinking…
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>
            {/* Jump-to-bottom: appears only when the user has scrolled up. */}
            {!chatAtBottom && (
              <button
                onClick={() => scrollChatToBottom("smooth")}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-primary/90 text-primary-foreground rounded-full px-3 py-1 text-[10px] font-semibold flex items-center gap-1 shadow-lg hover:bg-primary transition-colors"
                title="Jump to latest"
              >
                <ArrowDown className="w-3 h-3" />
                Latest
              </button>
            )}
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter (or Cmd/Ctrl+Enter) inserts a newline.
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  if (draft.trim() && !thinking) handleSend();
                }
              }}
              placeholder="Talk to Vibey… (Shift+Enter for newline)"
              disabled={thinking}
              rows={1}
              className="flex-1 resize-none rounded-lg bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-3 py-2 text-sm disabled:opacity-60 max-h-32 min-h-[2.4rem] leading-snug"
              style={{
                // Auto-grow up to max-h via scrollHeight on every render.
                height: "auto",
              }}
              ref={(el) => {
                if (el) {
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
                }
              }}
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || thinking}
              className="bg-primary text-primary-foreground px-3 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 self-stretch"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-3 flex flex-col gap-2">
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground">
            Focus
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setEmoteFocus("vibey")}
              className={`rounded-md border transition-colors px-2 py-1.5 text-[11px] font-heading font-semibold ${
                emoteFocus === "vibey"
                  ? "border-primary/60 bg-primary/20 text-primary"
                  : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
              }`}
            >
              🤖 Vibey
            </button>
            <button
              onClick={() => setEmoteFocus("alien")}
              className={`rounded-md border transition-colors px-2 py-1.5 text-[11px] font-heading font-semibold ${
                emoteFocus === "alien"
                  ? "border-primary/60 bg-primary/20 text-primary"
                  : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
              }`}
            >
              👽 Alien
            </button>
          </div>
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Emotes — sent to {emoteFocus === "vibey" ? "Vibey" : "Alien"}
          </p>
          <div className="grid grid-cols-5 gap-1.5">
            {ALL_EMOTES.map((e) => (
              <button
                key={e.anim}
                onClick={() => triggerAnim(e.anim)}
                className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
              >
                {e.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Tricks
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={triggerBackflip}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              🤸 Backflip
            </button>
            <button
              onClick={triggerSprint}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              💨 Sprint
            </button>
            <button
              onClick={triggerPoetTransmission}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              📜 Poet
            </button>
          </div>

          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            World
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={triggerBeacon}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              🔆 Beacon
            </button>
            <button
              onClick={triggerShowBeat}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              📡 Beat
            </button>
            <button
              onClick={triggerConstellation}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-1 py-1.5 text-[10px] font-medium"
            >
              ✦ Stars
            </button>
          </div>
          <button
            onClick={() => {
              const next = !showMode;
              setShowMode(next);
              setShowMood(next ? "autonomous" : "quiet");
              setShowThought(
                next
                  ? "Vibey resumes the show. Nobody is driving."
                  : "Show mode paused. Vibey is still here, just quieter.",
              );
            }}
            className={`mt-1 rounded-md border transition-colors px-2 py-1.5 text-[10px] font-medium ${
              showMode
                ? "border-primary/60 bg-primary/20 text-primary"
                : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
            }`}
        >
          {showMode ? "Broadcasting" : "Resume show"}
        </button>

          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Spawn
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { id: "ion" as const, label: "Ion" },
              { id: "blocks" as const, label: "Blocks" },
              { id: "friend" as const, label: "Friend" },
              { id: "gallery" as const, label: "TV" },
              { id: "none" as const, label: "Clear" },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => spawnExperience(item.id)}
                className={`rounded-md border transition-colors px-1 py-1.5 text-[10px] font-medium ${
                  activeExperience === item.id
                    ? "border-primary/60 bg-primary/20 text-primary"
                    : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Props
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { id: "astronaut" as const, label: "🧑‍🚀 Astro" },
              { id: "island" as const, label: "🏝 Island" },
              { id: "touch" as const, label: "✨ Touch" },
            ].map((item) => {
              const on = activeProps.has(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() =>
                    setActiveProps((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                  className={`rounded-md border transition-colors px-1 py-1.5 text-[10px] font-medium ${
                    on
                      ? "border-primary/60 bg-primary/20 text-primary"
                      : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
            <button
              onClick={() => setActiveProps(new Set())}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 px-1 py-1.5 text-[10px] font-medium"
            >
              Clear
            </button>
          </div>

          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Skin
          </p>
          <div className="grid grid-cols-7 gap-1.5">
            {[
              { label: "Original", c: null },
              { label: "Mint", c: 0x73ffb8 },
              { label: "Sky", c: 0x6aa8ff },
              { label: "Coral", c: 0xff7e8a },
              { label: "Gold", c: 0xffd166 },
              { label: "Violet", c: 0xb392ff },
              { label: "Snow", c: 0xeaeaf0 },
            ].map((s) => (
              <button
                key={s.label}
                onClick={() => setRobotColor(s.c)}
                className={`h-6 rounded-md border transition-all ${
                  robotColor === s.c
                    ? "border-primary scale-110"
                    : "border-border/60 hover:border-primary/50"
                }`}
                style={{
                  background:
                    s.c == null
                      ? "linear-gradient(135deg, #d4a35a 0%, #6f5c3a 100%)"
                      : "#" + s.c.toString(16).padStart(6, "0"),
                }}
                title={s.label}
              />
            ))}
          </div>

          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mt-1">
            Mood
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {ALL_MOODS.map((e) => (
              <button
                key={e.expr}
                onClick={() =>
                  triggerExpression(activeMood === e.expr ? null : e.expr)
                }
                className={`rounded-md border transition-colors px-1 py-1.5 text-[10px] font-medium ${
                  activeMood === e.expr
                    ? "border-primary/60 bg-primary/20 text-primary"
                    : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* Community stats — compact pill. Live counts + presence dot. */}
      {!panelOpen && communityStats && (
        <div className="absolute top-14 md:top-4 right-4 z-10 glass-panel rounded-full pl-2.5 pr-3 py-1.5 border border-primary/30 flex items-center gap-3 text-[11px] font-heading text-foreground/90">
          <span className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-70" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="font-mono font-semibold">{watchingNow}</span>
          </span>
          <span className="opacity-30">|</span>
          <span>
            <span className="font-mono font-semibold">{communityStats.members}</span>
            <span className="text-muted-foreground ml-1">members</span>
          </span>
          <span>
            <span className="font-mono font-semibold">{communityStats.photos}</span>
            <span className="text-muted-foreground ml-1">photos</span>
          </span>
          <span>
            <span className="font-mono font-semibold">{communityStats.events}</span>
            <span className="text-muted-foreground ml-1">events</span>
          </span>
        </div>
      )}

      {/* New-photo toast — slides in when a new gallery photo lands. */}
      {newPhotoToast && (
        <div
          key={newPhotoToast.key}
          className="absolute top-28 md:top-16 left-1/2 z-20 -translate-x-1/2 glass-panel rounded-xl px-4 py-2 border border-primary/40 flex items-center gap-2 shadow-lg"
          style={{ animation: "speech-pop 6000ms cubic-bezier(.2,.7,.2,1) forwards" }}
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="text-[11px] uppercase tracking-widest text-primary font-heading">
            New photo
          </span>
          <span className="text-xs text-foreground/85 max-w-[280px] truncate">
            {newPhotoToast.title}
          </span>
        </div>
      )}

      {/* Click-focus panels: a member card or memory orb in the 3D
          scene was clicked → show its full data in a side panel. */}
      {focusedProfile && (
        <div
          className="absolute inset-0 z-30 bg-background/60 backdrop-blur-md flex items-center justify-center p-6"
          onClick={() => setFocusedProfile(null)}
        >
          <div
            className="glass-panel rounded-2xl border border-primary/40 max-w-md w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                Vibe Profile · Edge Esmeralda
              </p>
              <button
                onClick={() => setFocusedProfile(null)}
                className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="px-4 py-4 flex items-center gap-3">
              {focusedProfile.avatar ? (
                <img
                  src={focusedProfile.avatar}
                  alt={focusedProfile.name}
                  className="w-16 h-16 rounded-full object-cover border-2 border-primary/60"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-primary/30 flex items-center justify-center text-2xl font-heading font-bold text-foreground">
                  {focusedProfile.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((s) => s[0])
                    .join("")
                    .toUpperCase()
                    .slice(0, 2)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-base font-heading font-semibold text-foreground truncate">
                  {focusedProfile.name}
                </p>
                <p className="text-[11px] uppercase tracking-widest text-primary mt-0.5">
                  {focusedProfile.role}
                </p>
              </div>
            </div>
            <div className="px-4 pb-4 text-xs text-muted-foreground">
              One of {communityStats?.members ?? "many"} members in the
              Edge Esmeralda village. Tap a different card or click
              outside to dismiss.
            </div>
          </div>
        </div>
      )}

      {focusedMemory && (
        <div
          className="absolute inset-0 z-30 bg-background/60 backdrop-blur-md flex items-center justify-center p-6"
          onClick={() => setFocusedMemory(null)}
        >
          <div
            className="glass-panel rounded-2xl border border-primary/40 max-w-lg w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                Vibey · Knows
              </p>
              <button
                onClick={() => setFocusedMemory(null)}
                className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="px-4 py-4">
              <p className="text-sm leading-relaxed text-foreground">
                {focusedMemory.content}
              </p>
              {focusedMemory.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {focusedMemory.tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Earth preview modal — opens when the user clicks Earth in
          /space. Shows a satellite tile of Healdsburg + a button to
          actually visit the village map. */}
      {earthOpen && (
        <div
          className="absolute inset-0 z-30 bg-background/70 backdrop-blur-md flex items-center justify-center p-6"
          onClick={() => setEarthOpen(false)}
        >
          <div
            className="glass-panel rounded-2xl border border-primary/40 max-w-lg w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                Earth · Healdsburg, CA
              </p>
              <button
                onClick={() => setEarthOpen(false)}
                className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <img
              src={`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${VILLAGE_CENTER.lng},${VILLAGE_CENTER.lat},15.5,0/600x400@2x?access_token=${MAPBOX_TOKEN}`}
              alt="Satellite view of Healdsburg"
              className="w-full block"
            />
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                The plaza, right now. Edge Esmeralda is happening on this
                exact green block.
              </p>
              <Link
                to="/"
                className="shrink-0 rounded-md bg-primary/15 hover:bg-primary/25 text-primary px-3 py-1.5 text-[11px] font-heading font-semibold tracking-widest uppercase transition-colors"
              >
                Visit village →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Control Panel — toggles which scene layers are visible. */}
      <button
        onClick={() => setControlPanelOpen((v) => !v)}
        className={`absolute bottom-32 left-4 z-10 glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 text-[11px] font-heading transition-colors border ${
          controlPanelOpen
            ? "border-primary/60 bg-primary/15"
            : "border-primary/30 hover:bg-muted/40"
        }`}
        title="Toggle scene layers"
      >
        <span className="text-primary">⚙</span>
        <span className="tracking-widest uppercase">Layers</span>
      </button>

      {controlPanelOpen && (
        <div className="absolute bottom-44 left-4 z-20 glass-panel rounded-xl border border-primary/30 p-3 w-[220px]">
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-2">
            Scene Layers
          </p>
          <div className="flex flex-col gap-1">
            {[
              { id: "disco" as const, label: "Disco mode 🪩" },
              { id: "earth" as const, label: "Earth 🌍" },
              { id: "tracks" as const, label: "Local tracks 💿" },
              { id: "rocky" as const, label: "Rocky 🪨" },
              { id: "cards" as const, label: "People cards" },
              { id: "memories" as const, label: "Vibey · Knows" },
              { id: "asteroids" as const, label: "Asteroid belt" },
              { id: "aurora" as const, label: "Aurora ribbon" },
              { id: "comet" as const, label: "Comets" },
              { id: "arc" as const, label: "Iridescent arc" },
              { id: "ship" as const, label: "Saucer" },
              { id: "sparks" as const, label: "Twinkle stars" },
            ].map((row) => {
              const on = layerVisible[row.id];
              return (
                <button
                  key={row.id}
                  onClick={() => {
                    const willTurnOn = !on;
                    setLayerVisible((prev) => ({
                      ...prev,
                      [row.id]: !prev[row.id],
                    }));
                    // Drop the beat when disco turns on — quick groove
                    // sound + Vibey throws a dance emote so it feels
                    // like a real party kicks off.
                    if (row.id === "disco" && willTurnOn) {
                      ensureAudioRunning();
                      playSound("groove");
                      triggerAnim("Dance");
                    }
                  }}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition-colors ${
                    on
                      ? "bg-primary/15 text-foreground"
                      : "bg-background/30 text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  <span>{row.label}</span>
                  <span
                    className={`relative inline-block w-7 h-3.5 rounded-full transition-colors ${
                      on ? "bg-primary/80" : "bg-muted/50"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-foreground transition-all ${
                        on ? "left-3.5" : "left-0.5"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Vibey Soul button — opens a panel showing the agent's name,
          model, intro, and full system prompt. */}
      {vibeyAgent && (
        <button
          onClick={() => setSoulOpen((v) => !v)}
          className="absolute bottom-20 left-4 z-10 glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 text-[11px] font-heading hover:bg-muted/40 transition-colors border border-primary/30"
          title="Peek at Vibey's soul"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="tracking-widest uppercase">Vibey · Soul</span>
        </button>
      )}

      {soulOpen && vibeyAgent && (
        <div
          className="absolute inset-0 z-30 bg-background/70 backdrop-blur-md flex items-center justify-center p-6"
          onClick={() => setSoulOpen(false)}
        >
          <div
            className="glass-panel rounded-2xl border border-primary/40 max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <div>
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                  Vibey · Soul
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {vibeyAgent.model || "claude"}
                </p>
              </div>
              <button
                onClick={() => setSoulOpen(false)}
                className="p-1.5 rounded-md hover:bg-muted/40 transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            {vibeyAgent.intro_message && (
              <div className="px-4 py-3 border-b border-border/30">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  Intro
                </p>
                <p className="text-sm text-foreground">
                  {vibeyAgent.intro_message}
                </p>
              </div>
            )}
            <div className="px-4 py-3 overflow-y-auto">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                System Prompt
              </p>
              <pre className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap font-sans">
                {vibeyAgent.system_prompt}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Vibey's journal — the floating leather book that orbits the
          asteroid is a real Three.js object in the space scene
          (built in the canvas setup). This component handles the
          handwritten overlay + edge-function tick. We hand it the
          journalOpen state so a 3D click can open it, and ask it to
          ping `journalNudgeRef` whenever a new entry lands so the
          orbiting book bursts a halo. */}
      <VibeyJournal
        communityId={VIBEY_COMMUNITY_ID}
        watching={watchingNow > 0}
        open={journalOpen}
        onOpenChange={setJournalOpen}
        showFloatingBook={false}
        onLiveEntry={() => {
          journalNudgeRef.current = performance.now();
          // Soft bell when Vibey writes a new page — only audible
          // if the user has interacted with the page (audio gesture).
          playSound("chime");
        }}
      />

      {/* Music player + queue. Click the title to flip open a list
          of every track; click any row to jump to it. Auto-advances
          on end. */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-col items-stretch gap-2 max-w-[340px]">
        {/* Spotify Web Playback SDK player. Only mounts after the
            user has connected; Premium accounts can play full
            tracks, free accounts will see an account_error. */}
        {spotifyConnected && spotifyPlayerOpen && (
          <SpotifyPlayer onClose={() => setSpotifyPlayerOpen(false)} />
        )}
        {/* When the user has hidden the Spotify panel, surface a
            small pill so they can re-open it without having to
            sign out and back in. */}
        {spotifyConnected && !spotifyPlayerOpen && (
          <button
            onClick={() => setSpotifyPlayerOpen(true)}
            className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 border border-primary/30 hover:bg-primary/10 transition-colors"
            title="Open Spotify player"
          >
            <span className="text-[14px]">🎧</span>
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
              Open Spotify Player
            </span>
          </button>
        )}

        {/* Spotify auth pill. When connected, shows the user's name
            + a logout button. */}
        {spotifyConnected ? (
          <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 border border-primary/30">
            <span className="text-[14px]">🎧</span>
            <span className="text-[11px] font-heading font-semibold text-foreground truncate flex-1">
              {spotifyProfile?.display_name ?? "Connecting…"}
            </span>
            {spotifyProfile?.product && (
              <span className="text-[9px] font-mono uppercase tracking-widest text-primary">
                {spotifyProfile.product}
              </span>
            )}
            <button
              onClick={() => {
                spotifyLogout();
                setSpotifyConnected(false);
              }}
              className="text-[9px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
              title="Disconnect Spotify"
            >
              Sign out
            </button>
          </div>
        ) : (
          <button
            onClick={() => loginWithSpotify()}
            className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 border border-primary/30 hover:bg-primary/10 transition-colors"
            title="Connect your Spotify account"
          >
            <span className="text-[14px]">🎧</span>
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
              Connect Spotify
            </span>
          </button>
        )}

        {/* Local-MP3 queue + player. Off by default; toggle on from
            the Layers panel ('Local tracks 💿'). Spotify is the
            primary music UI; this stays as a fallback for the
            downloaded library. */}
        {layerVisible.tracks && queueOpen && (
          <div className="glass-panel rounded-xl border border-primary/30 p-2 max-h-[55vh] overflow-y-auto">
            <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-1.5 px-1">
              Queue · {TRACKS.length} tracks
            </p>
            <div className="flex flex-col gap-0.5">
              {TRACKS.map((t, i) => {
                const on = i === trackIndex;
                return (
                  <button
                    key={t.src}
                    onClick={() => {
                      setTrackIndex(i);
                      setMusicOn(true);
                    }}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                      on
                        ? "bg-primary/15 text-foreground"
                        : "hover:bg-muted/40 text-foreground/85"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        on
                          ? "bg-primary shadow-[0_0_8px_rgba(115,255,184,0.8)]"
                          : "bg-muted-foreground/40"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-heading font-semibold leading-tight truncate">
                        {t.title}
                      </p>
                      <p className="text-[9px] font-mono text-muted-foreground tracking-widest uppercase truncate">
                        {t.artist}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {layerVisible.tracks && (
        <div className="glass-panel rounded-xl px-3 py-2 flex items-center gap-2">
          <audio ref={audioRef} src={currentTrack.src} preload="none" crossOrigin="anonymous" />
          <button
            onClick={() => setTrackIndex((i) => (i - 1 + TRACKS.length) % TRACKS.length)}
            className="p-1 rounded-md hover:bg-muted/40 transition-colors"
            title="Previous track"
          >
            <SkipBack className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => setMusicOn((v) => !v)}
            className="p-1.5 rounded-full bg-primary/15 hover:bg-primary/25 transition-colors"
            title={musicOn ? "Pause" : "Play"}
          >
            {musicOn ? (
              <Pause className="w-4 h-4 text-primary" />
            ) : (
              <Play className="w-4 h-4 text-primary" />
            )}
          </button>
          <button
            onClick={() => setTrackIndex((i) => (i + 1) % TRACKS.length)}
            className="p-1 rounded-md hover:bg-muted/40 transition-colors"
            title="Next track"
          >
            <SkipForward className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => setQueueOpen((v) => !v)}
            className="ml-1 mr-1 max-w-[160px] overflow-hidden text-left hover:bg-muted/30 rounded-md px-1 py-0.5 transition-colors"
            title="Show queue"
          >
            <p className="text-[11px] font-heading font-semibold text-foreground leading-tight truncate">
              {currentTrack.title}
            </p>
            <p className="text-[9px] font-mono text-muted-foreground tracking-widest uppercase truncate">
              {currentTrack.artist} · {trackIndex + 1}/{TRACKS.length}
            </p>
          </button>
          {musicVolume === 0 ? (
            <VolumeX className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground" />
          )}
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={musicVolume}
            onChange={(e) => setMusicVolume(Number(e.target.value))}
            className="w-16 h-1 accent-primary cursor-pointer"
            aria-label="Volume"
          />
        </div>
        )}
      </div>
    </div>
  );
}
