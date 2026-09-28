/**
 * Phones as wands, and a Vibey that remembers.
 *
 * The remote is a store with no world behind it; these hold that every
 * button really patches the state, that a phone never answers a newcomer
 * with the stale world it heard, and that a signed spell reaches the valley
 * with the caster's name. The memory half is pure over a record, so the
 * greetings and the "like last time" look are checked here too.
 */
import { describe, expect, it } from "vitest";
import { joinRoom, type CastNote } from "@/magician/net";
import { applyPatch, DEFAULT_STATE, type WorldState } from "@/magician/state";
import { castRemote, headlessStore, REMOTE_SPELLS, REMOTE_START } from "@/magician/remote";
import { runTool } from "@/magician/tools";
import { castSpell } from "@/magician/spellbook";
import { arrive, bond, emptyMemory, favourites, greeting, lookOf, memoryPrompt, milestone, recordSpell, spellLabel } from "@/magician/memory";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function remote() {
  let st: WorldState = REMOTE_START;
  const sent: unknown[] = [];
  const store = headlessStore(() => st, (s) => { st = s; }, (p) => sent.push(p));
  return { store, sent, state: () => st };
}

describe("the spell remote", () => {
  it("every button lands and sends a patch", () => {
    for (const spell of REMOTE_SPELLS) {
      const r = remote();
      const out = castRemote(spell, r.store, "Maya");
      expect(out.landed, spell.id).toBe(spell.calls.length);
      expect(r.sent.length, spell.id).toBeGreaterThan(0);
    }
  });
  it("changes the world it heard", () => {
    const r = remote();
    castRemote(REMOTE_SPELLS.find((s) => s.id === "snow")!, r.store, "Maya");
    expect(r.state().weather).toBe("snow");
    castRemote(REMOTE_SPELLS.find((s) => s.id === "lanterns")!, r.store, "Maya");
    expect(r.state().wishes[0].text).toBe("Maya's wish");
  });
  it("gives spawned props ids nobody else is using", () => {
    const r = remote();
    castRemote(REMOTE_SPELLS.find((s) => s.id === "foxes")!, r.store, "Maya");
    for (const p of r.state().props) expect(p.id).toBeGreaterThan(1e6);
  });
  it("typed wishes only reach the world's look, never a body or a game", () => {
    const r = remote();
    expect(castRemote("make it rain", r.store, "Bo").landed).toBe(1);
    expect(castRemote("start zombie tag", r.store, "Bo").landed).toBe(0);
    expect(castRemote("reset", r.store, "Bo").landed).toBe(0);
  });
  it("is credited in the valley and never answers a hello", async () => {
    if (typeof BroadcastChannel === "undefined") return;
    const roomName = "wand-" + Math.random().toString(36).slice(2);
    let valley: WorldState = applyPatch(DEFAULT_STATE, { weather: "fog" });
    const notes: CastNote[] = [];
    const v = await joinRoom({ mode: "local", room: roomName, name: "valley", id: "v", onPatch: (p) => { valley = applyPatch(valley, p); }, onFull: () => undefined, onPeers: () => undefined, currentState: () => valley, onCast: (n) => notes.push(n) });
    let heard: WorldState = REMOTE_START;
    const phone = await joinRoom({ mode: "local", room: roomName, name: "Maya", id: "m", onPatch: (p) => { heard = applyPatch(heard, p); }, onFull: (s) => { heard = s; }, onPeers: () => undefined, currentState: () => null });
    await tick();
    expect(heard.weather).toBe("fog"); // the phone learned the world from the valley
    // A second phone joins: only the valley may answer it.
    const fulls: WorldState[] = [];
    const phone2 = await joinRoom({ mode: "local", room: roomName, name: "Bo", id: "b", onPatch: () => undefined, onFull: (s) => fulls.push(s), onPeers: () => undefined, currentState: () => null });
    await tick();
    expect(fulls).toHaveLength(1);
    const store = headlessStore(() => heard, (s) => { heard = s; }, (p) => phone.patch(p));
    const out = castRemote(REMOTE_SPELLS.find((s) => s.id === "aurora")!, store, "Maya");
    phone.cast({ n: "Maya", did: out.did, emoji: out.emoji });
    await tick();
    expect(valley.aurora).toBe(1);
    expect(notes).toEqual([{ n: "Maya", did: "lit the northern lights", emoji: "🌌" }]);
    phone.close(); phone2.close(); v.close();
  });
});

