/**
 * Granny Mabel's lost pets.
 *
 * She waits on a bench at the edge of the plaza, wringing her hands. Talk to
 * her and one of her three pets has run off somewhere in the city; she tells
 * you roughly where she last saw it, and a hot-and-cold readout does the
 * rest. Pets are skittish: come in at a run and they bolt (twice at most, so
 * nobody gets stuck chasing a cat round a lamp post forever). Walk up, scoop
 * them up, and they trot behind you back to her.
 *
 * The first time each pet comes home she pays in a hat you cannot buy
 * (`hats.ts`). After that it is a few coins and a lot of thanks.
 */
import * as THREE from "three";
import { buildGranny, buildPet, type Pet, type PetKind } from "./npc";
import { ARCADE_HAT_IDS, QUEST_HATS, earnQuestHat, earnedQuestHats } from "./hats";
import { dist2, load, save, type Dialog, type Prompt, type QuestCtx, type QuestHost } from "./common";

interface PetDef {
  kind: PetKind;
  name: string;
  hat: string;
  sound: string;
}

const PETS: PetDef[] = [
  { kind: "cat", name: "Biscuit", hat: "fedora", sound: "Mrrrow?" },
  { kind: "pug", name: "Pickles", hat: "captain", sound: "Snort! Woof!" },
  { kind: "bunny", name: "Sir Hops", hat: "wizard", sound: "*happy thump*" },
];

/** Where a pet can be hiding, with the hint Granny gives. Ground level, out of traffic. */
export const HIDEOUTS: Array<{ x: number; z: number; hint: string }> = [
  { x: 6, z: 86, hint: "sniffing round the feet of the Eiffel Tower" },
  { x: -84, z: 88, hint: "in the flower beds at the Vibe Commons gardens" },
  { x: 92, z: -28, hint: "under the trees by the Space Needle" },
  { x: -47, z: -64, hint: "on the front steps of the Empire State Building" },
  { x: -126, z: 75, hint: "watching the footballers at Vibe Commons" },
  { x: 66, z: -20, hint: "chasing pigeons near the old warehouse" },
];

const SAVE = "city.quest.granny";
const REPEAT_COINS = 15;

type State =
  | { kind: "idle" }
  | { kind: "search"; pet: number; spot: number; flees: number; fleeTo: THREE.Vector3 | null }
  | { kind: "carry"; pet: number };

export interface GrannyQuest {
  group: THREE.Group;
  at: THREE.Vector3;
  update(ctx: QuestCtx): void;
  prompt(ctx: QuestCtx): Prompt | null;
  dialog(): Dialog | null;
  choose(id: string): void;
  closeDialog(): void;
  tracker(ctx: QuestCtx): { emoji: string; text: string; sub?: string; target?: THREE.Vector3 } | null;
  log(): { title: string; status: string };
  dev(): unknown;
  dispose(): void;
}

