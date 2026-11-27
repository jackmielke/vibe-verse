/**
 * Vibe City's side quests: Granny Mabel's lost pets, fishing at the marina,
 * Vinnie's street races and the Sky Sprint up the Empire State.
 *
 * Each quest is its own module with its own scenery and state machine; this
 * file only runs them, picks the nearest E prompt, routes dialog answers back
 * to whoever asked, and hands the page one `QuestStep` a frame. City.tsx
 * calls `buildQuests` once, `update` after its physics step, `act` on E, and
 * mounts `QuestHud`.
 */
import * as THREE from "three";
import type { Dialog, Prompt, QuestCtx, QuestHost, QuestStep } from "./common";
import { buildGrannyQuest } from "./granny";
import { buildFishing, type FishingUi } from "./fishing";
import { QUEST_HATS, earnedQuestHats, wornQuestHat } from "./hats";

export type { QuestCtx, QuestHost, QuestStep } from "./common";
export { QUEST_HATS, questHat, wornQuestHat, setWornQuestHat } from "./hats";

export interface QuestUi {
  prompt: { emoji: string; label: string } | null;
  dialog: Dialog | null;
  tracker: { emoji: string; text: string; sub?: string; arrow?: number } | null;
  fishing: FishingUi | null;
  /** A hold-to-act button is needed (the reel) on a phone. */
  hold: boolean;
}

export interface QuestLogEntry {
  title: string;
  status: string;
  /** Where "take me there" goes. */
  at: [number, number, number];
  extra?: string[];
}

export interface Quests {
  group: THREE.Group;
  update(ctx: QuestCtx): QuestStep | null;
  /** E pressed. True if a quest took it. */
  act(): boolean;
  /** A dialog option tapped. */
  choose(id: string): void;
  /** The on-screen hold button (the reel on a phone). */
  setHold(on: boolean): void;
  holding(): boolean;
  ui(): QuestUi;
  log(): { quests: QuestLogEntry[]; hats: Array<{ id: string; name: string; emoji: string; earned: boolean }>; worn: string | null };
  dev(): Record<string, unknown>;
  dispose(): void;
}

export function buildQuests(host: QuestHost): Quests {
  const group = new THREE.Group();
  group.name = "quests";

  const GRANNY = new THREE.Vector3(10.5, 0, 5);
  const granny = buildGrannyQuest(host, { at: GRANNY, face: Math.atan2(-GRANNY.x, -GRANNY.z) });
  const fishing = buildFishing(host, {
    spot: new THREE.Vector3(-222, 1.5, 60.9),
    salAt: new THREE.Vector3(-218.6, 1.5, 61.0),
    face: 0,
  });
  group.add(granny.group, fishing.group);

  type Owner = { dialog(): Dialog | null; choose(id: string): void; closeDialog(): void };
  const owners: Owner[] = [granny, fishing];

  let prompt: Prompt | null = null;
  let tracker: QuestUi["tracker"] = null;
  let holdButton = false;
  let lastCtx: QuestCtx | null = null;

  return {
    group,
    update(ctx) {
      const c = { ...ctx, input: { ...ctx.input, hold: ctx.input.hold || holdButton } };
      lastCtx = c;
      granny.update(c);
      const step = fishing.update(c);
      // The nearest prompt wins; an active quest's own prompt (strike!) is at distance 0.
      const ps = [granny.prompt(c), fishing.prompt(c)].filter((p): p is Prompt => !!p);
      ps.sort((a, b) => a.dist - b.dist);
      prompt = ps[0] ?? null;
      const tr = granny.tracker(c);
      if (tr) {
        let arrow: number | undefined;
        if (tr.target) {
          // Screen-space bearing: 0 is straight ahead of the camera.
          const bearing = Math.atan2(tr.target.x - c.player.x, tr.target.z - c.player.z);
          const camFwd = c.camYaw + Math.PI;
          arrow = bearing - camFwd;
        }
        tracker = { emoji: tr.emoji, text: tr.text, sub: tr.sub, arrow };
      } else tracker = null;
      return step;
    },
    act() {
      // An open dialog takes E as its first option.
      for (const o of owners) {
        const d = o.dialog();
        if (d) {
          const first = d.options.find((x) => !x.disabled);
          if (first) o.choose(first.id);
          else o.closeDialog();
          return true;
        }
      }
      if (prompt) {
        prompt.act();
        return true;
      }
      return false;
    },
    choose(id) {
      for (const o of owners) if (o.dialog()) return o.choose(id);
    },
    setHold(on) {
      holdButton = on;
    },
    holding: () => fishing.active(),
    ui() {
      let dialog: Dialog | null = null;
      for (const o of owners) dialog ??= o.dialog();
      const f = fishing.ui();
      return {
        prompt: dialog || f?.phase === "reel" ? null : prompt ? { emoji: prompt.emoji, label: prompt.label } : null,
        dialog,
        tracker,
        fishing: f,
        hold: f?.phase === "reel",
      };
    },
    log() {
      const g = granny.log();
      const f = fishing.log();
      const earned = earnedQuestHats();
      return {
        quests: [
          { title: g.title, status: g.status, at: [GRANNY.x + 2, 0.2, GRANNY.z + 2] },
          {
            title: f.title,
            status: f.status,
            at: [-214, 1.8, 60],
            extra: f.journal.map((j) => `${j.emoji} ${j.name} ×${j.count} (best ${j.best} kg)`),
          },
        ],
        hats: QUEST_HATS.map((h) => ({ id: h.id, name: h.name, emoji: h.emoji, earned: earned.includes(h.id) })),
        worn: wornQuestHat(),
      };
    },
    dev: () => ({ granny: granny.dev(), fishing: (op?: string) => fishing.dev(op), last: lastCtx?.player.toArray() }),
    dispose() {
      granny.dispose();
      fishing.dispose();
    },
  };
}
