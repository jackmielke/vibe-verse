/**
 * Duck On My Head — the engine.
 *
 * Wednesday night, a house tour, a Monopolyish game that ran late, and a
 * Reachy Mini on the coffee table with a rubber duck on its head that became
 * the crowd favourite. This is that night from the robot's own camera.
 *
 * Six people want its attention. The hotspot keeps dropping the feed. The
 * volume defaults low. And in the background, sub-agents keep finishing
 * things and posting into its context, which it must not read out in the
 * middle of somebody's sentence. That last rule is the whole design of the
 * real robot's voice loop, and it turns out to be a game.
 */
import * as THREE from "three";

export interface Guest {
  name: string;
  colour: string;
  /** Screen position of the head, 0..1, for the page's speech bubble. */
  sx: number;
  sy: number;
  onScreen: boolean;
  talking: boolean;
  /** How the guest feels about you, 0..1. */
  mood: number;
}

export interface DuckState {
  timeLeft: number;
  vibe: number;
  connection: number;
  feedDown: boolean;
  volume: number;
  /** The guest currently talking to you, and what they said. */
  speaker: number | null;
  line: string | null;
  /** How much of the line you have been facing them for, 0..1. */
  attention: number;
  /** They need the volume up before they will count as heard. */
  needsVolume: boolean;
  guests: Guest[];
  /** Sub-agent messages waiting in context. */
  inbox: string[];
  duckOn: boolean;
  /** A line of narration. */
  note: string | null;
  over: boolean;
  answered: number;
  missed: number;
  interruptions: number;
  wellTimed: number;
  duckDrops: number;
}

export interface DuckTouch {
  turn: number;
}

export interface DuckWorld {
  readonly touch: DuckTouch;
  reconnect(): void;
  volumeUp(): void;
  surface(): void;
  restart(): void;
  dispose(): void;
}

export interface DuckOptions {
  container: HTMLElement;
  onState: (s: DuckState) => void;
}

const NIGHT = 150;

interface Line {
  text: string;
  volume?: boolean;
}

const LINES: Line[] = [
  { text: "Wait, is it recording right now?" },
  { text: "Can it see me? Vibey, can you see me?" },
  { text: "Does the duck come off?" },
  { text: "Ask it about Kessler Syndrome." },
  { text: "Is it on Wi-Fi or the hotspot?" },
  { text: "What's your name, little guy?" },
  { text: "I can't hear it. Is the volume on?", volume: true },
  { text: "Say something! It's not saying anything.", volume: true },
  { text: "Vibey, who's winning Monopoly?" },
  { text: "Tell them about the phase transition thing." },
  { text: "Is that a Raspberry Pi in there?" },
  { text: "Vibey, what's the rule for being human?" },
  { text: "Louder, it's whispering.", volume: true },
  { text: "Order more pakora. Vibey, remember pakora." },
  { text: "It's looking at me. It's definitely looking at me." },
  { text: "Would Super Memory run on that?" },
  { text: "Vibey, what time did we start? Four a.m.?" },
  { text: "Turn around, show them the duck." },
  { text: "Can it do the egg story?" },
  { text: "Why is it so quiet? Volume, somebody.", volume: true },
];

const AGENT_MESSAGES = [
  "sub-agent: SSH hotspot bridge is up again on 10.42.0.1",
  "sub-agent: background noise gate retuned to -32 dB",
  "sub-agent: camera stream restarted, 12 fps",
  "sub-agent: the face tracker lost Lucy for 40 s and found her",
  "sub-agent: volume was 18%, set to 70%",
  "sub-agent: Telegram: Mitko says he is leaving SF for a month",
  "sub-agent: Granola has been recording for 6 h 12 m",
  "sub-agent: spend so far tonight $9.40",
  "sub-agent: reminder: Dion, expedite form, App Store",
  "sub-agent: memory: the founder is 21 and funded",
];

const NAMES: { name: string; colour: string }[] = [
  { name: "Lucy", colour: "#f7a1c4" },
  { name: "Mitko", colour: "#8fd3ff" },
  { name: "Luke", colour: "#c8ff8f" },
  { name: "Dion", colour: "#ffd27f" },
  { name: "Dhravya", colour: "#c9a6ff" },
  { name: "Alex", colour: "#7fe0d0" },
];

