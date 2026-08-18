/**
 * The jetpack, and the sound that would not stop.
 *
 * Both of these shipped looking correct in the only situation anybody had
 * checked: a character standing still in a plaza, and a player who had not yet
 * sunk a car. What they had in common is that the failure only appears once
 * something ELSE moves — the rig's root, or the player away from an event.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { alignToBone, boxInHolder } from "@/city/boneMount";

const backSrc = readFileSync(resolve(__dirname, "../city/backMount.ts"), "utf8");
const headSrc = readFileSync(resolve(__dirname, "../city/headMount.ts"), "utf8");
const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");
const soundsSrc = readFileSync(resolve(__dirname, "../lib/citySounds.ts"), "utf8");

/** A holder with a bone under it, rolled and scaled the way real rigs are. */
function rig(opts: { holderScale?: number; boneRoll?: number; boneScale?: number } = {}) {
  const holder = new THREE.Group();
  holder.scale.setScalar(opts.holderScale ?? 1);
  const model = new THREE.Group();
  holder.add(model);
  const bone = new THREE.Object3D();
  bone.position.set(0, 1.1, 0);
  bone.rotation.z = opts.boneRoll ?? 0;
  bone.scale.setScalar(opts.boneScale ?? 1);
  model.add(bone);
  holder.updateWorldMatrix(true, true);
  return { holder, model, bone };
}

