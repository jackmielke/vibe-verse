import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ArrowLeft, Send, Bot, X, MessageCircle, Volume2, VolumeX, SkipForward, SkipBack, Play, Pause } from "lucide-react";
import unit7ModelUrl from "@/assets/robot-expressive.glb";
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

const TRACKS: Track[] = [
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
  { match: /\b(name|who are you|what are you)\b/, intent: { anim: "Wave", reply: "I'm Unit-7. I live in Edge Esmeralda but I come out here to think." } },
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
  "Poet capsule says: Unit-7, your little platform is a comma in the dark.",
  "Poet capsule says: clouds are Earth thinking out loud.",
  "Poet capsule says: I packed one notebook and no landing plan.",
];

const DISCOVERY_LINES = [
  "Unit-7 logs a new landmark: the mint ring hums when Earth crosses behind it.",
  "Unit-7 thinks the galaxy is not a place. More like a memory with gravity.",
  "Unit-7 found a quiet sector and named it The Maybe.",
  "Unit-7 noticed the poet capsule waving, but only in metaphor.",
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
    { id: 1, who: "bot", text: "Hey. I'm Unit-7. Click an emote, change my mood, or just talk to me." },
  ]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [musicOn, setMusicOn] = useState(false);
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
  const [activeExperience, setActiveExperience] = useState<SpaceExperience>("none");
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
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let cancelled = false;
    let prevTexture: THREE.Texture | null = null;
    loader.load(
      currentGalleryPhoto!.image_url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        prevTexture = mat.map;
        mat.map = tex;
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
        if (prevTexture) prevTexture.dispose();
      },
      undefined,
      () => {
        // Image failed — keep prior frame; don't blank the screen.
      },
    );
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
    desiredAnimRef.current = anim;
    animPulseRef.current++;
    if (!ONE_SHOTS.has(anim)) baseAnimRef.current = anim;
  }

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

  async function handleSend() {
    const text = draft.trim();
    if (!text || thinking) return;
    setDraft("");
    pushMessage("user", text);
    setThinking(true);

    // Try the Supabase Edge Function (real LLM via OpenRouter). The key
    // lives server-side; the browser never sees it. If anything fails
    // (function not deployed yet, no key, network), fall back to the
    // offline keyword inference so the user still gets a response.
    const history = messages
      .slice(1)
      .slice(-12)
      .map((m) => ({
        role: (m.who === "bot" ? "assistant" : "user") as
          | "user"
          | "assistant",
        content: m.text,
      }));

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
      // Quiet fallback. The keyword path still feels alive.
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
    scene.fog = new THREE.FogExp2(0x05060f, 0.012);
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
    controls.target.set(0, 1.1, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 4;
    controls.maxDistance = 38;
    controls.maxPolarAngle = Math.PI * 0.55; // don't let user go below platform
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    // Stop auto-rotation as soon as the user drags.
    canvas.addEventListener("pointerdown", () => {
      controls.autoRotate = false;
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
      group.position.set(26, 5.5, -44);
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

      scene.add(group);
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
      scene.add(g);
      (g as unknown as Record<string, unknown>).__nav = navLight;
      return g;
    })();

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
      screen.position.z = 0.27;
      tv.add(screen);
      // Soft glow halo so it reads against the starfield even when the
      // photo is dark.
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
      // Mount post hanging it in space.
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 4, 12),
        new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.5, roughness: 0.4 }),
      );
      post.position.y = -4.7;
      tv.add(post);

      // Position truly opposite the planet/moon. Earth ≈ (-55, -8, -65),
      // moon ≈ (35, 12, -30) — both back-side. Put the TV in the
      // front-right quadrant, scaled up so it reads as a distant
      // billboard from any orbit angle.
      tv.position.set(38, 9, 32);
      tv.scale.setScalar(1.8);
      tv.lookAt(0, 3, 0);
      tv.visible = false;
      scene.add(tv);
      tvGroupRef.current = tv;
      tvScreenMatRef.current = screenMat;
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
        const beat = SHOW_MONOLOGUES[Math.floor(Math.random() * SHOW_MONOLOGUES.length)];
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
        nextShowBeatAt = now + 16000 + Math.random() * 14000;
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

      {/* Top bar */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-3">
        <Link
          to="/"
          className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Back to village
          </span>
        </Link>
        <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Unit-7 · Outer Space
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

      {activeExperience === "gallery" && (
        <div className="absolute left-4 bottom-20 z-10 glass-panel rounded-xl border border-primary/30 px-3 py-2 max-w-[280px]">
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
            Gallery TV
          </p>
          {galleryStatus === "loading" && (
            <p className="text-[10px] text-muted-foreground">Tuning…</p>
          )}
          {galleryStatus === "empty" && (
            <p className="text-[10px] text-muted-foreground">No visible photos yet.</p>
          )}
          {galleryStatus === "error" && (
            <p className="text-[10px] text-muted-foreground">Feed unavailable.</p>
          )}
          {galleryStatus === "ready" && currentGalleryPhoto && (
            <>
              <p className="truncate text-xs font-heading font-semibold text-foreground">
                {currentGalleryPhoto.title ?? "Untitled transmission"}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground">
                {galleryIndex + 1}/{galleryPhotos.length}
              </p>
            </>
          )}
        </div>
      )}

      {/* Side panel: chat + controls (collapsible) */}
      {panelOpen && (
      <div className="absolute top-4 right-4 bottom-4 z-10 w-[min(360px,calc(100vw-2rem))] flex flex-col gap-2.5">
        <div className="glass-panel rounded-xl p-3 flex flex-col gap-2.5 flex-1 min-h-0">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <p className="font-heading text-[12px] font-semibold tracking-wider text-foreground flex-1">
              Talk to Unit-7
            </p>
            <button
              onClick={() => setPanelOpen(false)}
              className="p-1 rounded-md hover:bg-muted/40 transition-colors"
              title="Hide chat"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto bg-background/30 rounded-lg p-2 space-y-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[85%] ${
                  m.who === "bot"
                    ? "bg-primary/15 text-foreground"
                    : "bg-muted/60 text-foreground self-end ml-auto"
                }`}
              >
                {m.text}
              </div>
            ))}
            {thinking && (
              <div className="text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[85%] bg-primary/10 text-muted-foreground italic">
                Unit-7 is thinking…
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim() && !thinking) handleSend();
              }}
              placeholder="Talk to Unit-7…"
              disabled={thinking}
              className="flex-1 rounded-lg bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-3 py-2 text-sm disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || thinking}
              className="bg-primary text-primary-foreground px-3 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-3 flex flex-col gap-2">
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground">
            Emotes
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

      {/* Music player — bottom-left, never blocked by the chat panel.
          Streams public-domain recordings from Wikimedia (CORS-safe),
          plays via a hidden HTML <audio> element. Auto-advances on end. */}
      <div className="absolute bottom-4 left-4 z-10 glass-panel rounded-xl px-3 py-2 flex items-center gap-2">
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
        <div className="ml-1 mr-1 max-w-[160px] overflow-hidden">
          <p className="text-[11px] font-heading font-semibold text-foreground leading-tight truncate">
            {currentTrack.title}
          </p>
          <p className="text-[9px] font-mono text-muted-foreground tracking-widest uppercase truncate">
            {currentTrack.artist}
          </p>
        </div>
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
    </div>
  );
}
