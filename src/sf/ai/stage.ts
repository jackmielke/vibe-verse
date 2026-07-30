/**
 * ai/stage.ts — the render batches, owned in one place.
 *
 * `<Pedestrians />` and `<Traffic />` create the instanced batches, but the
 * simulation driver has to write into them in a strict order (begin → every
 * subsystem pushes → commit), and that order cannot be expressed through React
 * props without threading refs through four components. So the batches live
 * here as process-lifetime singletons that the components create and register
 * and the driver reads.
 *
 * They are created lazily and disposed explicitly: a hot-reload that leaks a
 * few thousand instanced attributes is how you end up debugging a "memory
 * leak" that is really a module-scope cache.
 */
import { CharacterBatch } from "./characters";
import { HelicopterBatch, VehicleBatch } from "./vehicleMeshes";

let characters: CharacterBatch | null = null;
let vehicles: VehicleBatch | null = null;
let helicopters: HelicopterBatch | null = null;

/** Instance ceilings. Sized for the ultra budget plus the response's headroom. */
const MAX_NEAR_CHARACTERS = 260;
const MAX_FAR_CHARACTERS = 420;

export function characterBatch(): CharacterBatch {
  if (!characters) characters = new CharacterBatch(MAX_NEAR_CHARACTERS, MAX_FAR_CHARACTERS);
  return characters;
}

export function peekCharacterBatch(): CharacterBatch | null {
  return characters;
}

export function vehicleBatch(): VehicleBatch {
  if (!vehicles) {
    vehicles = new VehicleBatch(
      {
        // Ambient traffic gets the volume; the exotic kinds get just enough
        // that a full response plus a cable car line still fits.
        sedan: 64,
        hatchback: 40,
        suv: 40,
        taxi: 32,
        van: 28,
        pickup: 28,
        bus: 10,
        cablecar: 6,
        police: 26,
        swatvan: 10,
        ambulance: 6,
        firetruck: 5,
        apc: 8,
      },
      24,
    );
  }
  return vehicles;
}

export function peekVehicleBatch(): VehicleBatch | null {
  return vehicles;
}

export function helicopterBatch(): HelicopterBatch {
  if (!helicopters) {
    const vb = vehicleBatch();
    helicopters = new HelicopterBatch(4, vb.material, vb.depthMaterial);
  }
  return helicopters;
}

export function peekHelicopterBatch(): HelicopterBatch | null {
  return helicopters;
}

/** Tear every batch down. Called on unmount of the AI root. */
export function disposeStage(): void {
  helicopters?.dispose();
  helicopters = null;
  characters?.dispose();
  characters = null;
  vehicles?.dispose();
  vehicles = null;
}
