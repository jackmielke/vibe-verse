/**
 * Evolve — the Genesis Bloom evolution simulator, folded into the
 * Vibe Explorer multiverse from the genesis-bloom-evolve repo.
 *
 * Play as a plant or an animal on a procedural low-poly island:
 * gather food, dodge predators, and pick mutations to survive across
 * biomes. The whole game lives in src/game/ (r3f + zustand) and is
 * fully procedural — no assets to download.
 *
 * /bestiary lists every creature and lets you start a run as any of
 * them.
 */
import { Scene } from "@/game/Scene";
import { HUD } from "@/game/HUD";
import { StartScreen, EvolveModal, GameOver } from "@/game/Screens";
import { TouchControls } from "@/game/TouchControls";
import { useGame } from "@/game/store";

export default function Evolve() {
  const mode = useGame((s) => s.mode);
  return (
    <main className="relative h-[100dvh] w-screen overflow-hidden bg-black">
      <Scene />
      {mode === "playing" && <HUD />}
      {mode === "playing" && <TouchControls />}
      {mode === "menu" && <StartScreen />}
      {mode === "evolve" && <EvolveModal />}
      {mode === "gameover" && <GameOver />}
    </main>
  );
}
