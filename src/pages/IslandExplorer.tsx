/**
 * IslandExplorer — multi-world R3F sandbox imported from the standalone
 * "Island Explorer" Lovable project. Pick a character + world, then
 * walk/run/jump with WASD. Used as a wow-factor world in the Vibe Verse hub.
 *
 * Self-contained: all dependencies live under src/island/* and src/assets/island-explorer/*.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Character, type CharacterHandle } from "@/island/Character";
import { useInput } from "@/island/useInput";
import { generateShells, ShellMesh, type Shell } from "@/island/Shells";
import { CHARACTERS, type CharacterOption } from "@/island/characters";
import { CharacterPreview } from "@/island/CharacterPreview";
import type { World } from "@/island/world";
import { ISLAND_WORLD } from "@/island/worldIsland";
import { ESMERALDA_WORLD } from "@/island/worldEsmeralda";
import { ESMERALDA_PHOTOREAL_WORLD } from "@/island/worldEsmeraldaPhotoreal";
import { SKY_ISLAND_WORLD } from "@/island/worldSkyIsland";
import { WorldMiniScene } from "@/island/WorldMiniScene";
import islandPoster from "@/assets/island-explorer/world-island.jpg";
import esmeraldaPoster from "@/assets/island-explorer/world-esmeralda.jpg";
import skyIslandPoster from "@/assets/island-explorer/world-skyisland.jpg";
import loginBg from "@/assets/island-explorer/new-login-bg.jpg";
import floatingIslandBg from "@/assets/island-explorer/new-floating-island-bg.jpg";

if (typeof window !== "undefined") {
  [loginBg, floatingIslandBg].forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}

type WorldCard = {
  world: World;
  poster: string;
  badge?: string;
  altWorld?: World;
  altBadge?: string;
};

const WORLD_CARDS: WorldCard[] = [
  { world: SKY_ISLAND_WORLD, poster: skyIslandPoster, badge: "New · Floating" },
  { world: ISLAND_WORLD, poster: islandPoster, badge: "Sunset" },
  {
    world: ESMERALDA_PHOTOREAL_WORLD,
    poster: esmeraldaPoster,
    badge: "Photoreal · Heavy",
    altWorld: ESMERALDA_WORLD,
    altBadge: "Stylized · Light",
  },
];

function IntroDriver({
  inputRef,
  active,
  onDone,
}: {
  inputRef: ReturnType<typeof useInput>;
  active: boolean;
  onDone: () => void;
}) {
  const elapsed = useRef(0);
  const DURATION = 2.8;

  useEffect(() => {
    if (active) {
      elapsed.current = 0;
      inputRef.current.cameraYaw = Math.PI;
      inputRef.current.cameraPitch = 0.18;
    }
  }, [active, inputRef]);

  useFrame((_, dt) => {
    if (!active) return;
    elapsed.current += dt;
    const t = Math.min(1, elapsed.current / DURATION);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    inputRef.current.cameraYaw = Math.PI * (1 - eased);
    inputRef.current.cameraPitch = 0.18 + (0.35 - 0.18) * eased;
    if (t >= 1) onDone();
  });

  return null;
}

function Scene({
  character,
  world,
  shells,
  setShells,
  onCharUpdate,
  introActive,
  onIntroDone,
}: {
  character: CharacterOption;
  world: World;
  shells: Shell[];
  setShells: React.Dispatch<React.SetStateAction<Shell[]>>;
  onCharUpdate: (h: CharacterHandle) => void;
  introActive: boolean;
  onIntroDone: () => void;
}) {
  const inputRef = useInput();
  const SceneContents = world.Scene;

  return (
    <>
      <SceneContents />

      {shells.map((s) => (
        <ShellMesh key={s.id} shell={s} />
      ))}

      <IntroDriver inputRef={inputRef} active={introActive} onDone={onIntroDone} />

      <Suspense fallback={null}>
        <Character
          character={character}
          world={world}
          inputRef={inputRef}
          controlsEnabled={!introActive}
          onUpdate={onCharUpdate}
          shells={shells}
          onCollectShell={(id) =>
            setShells((prev) => prev.map((s) => (s.id === id ? { ...s, collected: true } : s)))
          }
        />
      </Suspense>
    </>
  );
}

function CharacterSelector({ onPick }: { onPick: (c: CharacterOption) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center overflow-y-auto py-10"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12)), url(${loginBg})`,
        backgroundColor: "#bfd9ea",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="mb-2 text-xs uppercase tracking-[0.3em] text-white/80">
        Step 1 of 2 · Pick your character
      </div>
      <h1 className="mb-2 text-5xl font-light tracking-tight text-white drop-shadow-lg">
        Choose your character
      </h1>
      <p className="mb-8 max-w-md text-center text-sm text-white/75">
        Hover a card to see them spin. You'll pick a world next.
      </p>
      <div className="grid max-h-[70vh] grid-cols-1 gap-4 overflow-y-auto px-4 pb-2 sm:grid-cols-2 lg:grid-cols-3">
        {CHARACTERS.map((c) => (
          <button
            key={c.id}
            onMouseEnter={() => setHovered(c.id)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onPick(c)}
            className={`group flex w-72 flex-col items-start rounded-2xl border border-white/20 bg-white/10 p-4 text-left backdrop-blur-sm transition-all hover:border-white/70 hover:bg-white/20 hover:shadow-2xl ${
              hovered === c.id ? "scale-[1.03]" : ""
            }`}
          >
            <div
              className={`relative mb-3 h-48 w-full overflow-hidden rounded-xl bg-gradient-to-br ${c.accent} ring-1 ring-white/20`}
            >
              <CharacterPreview character={c} spinning={hovered === c.id} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/40 to-transparent" />
            </div>
            <div className="text-xl font-medium text-white">{c.name}</div>
            <div className="mt-1 text-sm text-white/75">{c.description}</div>
            <div className="mt-3 text-xs uppercase tracking-wider text-white/60 group-hover:text-white">
              Play as {c.name} →
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorldCardView({
  card,
  onPick,
}: {
  card: WorldCard;
  onPick: (w: World) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [usePhotoreal, setUsePhotoreal] = useState(true);
  const activeWorld = usePhotoreal ? card.world : (card.altWorld ?? card.world);
  const activeBadge = usePhotoreal ? card.badge : card.altBadge;
  const hasToggle = !!card.altWorld;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group relative flex w-[22rem] flex-col overflow-hidden rounded-3xl border border-white/15 bg-black/40 text-left backdrop-blur-sm transition-all ${
        hovered ? "scale-[1.02] border-white/60 shadow-2xl" : ""
      }`}
    >
      <button
        onClick={() => onPick(activeWorld)}
        className="relative h-56 w-full overflow-hidden"
      >
        <img
          src={card.poster}
          alt={`${card.world.name} poster`}
          loading="lazy"
          width={1280}
          height={768}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            hovered ? "opacity-0" : "opacity-100"
          }`}
        />
        <div
          className={`absolute inset-0 transition-opacity duration-500 ${
            hovered ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          {hovered && <WorldMiniScene world={activeWorld} />}
        </div>
        {activeBadge && (
          <div className="absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white backdrop-blur">
            {activeBadge}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute bottom-3 left-4 text-3xl font-light text-white drop-shadow">
          {activeWorld.name}
        </div>
      </button>

      <div className="p-4">
        <div className="text-sm text-white/90">{activeWorld.tagline}</div>
        <div className="mt-1 text-xs text-white/60">{activeWorld.description}</div>

        {hasToggle && (
          <div className="mt-3 flex gap-1 rounded-full bg-white/10 p-1 text-[11px]">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setUsePhotoreal(true);
              }}
              className={`flex-1 rounded-full px-2 py-1 transition ${
                usePhotoreal ? "bg-white text-black" : "text-white/70 hover:text-white"
              }`}
            >
              Photoreal
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setUsePhotoreal(false);
              }}
              className={`flex-1 rounded-full px-2 py-1 transition ${
                !usePhotoreal ? "bg-white text-black" : "text-white/70 hover:text-white"
              }`}
            >
              Stylized
            </button>
          </div>
        )}

        <button
          onClick={() => onPick(activeWorld)}
          className="mt-3 w-full rounded-lg bg-white/15 px-3 py-2 text-xs font-medium uppercase tracking-wider text-white transition hover:bg-white/25"
        >
          Enter {activeWorld.name} →
        </button>
      </div>
    </div>
  );
}

function WorldSelector({
  character,
  onBack,
  onPick,
}: {
  character: CharacterOption;
  onBack: () => void;
  onPick: (w: World) => void;
}) {
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center overflow-y-auto py-10"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.15)), url(${floatingIslandBg})`,
        backgroundColor: "#bfd9ea",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <button
        onClick={onBack}
        className="absolute left-4 top-4 rounded-lg bg-white/10 px-3 py-1.5 text-xs uppercase tracking-wider text-white backdrop-blur-md transition hover:bg-white/20"
      >
        ← Change character
      </button>
      <div className="mb-2 text-xs uppercase tracking-[0.3em] text-white/70">
        Step 2 of 2 · Playing as {character.name}
      </div>
      <h1 className="mb-2 text-5xl font-light tracking-tight text-white drop-shadow-lg">
        Choose your world
      </h1>
      <p className="mb-10 max-w-md text-center text-sm text-white/70">
        Hover a card to see a live 3D flythrough of the actual world.
      </p>
      <div className="grid grid-cols-1 gap-6 px-4 sm:grid-cols-2">
        {WORLD_CARDS.map((c) => (
          <WorldCardView key={c.world.id + (c.badge ?? "")} card={c} onPick={onPick} />
        ))}
      </div>
      <div className="mt-8 max-w-md text-center text-xs text-white/40">
        💡 Photoreal Edge Esmeralda is GPU-heavy — pick "Stylized" if it stutters.
      </div>
    </div>
  );
}

export default function IslandExplorer() {
  const [character, setCharacter] = useState<CharacterOption | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [introActive, setIntroActive] = useState(false);
  const [shells, setShells] = useState<Shell[]>([]);
  const [hudVisible, setHudVisible] = useState(false);
  const charRef = useRef<CharacterHandle | null>(null);

  useEffect(() => {
    if (world?.hasShells) setShells(generateShells());
    else setShells([]);
  }, [world]);

  useEffect(() => {
    if (!introActive && character && world) {
      setHudVisible(true);
      const t = setTimeout(() => setHudVisible(false), 8000);
      return () => clearTimeout(t);
    }
  }, [introActive, character, world]);

  const collected = shells.filter((s) => s.collected).length;
  const inGame = !!(character && world);

  const canvasKey = world?.id ?? "none";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b0b14]">
      {inGame && (
        <Canvas
          key={canvasKey}
          shadows
          camera={{ position: [0, 4, 2], fov: 55, near: 0.1, far: 1000 }}
          dpr={[1, 1.5]}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.95,
          }}
        >
          <Scene
            character={character!}
            world={world!}
            shells={shells}
            setShells={setShells}
            onCharUpdate={(h) => (charRef.current = h)}
            introActive={introActive}
            onIntroDone={() => setIntroActive(false)}
          />
        </Canvas>
      )}

      {!character && (
        <CharacterSelector onPick={(c) => setCharacter(c)} />
      )}

      {character && !world && (
        <WorldSelector
          character={character}
          onBack={() => setCharacter(null)}
          onPick={(w) => {
            setWorld(w);
            setIntroActive(true);
          }}
        />
      )}

      {inGame && introActive && (
        <div className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-6 py-2 text-sm uppercase tracking-[0.3em] text-white backdrop-blur-md">
          Entering {world!.name}…
        </div>
      )}

      {inGame && !introActive && (
        <>
          <div className="pointer-events-none absolute right-4 top-4 rounded-lg bg-black/40 px-4 py-2 text-white backdrop-blur-md">
            <div className="text-xs uppercase tracking-wider opacity-70">
              {world!.name}
            </div>
            {world!.hasShells ? (
              <div className="text-2xl font-semibold">
                {collected} <span className="text-sm opacity-60">/ {shells.length} shells</span>
              </div>
            ) : (
              <div className="text-sm opacity-80">Playing as {character!.name}</div>
            )}
          </div>

          <div className="absolute left-4 top-4 flex gap-2">
            <button
              onClick={() => {
                setWorld(null);
                setIntroActive(false);
              }}
              className="rounded-lg bg-black/40 px-3 py-1.5 text-xs uppercase tracking-wider text-white backdrop-blur-md transition hover:bg-black/60"
            >
              ← Change world
            </button>
            <button
              onClick={() => {
                setCharacter(null);
                setWorld(null);
                setIntroActive(false);
              }}
              className="rounded-lg bg-black/40 px-3 py-1.5 text-xs uppercase tracking-wider text-white backdrop-blur-md transition hover:bg-black/60"
            >
              Change character
            </button>
          </div>

          <div
            className={`pointer-events-none absolute bottom-4 left-4 max-w-xs rounded-lg bg-black/40 px-4 py-3 text-sm text-white backdrop-blur-md transition-opacity duration-1000 ${
              hudVisible ? "opacity-100" : "opacity-0 hover:opacity-100"
            }`}
          >
            <div className="mb-1 font-semibold">Welcome to {world!.name}</div>
            <ul className="space-y-0.5 text-xs opacity-90">
              <li>WASD / Arrows — Walk</li>
              <li>Shift — Run</li>
              <li>Space — Jump</li>
              <li>Drag mouse — Look around</li>
              <li>Scroll / +/− / Pinch — Zoom out for the whole map</li>
              {world!.hasShells && <li>Find the shells on the beach</li>}
              {!world!.hasShells && <li>Explore the village districts</li>}
            </ul>
          </div>

          {world!.hasShells && collected === shells.length && shells.length > 0 && (
            <div className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 rounded-full bg-amber-500/90 px-6 py-2 text-white shadow-lg">
              You found every shell — nice exploring!
            </div>
          )}
        </>
      )}
    </div>
  );
}
