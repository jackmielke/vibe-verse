import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ArrowLeft, Send, Bot } from "lucide-react";
import unit7ModelUrl from "@/assets/robot-expressive.glb";
import type {
  Unit7AnimName,
  Unit7Expression,
} from "@/components/map/Unit7Layer";
import { supabase } from "@/integrations/supabase/client";

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

const ONE_SHOTS: Set<Unit7AnimName> = new Set([
  "Wave",
  "Yes",
  "No",
  "ThumbsUp",
  "Punch",
  "Jump",
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
    camera.position.set(-6, 4, 12);
    camera.lookAt(0, 1, 0);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 4;
    controls.maxDistance = 30;
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

    function play(name: Unit7AnimName, restart = false) {
      const next = actions.get(name);
      if (!next) return;
      const oneShot = ONE_SHOTS.has(name);
      if (activeAction === next && !restart) return;
      if (activeAction && activeAction !== next) activeAction.fadeOut(0.18);
      next.reset();
      next.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
      next.clampWhenFinished = oneShot;
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
      mixer.addEventListener("finished", () => {
        // After a one-shot, return to whatever we were doing.
        desiredAnimRef.current = baseAnimRef.current;
        animPulseRef.current++;
      });
      for (const clip of gltf.animations) {
        actions.set(clip.name as Unit7AnimName, mixer.clipAction(clip));
      }

      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
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

    // ---- Animation loop ---------------------------------------------
    let lastTime = performance.now();
    let raf = 0;
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

      // Wander loop, but only when the desired anim is one of the
      // locomotion states (Idle / Walking). Don't override an emote.
      if (
        model &&
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

      {/* Side panel: chat + controls */}
      <div className="absolute top-4 right-4 bottom-4 z-10 w-[min(360px,calc(100vw-2rem))] flex flex-col gap-2.5">
        <div className="glass-panel rounded-xl p-3 flex flex-col gap-2.5 flex-1 min-h-0">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <p className="font-heading text-[12px] font-semibold tracking-wider text-foreground">
              Talk to Unit-7
            </p>
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
    </div>
  );
}
