/**
 * The San Francisco: FREE FALL vehicle subsystem — public surface.
 *
 *   import Vehicles, { vehicleRuntime, drivingSystem } from "@/sf/vehicles";
 *
 *   <Vehicles />                                   // once, inside the Canvas
 *   vehicleRuntime.spawn({ kind: "police", x, y, z })
 *   drivingSystem.enter(id)
 *
 * Everything is pooled and deterministic, nothing allocates per frame, and
 * every call is a safe no-op before Rapier has booted.
 *
 * Mount order matters in exactly one place: `<Vehicles />` must come *after*
 * `<Player />` in the tree, so the player controller has already consumed the
 * frame's input and written the camera before the driving system reads it.
 */

/* ---- the component + the spawn manager ---- */
export { default, promoteToSimulated, KIND_FROM_TRAFFIC } from "./Vehicles";
export type { VehiclesProps } from "./Vehicles";

/* ---- models ---- */
export {
  VEHICLE_DEFS,
  VEHICLE_KINDS,
  VehicleModel,
  axleLayout,
  buildVehicleModel,
  chassisMetrics,
  disposeVehicleAssets,
  originYFor,
  paintFor,
  paintForSeed,
  toPhysicsSpec,
} from "./models";
export type {
  BuildOptions,
  Channel,
  DamageVisual,
  DoorDef,
  FuelTankDef,
  LampState,
  LiveryKind,
  SeatDef,
  VehicleClass,
  VehicleDef,
  VehicleKind,
  VehicleMaterialSet,
  VehicleUniforms,
  WheelVisual,
} from "./models";

/* ---- runtime ---- */
export {
  VehicleInstance,
  enableVehicleAudio,
  setVehicleAudioVolume,
  vehicleAt,
  vehicleMatrix,
  vehicleRuntime,
} from "./vehicle";
export type {
  DamageKind,
  EngineAudioFrame,
  Passenger,
  SpawnOptions,
  VehicleFaction,
  VehicleFilter,
} from "./vehicle";

/* ---- driving ---- */
export {
  DRIVE_BINDINGS,
  DrivingSystem,
  VehicleCamera,
  drivingSystem,
  nearestSeat,
  vehicleHeading,
} from "./driving";
export type { CameraMode, DriveAction } from "./driving";

/* ---- hijacking ---- */
export { hijackSystem } from "./hijack";
export type { HijackKind, HijackPrompt, HijackState } from "./hijack";

/* ---- flight ---- */
export { FixedWingAero, flightSystem } from "./flight";
export type { FixedWingInput, FlightTelemetry } from "./flight";

/* ---- boats + the wave surface ---- */
export {
  boatSystem,
  installWaterSampler,
  seaLevelAt,
  uninstallWaterSampler,
  waveHeight,
  waveNormal,
} from "./boats";
