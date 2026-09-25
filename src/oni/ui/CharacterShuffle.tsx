/**
 * Who you'll be, picked like a slot machine.
 *
 * On arrival the portraits spin and land on somebody new; the dice spins
 * again, and the arrows walk back and forward through everybody you have
 * landed on, so a character you passed is never lost. Your pick is saved on
 * this device and shared with /oni.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CHARACTERS, findCharacter } from "@/lib/characters";
import { characterArt } from "@/lib/characterArt";
import { characterFace } from "@/lib/characterFaces";
import { randomCharacter, readCharacter, writeCharacter } from "../profile";

const artFor = (id: string) => characterArt(id) ?? characterFace(id);

function preload(ids: string[]) {
  for (const id of ids) { const a = artFor(id); if (a) { const img = new Image(); img.src = a; } }
}

export function CharacterShuffle({ onChange, size = 180, spinOnMount = true }: { onChange?(id: string): void; size?: number; spinOnMount?: boolean }) {
  const [history, setHistory] = useState<string[]>(() => [readCharacter()]);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(history[0]);
  const [spinning, setSpinning] = useState(false);
  const timer = useRef<number | null>(null);
  const historyRef = useRef(history);
  const indexRef = useRef(0);

  const land = useCallback((id: string) => {
    setShown(id);
    writeCharacter(id);
    onChange?.(id);
  }, [onChange]);

  const spin = useCallback((from: string) => {
    if (timer.current !== null) return;
    const target = randomCharacter(from);
    // Fourteen quick faces, slowing down, then the one you get.
    const reel = Array.from({ length: 14 }, () => CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id);
    preload([...reel, target]);
    setSpinning(true);
    let k = 0;
    const step = () => {
      if (k < reel.length) {
        setShown(reel[k]);
        const delay = 45 + k * k * 1.6;
        k++;
        timer.current = window.setTimeout(step, delay);
        return;
      }
      timer.current = null;
      setSpinning(false);
      const next = [...historyRef.current.slice(0, indexRef.current + 1), target];
      historyRef.current = next;
      indexRef.current = next.length - 1;
      setHistory(next);
      setIndex(next.length - 1);
      land(target);
    };
    step();
  }, [land]);


  useEffect(() => {
    onChange?.(history[0]);
    if (spinOnMount) spin(history[0]);
    return () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (dir: -1 | 1) => {
    if (spinning) return;
    const i = index + dir;
    if (i < 0) return;
    if (i >= history.length) { spin(history[index]); return; }
    setIndex(i);
    indexRef.current = i;
    land(history[i]);
  };

  const spec = findCharacter(shown);
  const art = artFor(shown);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-3">
        <button type="button" aria-label="Previous character" disabled={index === 0 || spinning} onClick={() => go(-1)}
          className="h-11 w-11 rounded-full border border-white/25 bg-black/35 text-xl text-white/85 backdrop-blur transition enabled:hover:bg-white/10 disabled:opacity-30">‹</button>
        <div
          className={`relative flex items-center justify-center overflow-hidden rounded-3xl border border-white/20 bg-gradient-to-b from-white/15 to-white/[0.03] shadow-2xl backdrop-blur ${spinning ? "" : "animate-in zoom-in-95 duration-300"}`}
          style={{ width: size, height: size }}
        >
          {art ? <img key={shown} src={art} alt={spec.label} className={`h-full w-full object-contain ${spinning ? "blur-[1px]" : ""}`} draggable={false} /> : <span style={{ fontSize: size * 0.45 }}>{spec.emoji}</span>}
        </div>
        <button type="button" aria-label="Next character" disabled={spinning} onClick={() => go(1)}
          className="h-11 w-11 rounded-full border border-white/25 bg-black/35 text-xl text-white/85 backdrop-blur transition enabled:hover:bg-white/10 disabled:opacity-30">›</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-white">{spinning ? "…" : `${spec.emoji} ${spec.label}`}</span>
        <button type="button" disabled={spinning} onClick={() => spin(history[index])}
          className="rounded-full border border-white/25 bg-black/35 px-3 py-1 text-xs text-white/85 backdrop-blur transition enabled:hover:bg-white/10 disabled:opacity-40">🎲 shuffle</button>
      </div>
    </div>
  );
}
