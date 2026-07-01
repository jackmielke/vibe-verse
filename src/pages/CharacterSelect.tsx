import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import CityEntryScreen from "@/components/city/CityEntryScreen";
import { setActiveCharacter } from "@/hooks/use-active-character";
import { CHARACTERS } from "@/lib/characters";
import { generateCharacterName } from "@/lib/character-naming";

export default function CharacterSelect() {
  const navigate = useNavigate();

  const initialCharacter = useMemo(() => {
    const random = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
    return random?.id ?? "Pirate_Anne";
  }, []);

  const initialName = useMemo(() => {
    if (typeof window === "undefined") return generateCharacterName("Vibey");
    const savedName =
      localStorage.getItem("city.playerName") ??
      localStorage.getItem("city.displayName");
    const current = CHARACTERS.find((c) => c.id === initialCharacter);
    return savedName ?? generateCharacterName(current?.label);
  }, [initialCharacter]);

  const characters = useMemo(
    () =>
      CHARACTERS.map((c) => ({
        name: c.id,
        url: c.url,
        label: c.label,
        blurb: c.blurb,
        accent: c.accent,
      })),
    [],
  );

  function enterWorld(pick: { character: string; name: string }) {
    setActiveCharacter(pick.character);
    localStorage.setItem("city.playerName", pick.name);
    localStorage.setItem("city.displayName", pick.name);
    navigate("/city?spawn=island");
  }

  return (
    <CityEntryScreen
      characters={characters}
      initialCharacter={initialCharacter}
      initialName={initialName}
      eyebrow="Step 1 of 2 · Pick your character"
      title="Choose your character"
      subtitle="Your character follows you across the VibeVerse. Pick one now, then fall into Edge Island."
      ctaLabel="Enter Edge Island"
      onEnter={enterWorld}
    />
  );
}
