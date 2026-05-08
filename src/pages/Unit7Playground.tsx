import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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

  // Backflip — set when user clicks the emote. The render loop reads it
  // and rotates the model on X over ~0.85s, then resets.
  const backflipStartRef = useRef<number>(0);
  const sprintStartRef = useRef<number>(0);
  // Robot tint — null = original colors, otherwise a hex like 0x73ffb8.
  const robotColorRef = useRef<number | null>(null);
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

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060f, 0.012);

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
      // Underside light beam — long thin cone, semi-transparent.
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.5, 4, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      beam.position.y = -2.1;
      beam.rotation.x = Math.PI;
      g.add(beam);
      // Blinking nav light.
      const navLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff5577 }),
      );
      navLight.position.set(0.7, 0, 0);
      g.add(navLight);
      scene.add(g);
      // Stash the nav light + beam material so the render loop can pulse them.
      (g as unknown as Record<string, unknown>).__nav = navLight;
      (g as unknown as Record<string, unknown>).__beam = beam.material;
      return g;
    })();

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
      planet.rotation.y += delta * 0.05;
      moon.rotation.y += delta * 0.08;

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
      const beamMat = (ship as unknown as Record<string, unknown>).__beam as
        | THREE.MeshBasicMaterial
        | undefined;
      if (beamMat) beamMat.opacity = 0.12 + Math.abs(Math.sin(now * 0.003)) * 0.1;

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
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // ---- Resize handling --------------------------------------------
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
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
          <div className="grid grid-cols-4 gap-1.5">
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
          <div className="grid grid-cols-2 gap-1.5">
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