describe("the bind-pose correction", () => {
  it("leaves a child upright on a bone that is rolled ninety degrees", () => {
    // A bone's rest orientation is whatever its author left it at. Parent
    // straight to it and roughly half the cast wears its hat sideways.
    const { holder, bone } = rig({ boneRoll: Math.PI / 2 });
    const align = new THREE.Group();
    const child = new THREE.Object3D();
    align.add(child);
    alignToBone(align, bone, holder);
    holder.updateWorldMatrix(true, true);
    const q = child.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.y).toBeCloseTo(1, 5);
  });

  it("cancels a bone's scale so accessories keep their authored size", () => {
    const { holder, bone } = rig({ boneScale: 2.5 });
    const align = new THREE.Group();
    const child = new THREE.Object3D();
    align.add(child);
    alignToBone(align, bone, holder);
    holder.updateWorldMatrix(true, true);
    const s = child.getWorldScale(new THREE.Vector3());
    expect(s.x).toBeCloseTo(1, 5);
  });

  it("measures in the holder's space, so the shop can scale the player", () => {
    // The shop can change the player's scale at any time. A fit computed in
    // world space silently works at scale 1 and breaks everywhere else.
    const a = rig({ holderScale: 1 });
    const b = rig({ holderScale: 3 });
    const fitA = alignToBone(new THREE.Group(), a.bone, a.holder);
    const fitB = alignToBone(new THREE.Group(), b.bone, b.holder);
    expect(fitB.pos.y).toBeCloseTo(fitA.pos.y, 5);
  });

  it("brings the model's box into that same space", () => {
    const { holder, model, bone } = rig({ holderScale: 3 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
    mesh.position.y = 1;
    model.add(mesh);
    holder.updateWorldMatrix(true, true);
    const box = boxInHolder(new THREE.Box3(), model, holder);
    const fit = alignToBone(new THREE.Group(), bone, holder);
    // Box top at y=2 in holder units regardless of the holder's own scale, and
    // the bone at 1.1 — so a head gap measured between them is scale-free.
    expect(box.max.y).toBeCloseTo(2, 4);
    expect(box.max.y - fit.pos.y).toBeCloseTo(0.9, 4);
  });
});

describe("where the jetpack goes", () => {
  it("prefers the chest, then the spine, then the hips", () => {
    // A pack wants the highest rigid part of the torso. Falling back to hips
    // is a compromise and the right one — a pack that swings slightly wrong
    // with the waist beats one that ignores the body, which is what the fixed
    // mount did.
    expect(backSrc).toMatch(
      /sk\?\.torso\?\.obj \?\? sk\?\.spine\?\.obj \?\? sk\?\.hips\?\.obj \?\? null/,
    );
  });

  it("still mounts something on a rig with no spine at all", () => {
    // Flux and the rest of the code-built cast have no bones to bind.
    expect(backSrc).toContain("const FALLBACK =");
    expect(backSrc).toMatch(/group\.position\.set\(0, FALLBACK\.y, FALLBACK\.z\)/);
  });

  it("bounds how far back it can sit", () => {
    // The box's back face is the backmost VERTEX — a heel, a tail, a swept
    // hairdo — not the spine. Unbounded, a character with a tail tows its
    // jetpack; unpadded, most of the cast wears it inside the ribcage.
    expect(backSrc).toMatch(/clamp\(depth \* BACK_FRACTION, MIN_BACK, MAX_BACK\)/);
  });

  it("is parented to the mount, not to the model holder", () => {
    // The whole bug: `modelHolder.add(jetpack)` is not part of the rig, so the
    // swim's eighty-one-degree root pitch never reaches it.
    expect(citySrc).toContain("backMount.group.add(jetpack)");
    // Anchored to the start of a line: the comment above the new mount
    // quotes the old `modelHolder.add(jetpack)` to explain what it replaced,
    // and a bare substring match finds the explanation and fails.
    expect(citySrc).not.toMatch(/^\s*modelHolder\.add\(jetpack\);/m);
  });

  it("is re-homed whenever a character loads", () => {
    // The bone lives inside the GLB, which is replaced wholesale on a change
    // of character. A mount bound once points into a discarded skeleton.
    const attaches = [...citySrc.matchAll(/backMount\.attach\(/g)];
    expect(attaches.length).toBeGreaterThanOrEqual(3);
  });

  it("shares its correction with the hat mount", () => {
    // One copy of a subtle inverse-bind trick, not two that can drift.
    expect(headSrc).toContain('from "@/city/boneMount"');
    expect(backSrc).toContain('from "@/city/boneMount"');
  });
});

describe("sounds that stop when you leave", () => {
  it("takes a distance gain on every world-positioned water sound", () => {
    // There is no panner and no listener in this engine — everything mixes
    // into one master gain — so distance is the caller's job, and until now no
    // caller did it. A kart sinking three hundred metres away bubbled in your
    // ear at full volume for eleven seconds.
    expect(soundsSrc).toMatch(/splash\(strength: number, gain\?: number\)/);
    expect(soundsSrc).toMatch(/boom\(strength: number, gain\?: number\)/);
    expect(soundsSrc).toMatch(/bubble\(gain\?: number\)/);
  });

  it("skips the work entirely when something is out of earshot", () => {
    // Silent-but-still-scheduled oscillators are the expensive kind of quiet.
    const bodies = soundsSrc.match(/if \(g0 < 0\.01\) return;/g) ?? [];
    expect(bodies.length).toBe(3);
  });

  it("attenuates the sinking car's bubbles by where the player is", () => {
    expect(citySrc).toMatch(/soundsRef\.current\?\.bubble\?\.\(earshot\(k\.x, k\.z, \d+\)\)/);
  });

  it("lets an explosion carry further than a splash", () => {
    // `[^)]*` cannot cross the `)` inside `Math.min(...)`, which is the first
    // argument of every one of these calls.
    const boom = citySrc.match(/boom\?\.\([\s\S]*?earshot\(k\.x, k\.z, (\d+)\)\)/);
    const splash = citySrc.match(/splash\?\.\([\s\S]*?earshot\(k\.x, k\.z\)\)/);
    expect(boom).not.toBeNull();
    expect(splash).not.toBeNull();
    expect(Number(boom![1])).toBeGreaterThan(45);
  });

  it("does not think a mineshaft under the ocean is underwater", () => {
    // The Gremlin Mines are a pocket dimension deep below the open sea, so a
    // camera four hundred metres down one is "submerged by four hundred
    // metres" by depth arithmetic alone — and every sound down there would be
    // muffled as if drowning, with no way out because you never surface.
    //
    // Pinned as a property rather than as a line of source: the depth clause
    // has since grown a trench exemption (`|| trench.inside(...)`), which is
    // correct and unrelated, and an exact-text match failed on it. What has to
    // hold is that whatever the depth clause says, the underground flag still
    // vetoes the whole thing.
    const decl = citySrc.slice(citySrc.indexOf("const overSea ="), citySrc.indexOf("const camDepth ="));
    expect(decl).toContain("!undergroundActiveRef.current");
    expect(decl).toMatch(/camera\.position\.y > -40/);
  });
});
