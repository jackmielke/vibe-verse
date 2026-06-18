/**
 * useActiveCharacter — single source of truth for "which 3D character
 * am I playing as". Worlds (City, Lobby, HubV2, Profile, the LogIn
 * dropdown emoji in the top-right) all read/write through this hook so
 * picking a character anywhere updates everywhere.
 *
 * Storage:
 *   localStorage.lobby.character — canonical id
 *   localStorage.city.character  — mirrored for legacy City reader
 *
 * Updates fan out via a window CustomEvent so other components in the
 * same tab re-render immediately (the native `storage` event only fires
 * across tabs).
 */
import { useEffect, useState, useCallback } from "react";
import { CHARACTERS, findCharacter, type CharSpec } from "@/lib/characters";

const LS_KEY = "lobby.character";
const LS_KEY_CITY = "city.character";
const EVT = "vibe:character-changed";

function readId(): string {
  if (typeof window === "undefined") return "vibey";
  return (
    localStorage.getItem(LS_KEY) ??
    localStorage.getItem(LS_KEY_CITY) ??
    "vibey"
  );
}

/** Imperative setter usable from non-hook code (e.g. inside a Three.js
 *  scene callback that already has its own state). */
export function setActiveCharacter(nextId: string) {
  try {
    localStorage.setItem(LS_KEY, nextId);
    localStorage.setItem(LS_KEY_CITY, nextId);
  } catch {
    /* ignore quota / private mode */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVT, { detail: nextId }));
  }
}

export function useActiveCharacter(): {
  charId: string;
  character: CharSpec;
  setCharId: (id: string) => void;
  all: CharSpec[];
} {
  const [charId, setCharIdState] = useState<string>(readId);

  useEffect(() => {
    const onChange = (e: Event) => {
      const next =
        (e as CustomEvent<string>).detail ??
        localStorage.getItem(LS_KEY) ??
        "vibey";
      setCharIdState(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY || e.key === LS_KEY_CITY) {
        setCharIdState(readId());
      }
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setCharId = useCallback((id: string) => {
    setCharIdState(id);
    setActiveCharacter(id);
  }, []);

  return {
    charId,
    character: findCharacter(charId),
    setCharId,
    all: CHARACTERS,
  };
}