export function buildGrannyQuest(host: QuestHost, opts: { at: THREE.Vector3; face: number }): GrannyQuest {
  const group = new THREE.Group();
  group.name = "quest.granny";
  const granny = buildGranny();
  granny.group.position.copy(opts.at);
  granny.group.rotation.y = opts.face;
  group.add(granny.group);

  // Her bench, behind her.
  {
    const wood = new THREE.MeshStandardMaterial({ color: "#8a5a32", roughness: 0.85 });
    const iron = new THREE.MeshStandardMaterial({ color: "#2b2f36", roughness: 0.5, metalness: 0.6 });
    const bench = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.13), wood);
      slat.position.set(0, 0.46, -0.15 + i * 0.16);
      bench.add(slat);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 0.05), wood);
    back.position.set(0, 0.75, -0.28);
    bench.add(back);
    for (const x of [-0.8, 0.8]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.5), iron);
      leg.position.set(x, 0.23, 0);
      bench.add(leg);
    }
    bench.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    bench.position.copy(opts.at);
    bench.rotation.y = opts.face;
    bench.translateZ(-0.9);
    group.add(bench);
    // A "LOST PET" poster on a little sandwich board beside her.
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 320;
    const x = c.getContext("2d")!;
    x.fillStyle = "#fff8e1";
    x.fillRect(0, 0, 256, 320);
    x.fillStyle = "#c0392b";
    x.font = "bold 46px Georgia, serif";
    x.textAlign = "center";
    x.fillText("LOST", 128, 56);
    x.fillText("PET!", 128, 104);
    x.font = "80px serif";
    x.fillText("🐈 🐶 🐇", 128, 200);
    x.fillStyle = "#333";
    x.font = "bold 24px Georgia, serif";
    x.fillText("Reward: a fine hat", 128, 262);
    x.font = "20px Georgia, serif";
    x.fillText("ask Mabel", 128, 296);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.875), new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.04), wood);
    const sign = new THREE.Group();
    board.position.z = 0.025;
    sign.add(frame, board);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.06), wood);
    post.position.y = -0.8;
    sign.add(post);
    sign.position.copy(opts.at);
    sign.rotation.y = opts.face;
    sign.translateX(1.6);
    sign.position.y = opts.at.y + 1.25;
    group.add(sign);
  }

  const pets: Pet[] = PETS.map((d) => {
    const p = buildPet(d.kind);
    p.group.visible = false;
    group.add(p.group);
    return p;
  });

  const saved = load(SAVE, { next: 0, returned: 0 });
  let state: State = { kind: "idle" };
  let dialog: Dialog | null = null;
  let pending: "offer" | "thanks" | null = null;
  let rewardText = "";
  const petPos = new THREE.Vector3();
  const petVel = new THREE.Vector3();
  let petYaw = 0;
  const lastPlayer = new THREE.Vector3();
  let playerSpeed = 0;
  let lastMeow = 0;
  const trail: THREE.Vector3[] = [];

  const nextPet = () => saved.next % PETS.length;

  const offer = () => {
    const def = PETS[nextPet()];
    const hatOwned = earnedQuestHats().includes(def.hat);
    const reward = hatOwned ? `${REPEAT_COINS} coins and a slice of pie` : `a very fine hat`;
    dialog = {
      speaker: "Granny Mabel",
      emoji: "👵",
      text:
        saved.returned === 0
          ? `Oh, thank goodness, a kind face! My ${def.kind === "pug" ? "dog" : def.kind} ${def.name} slipped the lead and ran off into the city. Would you find ${def.name} for me? I'll pay you in ${reward}.`
          : `Oh, not again. ${def.name} has wandered off now! You're so good at this, dear. Bring ${def.name} home and there's ${reward} in it for you.`,
      options: [
        { id: "accept", label: `I'll find ${def.name}!` },
        { id: "later", label: "Not right now" },
      ],
    };
    pending = "offer";
  };

  const start = () => {
    const pet = nextPet();
    // A different spot from last time, chosen by the clock.
    const spot = (saved.returned * 3 + pet + Math.floor(Date.now() / 60000)) % HIDEOUTS.length;
    const h = HIDEOUTS[spot];
    petPos.set(h.x, 0, h.z);
    pets.forEach((p, i) => (p.group.visible = i === pet));
    pets[pet].group.position.copy(petPos);
    state = { kind: "search", pet, spot, flees: 0, fleeTo: null };
    host.toast(`Find ${PETS[pet].name}`, `Granny saw ${PETS[pet].name} ${h.hint}.`);
    host.sound("chime", 3);
  };

  const finish = () => {
    if (state.kind !== "carry") return;
    const def = PETS[state.pet];
    const hat = QUEST_HATS.find((h) => h.id === def.hat)!;
    const first = !earnedQuestHats().includes(def.hat);
    if (first) {
      earnQuestHat(def.hat);
      host.wearHat(def.hat);
      rewardText = `${def.name}! Oh, you clever thing. Here, take this. It was my Harold's, and it never suited him half as well as it will suit you. (${hat.emoji} ${hat.name} unlocked and on your head!)`;
      host.toast(`${hat.emoji} ${hat.name}`, "A thank-you hat from Granny Mabel. Swap hats in the Quests menu.");
    } else {
      host.earn(REPEAT_COINS, `Brought ${def.name} home`);
      rewardText = `${def.name}, you rascal! Thank you, dear. Here's a little something for your trouble, and do come back for pie.`;
    }
    host.sound("fanfare");
    saved.next = (saved.next + 1) % PETS.length;
    saved.returned++;
    save(SAVE, saved);
    pets[state.pet].group.visible = false;
    state = { kind: "idle" };
    dialog = { speaker: "Granny Mabel", emoji: "👵", text: rewardText, options: [{ id: "bye", label: "Happy to help!" }] };
    pending = "thanks";
  };

  const scoop = () => {
    if (state.kind !== "search") return;
    const def = PETS[state.pet];
    state = { kind: "carry", pet: state.pet };
    trail.length = 0;
    host.toast(`${def.name}: "${def.sound}"`, `Take ${def.name} back to Granny Mabel at the plaza.`);
    host.sound("meow");
  };

  return {
    group,
    at: opts.at,
    update(ctx) {
      const t = ctx.t;
      granny.animate(t, ctx.dt);
      granny.marker.visible = state.kind === "idle";
      // How fast the player is moving, smoothed.
      const sp = ctx.dt > 0 ? lastPlayer.distanceTo(ctx.player) / ctx.dt : 0;
      lastPlayer.copy(ctx.player);
      // A jump of more than 40 m/s is a teleport ("take me there"), not a sprint.
      if (sp > 40) playerSpeed = 0;
      else playerSpeed += (sp - playerSpeed) * Math.min(1, ctx.dt * 6);

      if (dialog && dist2(ctx.player.x, ctx.player.z, opts.at.x, opts.at.z) > 7) dialog = null;

      if (state.kind === "search") {
        const pet = pets[state.pet];
        const d = dist2(ctx.player.x, ctx.player.z, petPos.x, petPos.z);
        // Skittish: a running (or driving) player close by sends it scampering.
        if (!state.fleeTo && state.flees < 2 && d < 6 && playerSpeed > 5.2) {
          const away = new THREE.Vector3(petPos.x - ctx.player.x, 0, petPos.z - ctx.player.z).normalize();
          const side = new THREE.Vector3(-away.z, 0, away.x).multiplyScalar(state.flees ? -6 : 6);
          state.fleeTo = petPos.clone().addScaledVector(away, 11).add(side);
          state.flees++;
          host.toast(`${PETS[state.pet].name} bolts!`, "Too fast. Walk up slowly, pets spook easily.");
          host.sound("meow");
        }
        let speed = 0;
        if (state.fleeTo) {
          const to = new THREE.Vector3().subVectors(state.fleeTo, petPos);
          to.y = 0;
          const len = to.length();
          if (len < 0.3) state.fleeTo = null;
          else {
            speed = Math.min(9, len * 4);
            to.multiplyScalar(1 / len);
            petPos.addScaledVector(to, Math.min(len, speed * ctx.dt));
            petYaw = Math.atan2(to.x, to.z);
          }
        } else {
          // Sniff about on the spot.
          petYaw += Math.sin(t * 0.7) * ctx.dt * 0.6;
        }
        pet.group.position.copy(petPos);
        pet.group.rotation.y = petYaw;
        pet.animate(t, speed);
        if (d < 25 && t - lastMeow > 4.5) {
          lastMeow = t;
          host.sound("meow");
        }
      } else if (state.kind === "carry") {
        const pet = pets[state.pet];
        // Follow a breadcrumb trail a few metres behind the player.
        const last = trail[trail.length - 1];
        // A teleport starts a fresh trail, or the pet runs back to where you were.
        if (last && last.distanceTo(ctx.player) > 30) trail.length = 0;
        if (!last || trail.length === 0 || last.distanceTo(ctx.player) > 0.5) {
          trail.push(ctx.player.clone());
          if (trail.length > 40) trail.shift();
        }
        const lag = ctx.vehicle ? 3.5 : 2.2;
        let target = trail[0] ?? ctx.player;
        let acc = 0;
        for (let i = trail.length - 1; i > 0; i--) {
          acc += trail[i].distanceTo(trail[i - 1]);
          if (acc >= lag) {
            target = trail[i - 1];
            break;
          }
        }
        const to = new THREE.Vector3().subVectors(target, petPos);
        to.y = 0;
        const len = to.length();
        // Left behind: catch up at once rather than lose the pet.
        if (len > 30) petPos.set(target.x, 0, target.z);
        const speed = len > 0.4 ? Math.min(40, len * 3) : 0;
        if (speed > 0) {
          petPos.addScaledVector(to.normalize(), Math.min(len, speed * ctx.dt));
          petYaw = Math.atan2(to.x, to.z);
        }
        // Ground or whatever the player is standing on, eased.
        petPos.y += (Math.max(0, ctx.player.y) - petPos.y) * Math.min(1, ctx.dt * 5);
        pet.group.position.copy(petPos);
        pet.group.rotation.y = petYaw;
        pet.animate(t, speed);
        if (dist2(petPos.x, petPos.z, opts.at.x, opts.at.z) < 4 && dist2(ctx.player.x, ctx.player.z, opts.at.x, opts.at.z) < 6) finish();
      }
    },
    prompt(ctx) {
      if (ctx.vehicle) return null;
      const dG = dist2(ctx.player.x, ctx.player.z, opts.at.x, opts.at.z);
      if (state.kind === "search") {
        const d = dist2(ctx.player.x, ctx.player.z, petPos.x, petPos.z);
        if (d < 2.4 && !state.fleeTo) return { emoji: "🫶", label: `Scoop up ${PETS[state.pet].name}`, dist: d, act: scoop };
      }
      if (dG < 3.2 && !dialog && Math.abs(ctx.player.y - opts.at.y) < 2) {
        if (state.kind === "idle") return { emoji: "👵", label: "Talk to Granny Mabel", dist: dG, act: offer };
        if (state.kind === "search")
          return {
            emoji: "👵",
            label: "Talk to Granny Mabel",
            dist: dG,
            act: () => {
              if (state.kind !== "search") return;
              dialog = {
                speaker: "Granny Mabel",
                emoji: "👵",
                text: `Any luck? I'm sure I saw ${PETS[state.pet].name} ${HIDEOUTS[state.spot].hint}. Walk up gently, mind.`,
                options: [{ id: "bye", label: "On it!" }, { id: "giveup", label: "I give up" }],
              };
              pending = null;
            },
          };
      }
      return null;
    },
    dialog: () => dialog,
    choose(id) {
      if (id === "accept" && pending === "offer") start();
      if (id === "giveup" && state.kind === "search") {
        pets[state.pet].group.visible = false;
        state = { kind: "idle" };
      }
      dialog = null;
      pending = null;
    },
    closeDialog() {
      dialog = null;
    },
    tracker(ctx) {
      if (state.kind === "search") {
        const d = dist2(ctx.player.x, ctx.player.z, petPos.x, petPos.z);
        const heat = d > 140 ? "❄️ Cold" : d > 70 ? "🌬️ Cool" : d > 35 ? "🌤️ Warm" : d > 14 ? "🔥 Hot!" : "🔥🔥 Right here!";
        return { emoji: "🐾", text: `Find ${PETS[state.pet].name}: ${heat}`, sub: `Last seen ${HIDEOUTS[state.spot].hint}`, target: petPos };
      }
      if (state.kind === "carry") {
        const d = Math.round(dist2(ctx.player.x, ctx.player.z, opts.at.x, opts.at.z));
        return { emoji: "👵", text: `Bring ${PETS[state.pet].name} home`, sub: `Granny Mabel, plaza, ${d} m`, target: opts.at };
      }
      return null;
    },
    log() {
      const grannyHats = QUEST_HATS.filter((h) => !ARCADE_HAT_IDS.includes(h.id));
      const hats = earnedQuestHats().filter((id) => grannyHats.some((h) => h.id === id)).length;
      return {
        title: "👵 Granny Mabel's lost pets",
        status:
          state.kind === "search"
            ? `Looking for ${PETS[state.pet].name}`
            : state.kind === "carry"
              ? `Bringing ${PETS[state.pet].name} home`
              : `${saved.returned} ${saved.returned === 1 ? "pet" : "pets"} returned, ${hats} of ${grannyHats.length} hats earned`,
      };
    },
    dev: () => ({ state, petPos: petPos.toArray(), saved, playerSpeed }),
    dispose() {
      granny.dispose();
      pets.forEach((p) => p.dispose());
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mt = m.material as THREE.MeshStandardMaterial;
          mt.map?.dispose();
          mt.dispose?.();
        }
      });
    },
  };
}
