/**
 * Name, character, go. The whole lobby is this card: type a name, get a
 * random character from the roster, shuffle or step through until you like
 * who you are, and join. Used on the front page and on /oni itself.
 */
import { useState } from "react";
import { findCharacter } from "@/lib/characters";
import { characterArt } from "@/lib/characterArt";
import { characterFace } from "@/lib/characterFaces";
import { randomCharacter, readCharacter, readName, stepCharacter, writeCharacter, writeName } from "../profile";

export function CharacterPortrait({ id, size = 112 }: { id: string; size?: number }) {
  const spec = findCharacter(id);
  const art = characterArt(id) ?? characterFace(id);
  return (
    <div className="flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-b from-white/10 to-white/[0.02]" style={{ width: size, height: size }}>
      {art ? <img src={art} alt={spec.label} className="h-full w-full object-contain" draggable={false} /> : <span style={{ fontSize: size * 0.5 }}>{spec.emoji}</span>}
    </div>
  );
}

export function JoinCard({ onJoin, cta = "Join the square", size = 112, autoFocus = false }: { onJoin(name: string, char: string): void; cta?: string; size?: number; autoFocus?: boolean }) {
  const [name, setName] = useState(readName);
  const [char, setChar] = useState(readCharacter);
  const pick = (id: string) => { setChar(id); writeCharacter(id); };
  const go = () => {
    const n = name.trim() || "player";
    writeName(n);
    writeCharacter(char);
    onJoin(n, char);
  };
  const spec = findCharacter(char);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous character" onClick={() => pick(stepCharacter(char, -1))} className="h-10 w-10 rounded-full border border-white/20 bg-black/30 text-lg text-white/80 transition hover:bg-white/10">‹</button>
        <CharacterPortrait id={char} size={size} />
        <button type="button" aria-label="Next character" onClick={() => pick(stepCharacter(char, 1))} className="h-10 w-10 rounded-full border border-white/20 bg-black/30 text-lg text-white/80 transition hover:bg-white/10">›</button>
      </div>
      <div className="flex items-center gap-2 text-sm text-white/85">
        <span>{spec.emoji} {spec.label}</span>
        <button type="button" onClick={() => pick(randomCharacter(char))} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-white/75 transition hover:bg-white/10">🎲 shuffle</button>
      </div>
      <form className="flex w-full max-w-xs gap-2" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder="Your name"
          autoFocus={autoFocus}
          maxLength={16}
          enterKeyHint="go"
          className="min-w-0 flex-1 rounded-full border border-white/20 bg-black/40 px-4 py-2.5 text-[16px] text-white outline-none placeholder:text-white/35 focus:border-[#ff6a4a]"
        />
        <button type="submit" className="shrink-0 rounded-full bg-[#e8402c] px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[#e8402c]/30 transition hover:bg-[#ff5238]">
          {cta}
        </button>
      </form>
    </div>
  );
}
