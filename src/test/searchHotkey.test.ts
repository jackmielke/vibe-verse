/**
 * The "/" shortcut, tested where it can actually be wrong.
 *
 * Opening the search is the boring half. Every interesting case is a *refusal*,
 * and refusals fail silently: a global handler that swallows "/" does not throw
 * and does not fail a build, it just quietly eats a character out of somebody's
 * chat message in a world three directories away. So each guard is asserted.
 */
import { describe, expect, it } from "vitest";

import { isTypingTarget, shouldOpenSearch } from "@/lib/searchHotkey";

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({ key: "/", metaKey: false, ctrlKey: false, altKey: false, ...over }) as KeyboardEvent;

const idle = { pointerLocked: false, active: null };
const focus = (tagName: string, isContentEditable = false) => ({
  pointerLocked: false,
  active: { tagName, isContentEditable },
});

describe("shouldOpenSearch", () => {
  it("opens on a bare slash with nothing focused", () => {
    expect(shouldOpenSearch(key(), idle)).toBe(true);
    /* Focus on a plain element is still idle — a card, a link, the body. */
    expect(shouldOpenSearch(key(), focus("BODY"))).toBe(true);
    expect(shouldOpenSearch(key(), focus("BUTTON"))).toBe(true);
  });

  it("ignores every other key", () => {
    for (const k of ["a", "?", "Escape", "Enter", "/ "]) {
      expect(shouldOpenSearch(key({ key: k }), idle)).toBe(false);
    }
  });

  it("leaves modified slashes to the browser and the editor", () => {
    expect(shouldOpenSearch(key({ metaKey: true }), idle)).toBe(false);
    expect(shouldOpenSearch(key({ ctrlKey: true }), idle)).toBe(false);
    expect(shouldOpenSearch(key({ altKey: true }), idle)).toBe(false);
  });

  it("does not drop an overlay on somebody who is playing", () => {
    /* Pointer lock is this repo's engine-agnostic "is playing" signal. A
       full-screen picker landing mid-flight is worse than no shortcut. */
    expect(shouldOpenSearch(key(), { pointerLocked: true, active: null })).toBe(false);
  });

  it("lets a focused field keep its own keystroke", () => {
    expect(shouldOpenSearch(key(), focus("INPUT"))).toBe(false);
    expect(shouldOpenSearch(key(), focus("TEXTAREA"))).toBe(false);
    expect(shouldOpenSearch(key(), focus("SELECT"))).toBe(false);
    /* The one that is easy to forget, and the one a chat box actually uses. */
    expect(shouldOpenSearch(key(), focus("DIV", true))).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing focused", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it("does not match a tag that merely starts with one of the names", () => {
    /* Anchored on both ends — an <input-like> custom element is not an input. */
    expect(isTypingTarget({ tagName: "INPUT-GROUP", isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: "MY-TEXTAREA", isContentEditable: false })).toBe(false);
  });
});