describe("Vibey remembers", () => {
  it("greets a stranger, then an acquaintance, then an old friend", () => {
    const pick = () => 0;
    const now = 1_000_000_000_000;
    const first = greeting(emptyMemory(), "Jack", now, pick);
    expect(first).toContain("Jack");
    let m = arrive(emptyMemory(), "Jack", now - 3 * 86_400_000);
    m = recordSpell(recordSpell(recordSpell(m, "aurora"), "aurora"), "rain");
    expect(greeting(m, "Jack", now, pick)).toBe("Welcome back, Jack. Aurora again?");
    m = { ...m, visits: 12 };
    expect(greeting(m, "Jack", now, pick)).toBe("My old friend, Jack. Aurora again?");
    expect(greeting({ ...m, lastAt: now - 60_000 }, "Jack", now, pick)).toBe("Back already, Jack? Aurora again?");
    expect(greeting({ ...m, lastAt: now - 40 * 86_400_000 }, "Jack", now, pick)).toContain("I kept the valley for you");
  });
  it("counts visits into a bond", () => {
    expect(bond(1)).toBe("stranger");
    expect(bond(2)).toBe("acquaintance");
    expect(bond(5)).toBe("friend");
    expect(bond(10)).toBe("old friend");
  });
  it("names spells the way a friend would", () => {
    expect(spellLabel("set_weather", { weather: "snow" })).toBe("snow");
    expect(spellLabel("sky_show", { aurora: 1 })).toBe("aurora");
    expect(spellLabel("set_time", { hour: 18.8 })).toBe("sunset");
    expect(spellLabel("emote", { clip: "Wave" })).toBeNull();
    expect(favourites(recordSpell(recordSpell(recordSpell(emptyMemory(), "snow"), "rain"), "rain"))).toEqual(["rain", "snow"]);
  });
  it("tells the voice, and says nothing about a first visit it does not have", () => {
    expect(memoryPrompt(emptyMemory(), "Jack")).toContain("first visit");
    const m = recordSpell(arrive(emptyMemory(), "Jack", 0), "aurora");
    const p = memoryPrompt({ ...m, look: { weather: "snow" } }, "Jack", 86_400_000 * 2);
    expect(p).toContain("aurora");
    expect(p).toContain("like_last_time");
  });
  it("puts the valley back like last time", () => {
    const left = applyPatch(DEFAULT_STATE, { weather: "snow", season: "winter", timeOfDay: 22, aurora: 1 });
    const look = lookOf(left);
    let st: WorldState = applyPatch(DEFAULT_STATE, {});
    const store = { ...headlessStore(() => st, (s) => { st = s; }, () => undefined), lastLook: () => look };
    expect(castSpell("like last time")).toEqual([{ name: "like_last_time", args: {} }]);
    expect(runTool("like_last_time", {}, store).toast).toBeTruthy();
    expect(st.weather).toBe("snow");
    expect(st.aurora).toBe(1);
    const fresh = { ...store, lastLook: () => null };
    expect(runTool("like_last_time", {}, fresh).toast).toBeNull();
  });
  it("has a small arc inside one visit", () => {
    expect(milestone(3, "Jack")).toContain("Jack");
    expect(milestone(4, "Jack")).toBeNull();
  });
});

describe("a late hello", () => {
  it("does not undo what happened while it was on its way", async () => {
    if (typeof BroadcastChannel === "undefined") return;
    const roomName = "late-" + Math.random().toString(36).slice(2);
    // A slow valley: it reads its state when the hello arrives, answers much later.
    const slowState = applyPatch(DEFAULT_STATE, { timeOfDay: 16.5 });
    const ch = new BroadcastChannel(`magician-${roomName}`);
    ch.onmessage = (e) => { const m = e.data; if (m.t === "hi") setTimeout(() => ch.postMessage({ t: "full", id: "slow", to: m.id, state: slowState }), 80); };
    let heard: WorldState = REMOTE_START;
    const phone = await joinRoom({ mode: "local", room: roomName, name: "Maya", id: "m", onPatch: (p) => { heard = applyPatch(heard, p); }, onFull: (s) => { heard = s; }, onPeers: () => undefined, currentState: () => null });
    const store = headlessStore(() => heard, (s) => { heard = s; }, (p) => phone.patch(p));
    castRemote(REMOTE_SPELLS.find((s) => s.id === "night")!, store, "Maya");
    expect(heard.timeOfDay).toBe(22.5);
    await tick(200);
    expect(heard.timeOfDay).toBe(22.5);
    phone.close(); ch.close();
  });
});