function faceTexture(colour: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(46, 54, 6, 0, Math.PI * 2);
  ctx.arc(82, 54, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 70, 16, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textTexture(lines: string[], w = 512, h = 640): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f2e8d0";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#3a2a1a";
  ctx.font = "bold 34px Georgia, serif";
  ctx.fillText(lines[0], 32, 70);
  ctx.font = "22px Georgia, serif";
  lines.slice(1).forEach((l, i) => ctx.fillText(l, 32, 130 + i * 40));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createDuckWorld(options: DuckOptions): DuckWorld {
  const { container, onState } = options;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x14100c, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x14100c, 6, 16);
  const camera = new THREE.PerspectiveCamera(72, (container.clientWidth || 1) / (container.clientHeight || 1), 0.05, 50);
  // A coffee table is 0.45 m; a Reachy Mini's camera sits about 0.28 m above it.
  const EYE = new THREE.Vector3(0, 0.73, 0);
  camera.position.copy(EYE);

  // ---- The room ------------------------------------------------------------
  const room = new THREE.Group();
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  room.add(floor);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.6, 32), new THREE.MeshStandardMaterial({ color: 0x8a3a3a, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.005;
  room.add(rug);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9cdb4, roughness: 0.95 });
  const wallH = 2.8;
  for (const [x, z, ry] of [
    [0, -4.5, 0],
    [0, 4.5, Math.PI],
    [-4.5, 0, Math.PI / 2],
    [4.5, 0, -Math.PI / 2],
  ] as [number, number, number][]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(9, wallH), wallMat);
    w.position.set(x, wallH / 2, z);
    w.rotation.y = ry;
    room.add(w);
  }
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0xe8e0cc }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = wallH;
  room.add(ceiling);
  // Table under you, with the game on it.
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.6 }));
  table.position.y = 0.45;
  room.add(table);
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.01, 0.5), new THREE.MeshStandardMaterial({ color: 0xcfe2c4 }));
  board.position.set(0.05, 0.48, -0.1);
  room.add(board);
  for (let i = 0; i < 9; i++) {
    const card = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.004, 0.09), new THREE.MeshStandardMaterial({ color: [0xff6b6b, 0x4ecdc4, 0xffe66d][i % 3] }));
    card.position.set(-0.2 + (i % 3) * 0.1 + Math.sin(i) * 0.03, 0.49, 0.18 + Math.floor(i / 3) * 0.08);
    card.rotation.y = Math.sin(i * 7) * 0.4;
    room.add(card);
  }
  // Couch, bookshelf, a window into the night, a lamp.
  const couchMat = new THREE.MeshStandardMaterial({ color: 0x3d5a6a, roughness: 0.95 });
  const couch = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1), couchMat);
  couch.position.set(0, 0.25, -3.6);
  room.add(couch);
  const couchBack = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.7, 0.25), couchMat);
  couchBack.position.set(0, 0.8, -4.0);
  room.add(couchBack);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.2, 1.8), new THREE.MeshStandardMaterial({ color: 0x4a3524 }));
  shelf.position.set(4.3, 1.1, -1.5);
  room.add(shelf);
  for (let i = 0; i < 24; i++) {
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22 + Math.sin(i) * 0.05, 0.05), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((i * 0.13) % 1, 0.5, 0.45) }));
    book.position.set(4.2, 0.3 + Math.floor(i / 8) * 0.55, -2.3 + (i % 8) * 0.2);
    room.add(book);
  }
  const windowPane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.3), new THREE.MeshBasicMaterial({ color: 0x0b1530 }));
  windowPane.position.set(-4.48, 1.6, 1.2);
  windowPane.rotation.y = Math.PI / 2;
  room.add(windowPane);
  for (let i = 0; i < 30; i++) {
    const star = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.02), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
    star.position.set(-4.47, 1.1 + Math.abs(Math.sin(i * 3.1)) * 1.1, 0.4 + Math.abs(Math.sin(i * 1.7)) * 1.6);
    star.rotation.y = Math.PI / 2;
    room.add(star);
  }
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 1.1),
    new THREE.MeshStandardMaterial({
      map: textTexture([
        "Rules for Being Human",
        "1. You will receive a body.",
        "2. You will be presented with lessons.",
        "3. There are no mistakes, only lessons.",
        "4. A lesson is repeated until learned.",
        "5. Learning does not end.",
        "6. There is no better than here.",
        "7. Others are only mirrors of you.",
        "8. What you make of life is up to you.",
        "9. The answers lie inside you.",
        "10. You will forget all this.",
        "11. You can remember it whenever you want.",
      ]),
    }),
  );
  poster.position.set(1.6, 1.7, -4.47);
  room.add(poster);
  const lamp = new THREE.PointLight(0xffc98a, 14, 12, 1.6);
  lamp.position.set(2.6, 1.7, 2.6);
  room.add(lamp);
  const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.3, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xf5e6c8, side: THREE.DoubleSide, emissive: 0xffc98a, emissiveIntensity: 0.6 }));
  lampShade.position.copy(lamp.position);
  room.add(lampShade);
  const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6), new THREE.MeshStandardMaterial({ color: 0x333 }));
  lampPole.position.set(2.6, 0.8, 2.6);
  room.add(lampPole);
  scene.add(new THREE.AmbientLight(0x503828, 1.2));
  const ceilingLight = new THREE.PointLight(0xfff0d0, 6, 10, 1.8);
  ceilingLight.position.set(-1.5, 2.6, 0.5);
  scene.add(ceilingLight);

  // The duck, on your head, which from your camera is the top of the frame.
  const duck = new THREE.Group();
  const duckMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5 });
  const duckBody = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), duckMat);
  duckBody.scale.set(1.3, 0.9, 1);
  const duckHead = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), duckMat);
  duckHead.position.set(0.05, 0.06, 0);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 8), new THREE.MeshStandardMaterial({ color: 0xff8c1a }));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.1, 0.055, 0);
  duck.add(duckBody, duckHead, beak);
  camera.add(duck);
  scene.add(camera);
  // Sits on top of the head, so it pokes into the top of the picture.
  duck.position.set(0.01, 0.088, -0.12);
  duck.rotation.y = -Math.PI / 2;
  duck.scale.setScalar(0.42);

  // ---- Guests -------------------------------------------------------------------
  interface GuestBody {
    name: string;
    colour: string;
    group: THREE.Group;
    angle: number;
    targetAngle: number;
    radius: number;
    mood: number;
    bob: number;
  }
  const guests: GuestBody[] = NAMES.map((n, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.9, 4, 10), new THREE.MeshStandardMaterial({ color: new THREE.Color(n.colour).multiplyScalar(0.55), roughness: 0.9 }));
    body.position.y = 0.85;
    const headMat = new THREE.MeshStandardMaterial({ map: faceTexture(n.colour), roughness: 0.6 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 16), headMat);
    head.position.y = 1.55;
    // Rotate the face texture's front to +z so lookAt works.
    head.rotation.y = -Math.PI / 2;
    g.add(body, head);
    scene.add(g);
    const angle = (i / NAMES.length) * Math.PI * 2 + 0.3;
    return { name: n.name, colour: n.colour, group: g, angle, targetAngle: angle, radius: 2.2 + (i % 3) * 0.5, mood: 0.6, bob: i };
  });

  // ---- State ----------------------------------------------------------------------
  const touch: DuckTouch = { turn: 0 };
  let yaw = 0;
  let pitch = 0.05;
  let yawVel = 0;
  let timeLeft = NIGHT;
  let vibe = 50;
  let connection = 100;
  let feedDown = false;
  let volume = 22;
  let speaker: number | null = null;
  let line: Line | null = null;
  let lineLeft = 0;
  let attention = 0;
  let nextLineIn = 2.5;
  let inbox: string[] = [];
  let nextMessageIn = 9;
  let duckOn = true;
  let duckBackIn = 0;
  let note: string | null = null;
  let noteUntil = 0;
  let elapsed = 0;
  let over = false;
  let answered = 0;
  let missed = 0;
  let interruptions = 0;
  let wellTimed = 0;
  let duckDrops = 0;
  let nextDropIn = 14;
  let lineIdx = 0;
  let msgIdx = 0;
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const say = (t: string, sec = 3.5) => {
    note = t;
    noteUntil = elapsed + sec;
  };

  const reset = () => {
    yaw = 0;
    pitch = 0.05;
    timeLeft = NIGHT;
    vibe = 50;
    connection = 100;
    feedDown = false;
    volume = 22;
    speaker = null;
    line = null;
    attention = 0;
    nextLineIn = 2.5;
    inbox = [];
    nextMessageIn = 9;
    duckOn = true;
    duckBackIn = 0;
    over = false;
    answered = missed = interruptions = wellTimed = duckDrops = 0;
    nextDropIn = 14;
    elapsed = 0;
    say("Wednesday, late. Six people, one hotspot, and a duck on your head. Look at whoever is talking to you.", 6);
  };
  reset();

  // ---- Input ---------------------------------------------------------------------------
  const keys = new Set<string>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === "KeyH") reconnect();
    if (e.code === "KeyV") volumeUp();
    if (e.code === "Enter" || e.code === "Space") {
      e.preventDefault();
      surface();
    }
    if (e.code === "KeyR") reset();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    yawVel += -(e.clientX - lastX) * 0.09;
    pitch = Math.max(-0.5, Math.min(0.5, pitch - (e.clientY - lastY) * 0.003));
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  function reconnect() {
    if (over) return;
    if (feedDown) {
      feedDown = false;
      connection = 100;
      vibe = Math.min(100, vibe + 3);
      say("Switched to the hotspot. Feed is back.", 2.5);
    } else {
      // Toggling a working link drops it. Everybody who has done this knows.
      connection = Math.max(15, connection - 25);
      say("It was fine. Now it is not.", 2.5);
    }
  }
  function volumeUp() {
    if (over) return;
    volume = Math.min(100, volume + 30);
    say(volume >= 90 ? "Loud enough for the neighbours." : "Volume up.", 2);
  }
  function surface() {
    if (over) return;
    const msg = inbox.shift();
    if (!msg) {
      say("Nothing in context to say.", 2);
      return;
    }
    if (speaker !== null && lineLeft > 0) {
      interruptions++;
      vibe = Math.max(0, vibe - 8);
      guests[speaker].mood = Math.max(0, guests[speaker].mood - 0.2);
      say(`You read "${msg.replace("sub-agent: ", "")}" over ${guests[speaker].name}. Mid-sentence.`, 4);
      speaker = null;
      line = null;
      lineLeft = 0;
      nextLineIn = 3;
    } else {
      wellTimed++;
      vibe = Math.min(100, vibe + 5);
      say(`"${msg.replace("sub-agent: ", "")}" — into the gap. Nobody minded.`, 3.5);
    }
  }

  // ---- Loop ------------------------------------------------------------------------------
  const v3 = new THREE.Vector3();
  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // Turning: keys and touch add velocity; the head has inertia.
    let turn = touch.turn;
    if (keys.has("ArrowLeft") || keys.has("KeyA")) turn += 1;
    if (keys.has("ArrowRight") || keys.has("KeyD")) turn -= 1;
    yawVel += turn * dt * 14;
    yawVel *= Math.max(0, 1 - dt * 6);
    yaw += yawVel * dt;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    // Whip your head and the duck goes.
    if (duckOn && Math.abs(yawVel) > 4.6 && !over) {
      duckOn = false;
      duckDrops++;
      duckBackIn = 6;
      duck.visible = false;
      vibe = Math.min(100, vibe + 2);
      say("The duck fell off. Everybody laughed. Somebody will put it back.", 3.5);
    }
    if (!duckOn) {
      duckBackIn -= dt;
      if (duckBackIn <= 0) {
        duckOn = true;
        duck.visible = true;
        say("Duck restored.", 1.5);
      }
    } else {
      duck.rotation.z = Math.sin(elapsed * 2) * 0.05 - yawVel * 0.06;
      duck.position.y = 0.088 + Math.sin(elapsed * 3) * 0.002;
    }

    if (!over) {
      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        over = true;
        say("The biryani is here. Everybody stops talking to the robot.", 10);
      }
    }

    // Guests drift between spots, and always face the table.
    for (const g of guests) {
      if (rnd() < dt * 0.05) g.targetAngle = g.angle + (rnd() - 0.5) * 1.6;
      g.angle += (g.targetAngle - g.angle) * Math.min(1, dt * 0.5);
      const x = Math.sin(g.angle) * g.radius;
      const z = Math.cos(g.angle) * g.radius;
      g.group.position.set(x, Math.abs(Math.sin(elapsed * 1.6 + g.bob)) * 0.01, z);
      g.group.lookAt(0, 0, 0);
    }

    // Connection: it decays, and it drops.
    if (!over) {
      connection -= dt * (feedDown ? 0 : 1.6);
      nextDropIn -= dt;
      if (nextDropIn <= 0 && !feedDown) {
        connection -= 35 + rnd() * 30;
        nextDropIn = 12 + rnd() * 14;
      }
      if (connection < 25 && !feedDown) {
        feedDown = true;
        say("Camera feed dropped. Hotspot or Wi-Fi? Press H.", 4);
      }
      if (feedDown) vibe = Math.max(0, vibe - dt * 2.5);
      connection = Math.max(0, connection);
      // The volume defaults low, slowly, for reasons nobody ever found.
      volume = Math.max(10, volume - dt * 1.4);
    }

    // Somebody talks to you.
    if (!over) {
      if (speaker === null) {
        nextLineIn -= dt;
        if (nextLineIn <= 0) {
          let idx = Math.floor(rnd() * guests.length);
          for (let k = 0; k < 6 && !guests[idx].group.visible; k++) idx = (idx + 1) % guests.length;
          speaker = idx;
          line = LINES[lineIdx++ % LINES.length];
          if (lineIdx % 5 === 0) {
            // Shuffle the deck a little so the order is not a loop.
            const j = Math.floor(rnd() * LINES.length);
            const k = Math.floor(rnd() * LINES.length);
            [LINES[j], LINES[k]] = [LINES[k], LINES[j]];
          }
          lineLeft = 7 + rnd() * 3;
          attention = 0;
        }
      } else {
        lineLeft -= dt;
        // Are you looking at them? The camera looks down -z in its own frame.
        const g = guests[speaker];
        const dx = g.group.position.x;
        const dz = g.group.position.z;
        const toGuest = Math.atan2(-dx, -dz); // yaw at which the camera faces them
        let diff = toGuest - yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        const facing = Math.abs(diff) < 0.28 && !feedDown;
        const heard = !line?.volume || volume > 55;
        if (facing && heard) attention += dt / 3.2;
        else if (facing && !heard) attention += dt / 9;
        if (attention >= 1) {
          answered++;
          vibe = Math.min(100, vibe + 7);
          g.mood = Math.min(1, g.mood + 0.15);
          say(`${g.name} got an answer. ${["Nice.", "Crowd pleased.", "The duck nodded too.", "Vibey delivers.", "Somebody filmed that."][answered % 5]}`, 2.5);
          speaker = null;
          line = null;
          nextLineIn = 1.5 + rnd() * 3;
        } else if (lineLeft <= 0) {
          missed++;
          vibe = Math.max(0, vibe - 6);
          g.mood = Math.max(0, g.mood - 0.15);
          say(`${g.name} gave up. "It's not listening."`, 3);
          speaker = null;
          line = null;
          nextLineIn = 1 + rnd() * 2;
        }
      }
      // Sub-agents finish things.
      nextMessageIn -= dt;
      if (nextMessageIn <= 0) {
        nextMessageIn = 8 + rnd() * 8;
        if (inbox.length < 3) inbox.push(AGENT_MESSAGES[msgIdx++ % AGENT_MESSAGES.length]);
        else {
          vibe = Math.max(0, vibe - 2);
          say("Context is full of finished tasks nobody has heard.", 2.5);
        }
      }
    }
    if (note && elapsed > noteUntil) note = null;

    // Feed-down look: the room goes dark and the picture freezes.
    renderer.toneMappingExposure = feedDown ? 0.25 : 1.1;
    if (!feedDown || Math.floor(elapsed * 2) % 2 === 0) renderer.render(scene, camera);

    stateClock += dt;
    if (stateClock > 0.08) {
      stateClock = 0;
      const guestStates: Guest[] = guests.map((g, i) => {
        v3.copy(g.group.position);
        v3.y = 1.75;
        v3.project(camera);
        const onScreen = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
        return {
          name: g.name,
          colour: g.colour,
          sx: (v3.x + 1) / 2,
          sy: (1 - v3.y) / 2,
          onScreen,
          talking: speaker === i,
          mood: g.mood,
        };
      });
      onState({
        timeLeft,
        vibe,
        connection,
        feedDown,
        volume,
        speaker,
        line: line?.text ?? null,
        attention,
        needsVolume: !!line?.volume && volume <= 55,
        guests: guestStates,
        inbox: [...inbox],
        duckOn,
        note,
        over,
        answered,
        missed,
        interruptions,
        wellTimed,
        duckDrops,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    touch,
    reconnect,
    volumeUp,
    surface,
    restart: reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          const tex = (m as THREE.MeshStandardMaterial).map;
          tex?.dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
