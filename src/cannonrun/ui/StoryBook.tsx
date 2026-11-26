/**
 * Read the story instead of playing it. Jack, Nov 2026: "make it so that you
 * can actually click and read the storyline of what happened, for just one
 * player or two players." Every picture is a real frame from the game
 * (comic panels and chase shots, captured by script), so the book and the
 * road look the same. The chase never ends, so neither does the book: the
 * last page is the next night starting again.
 */
import { useCallback, useEffect, useState } from "react";

const IMG = import.meta.glob("../../assets/cannonrun/story/*.jpg", { eager: true, import: "default" }) as Record<string, string>;
const pic = (name: string): string => IMG[`../../assets/cannonrun/story/${name}.jpg`] ?? "";

interface Page { img: string; title: string; text: string }

const OPENING: Page[] = [
  { img: "comic-0", title: "Grandpa's cannon", text: "Mort Gatch had one thing in the whole world he loved, and it was the cannon his grandpa left him. Every night he fell asleep in his big red chair right next to it." },
  { img: "comic-1", title: "Gone in the night", text: "Then one night somebody backed a pickup into his garage, rolled the cannon into the bed and drove off down Route 66. Mort woke up just in time to wave at the taillights." },
  { img: "comic-2", title: "Mad Mort", text: "\"THAT'S MY GRANDPA'S CANNON!\" Mort was so mad his mustache shook. He grabbed his keys, his hat and his old covered wagon." },
];

const SOLO: Page[] = [
  ...OPENING,
  { img: "comic-5", title: "Mort hits the road", text: "Mort didn't call anybody. He just drove. Out on the dark highway, one pair of headlights started getting bigger in your mirror." },
  { img: "wagon", title: "The chase is on", text: "That's you in the pickup, with the cannon in the back. Every time Mort's wagon gets close, you swing the cannon round and BOOM, he's off the road." },
  { img: "monster", title: "Mort is back", text: "But Mort never gives up. Wreck his wagon and he comes back in a tow truck. Wreck that and he's in a monster pickup with tires taller than you." },
  { img: "henchmen", title: "Mort's friends", text: "Then he called in some friends in bandolier hats. Now there are more trucks behind you, and all of them want that cannon." },
  { img: "rig", title: "An 18-wheeler", text: "After the monster truck it's a cement truck (of course it's a cement truck), and after that a giant 18-wheeler that takes a lot of cannonballs to stop." },
  { img: "news", title: "On the news", text: "By now Gatch News is following the whole thing live from a helicopter. \"STOLEN PIRATE CANNON ON ROUTE 66,\" says the bulletin, and the radio in your truck can't stop talking about it." },
  { img: "train", title: "He's driving a train", text: "And when all of that is in pieces, Mort turns up driving a whole train. Nobody knows where he got it." },
];

const DUO: Page[] = [
  ...OPENING,
  { img: "comic-3", title: "Calling Linda", text: "This time Mort picked up the phone and called his cousin, Lunatic Linda. \"Somebody took Grandpa's cannon.\" Linda was already putting her boots on." },
  { img: "comic-4", title: "Two wagons", text: "So there were two of them. Two wagons, two angry Gatches, side by side on Route 66, and two of you up ahead sharing one road." },
  { img: "wagon", title: "The chase is on", text: "You each have a pickup and a cannon. Work together: one of you blasts Mort while the other one keeps Linda off your bumper." },
  { img: "duo-linda", title: "Linda in a tow truck", text: "Wreck Linda's wagon and she's straight back in a tow truck, yelling \"I'll be back, sugar!\" Every time one of them goes down, the other one is still coming." },
  { img: "henchmen", title: "The whole family", text: "Then the friends in the bandolier hats join in, and the road behind you is nothing but headlights." },
  { img: "news", title: "On the news", text: "Gatch News puts it on every TV in the state. Two pickups, two cannons, and a family that will not stop." },
  { img: "duo-trains", title: "Two trains", text: "Mort turns up driving a train. Then Linda does too. She is also driving a train." },
];

const ENDING: Page = {
  img: "comic-5",
  title: "And it never ends",
  text: "That's the thing about the Gatches. You can wreck every wagon, truck and train they have, and the next night there they are again in your mirror. There is no winning this one. There is only how long you can keep that cannon.",
};

export function StoryBook({ onDone, onPlay, phone, two: twoAtFirst = false }: { onDone: () => void; onPlay: (two: boolean) => void; phone: boolean; two?: boolean }) {
  const [two, setTwo] = useState(twoAtFirst);
  const [i, setI] = useState(0);
  const pages = [...(two ? DUO : SOLO), ENDING];
  const p = pages[Math.min(i, pages.length - 1)];
  const last = i >= pages.length - 1;
  const next = useCallback(() => setI((n) => Math.min(n + 1, pages.length - 1)), [pages.length]);
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), []);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [next, back, onDone]);

  // every page is a small jpeg: load them all up front so turning a page is instant
  useEffect(() => { for (const src of Object.values(IMG)) { const im = new Image(); im.src = src; } }, []);

  const pick = (t: boolean): void => { setTwo(t); setI(0); };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto px-3 pb-4 pt-16" style={{ background: "radial-gradient(ellipse at 50% 70%, #3a2a1c 0%, #0b0f1c 65%)" }}>
      <div className={`w-full ${phone ? "max-w-[440px]" : "max-w-3xl"}`}>
        <div className="mb-3 flex items-center gap-2">
          <div className="text-[12px] font-black tracking-[0.2em] text-[#ffd36a]">THE STORY</div>
          <div className="ml-auto flex rounded-full bg-white/10 p-0.5 text-[12px] font-semibold">
            <button className={`whitespace-nowrap rounded-full px-3 py-1 ${!two ? "bg-[#ffd36a] text-black" : "text-white/70"}`} onClick={() => pick(false)}>1 player</button>
            <button className={`whitespace-nowrap rounded-full px-3 py-1 ${two ? "bg-[#ffd36a] text-black" : "text-white/70"}`} onClick={() => pick(true)}>2 players</button>
          </div>
          <button className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold" onClick={onDone}>Close</button>
        </div>
        <div className="overflow-hidden rounded-2xl bg-[#f6ecd6] text-[#1a140c] shadow-2xl ring-4 ring-[#0b0b10]">
          <button className="block w-full" onClick={next} aria-label="Next page">
            <img src={pic(p.img)} alt={p.title} className="block aspect-video w-full object-cover" />
          </button>
          <div className="px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[20px] font-black leading-tight sm:text-[24px]">{p.title}</h2>
              <span className="ml-auto shrink-0 text-[11px] font-bold text-black/40">{i + 1} / {pages.length}</span>
            </div>
            <p className="mt-1.5 text-[15px] leading-snug sm:text-[17px]">{p.text}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold disabled:opacity-30" disabled={i === 0} onClick={back}>◀ Back</button>
          {last ? (
            <button className="ml-auto rounded-full bg-[#ffd36a] px-6 py-2 text-[14px] font-black text-black" onClick={() => onPlay(two)}>{two ? "Play it with a friend" : "Play it"} ▶</button>
          ) : (
            <button className="ml-auto rounded-full bg-[#ffd36a] px-6 py-2 text-[14px] font-black text-black" onClick={next}>Next ▶</button>
          )}
        </div>
      </div>
    </div>
  );
}
