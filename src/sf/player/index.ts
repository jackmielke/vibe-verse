/**
 * player/index.ts — everything another subsystem should need from the player.
 *
 * The composition root mounts `<Player/>`. Weapons drive `viewmodelRig` and
 * `cameraRig`. Vehicles call `playerCtrl.enterVehicle` / `setVehicleSeat` /
 * `exitVehicle`. AI subscribes to `grappleSystem.onTetherPull`. The HUD reads
 * `wingsuit`, `parachute`, `grappleSystem` and `playerCtrl` directly — they
 * are all plain objects mutated in place, so reading them from a `useFrame`
 * costs nothing.
 *
 * Nothing in here should be imported for its side effects; every module is
 * safe to import from a worker or a test.
 */
export { default as Player } from "./Player";
export type { PlayerProps } from "./Player";

export { default as GrappleView } from "./Grapple";
export { default as WingsuitView } from "./Wingsuit";
export { default as ParachuteView } from "./Parachute";
export { default as ViewModel, viewmodelRig } from "./viewmodel";
export type { ViewmodelEvent } from "./viewmodel";

export { playerCtrl, PlayerController } from "./controller";
export { cameraRig, CameraRig } from "./camera";
export type { CameraDrive } from "./camera";

export { grappleSystem, MAX_WORLD_TETHERS } from "./grapple";
export type {
  RuntimeTether,
  WorldTether,
  TetherEnd,
  TetherMode,
  HookImpact,
} from "./grapple";

export { wingsuit } from "./wingsuit";
export { parachute } from "./parachute";

export {
  input,
  ACTIONS,
  ACTION_INDEX,
  ACTION_COUNT,
  DEFAULT_BINDINGS,
} from "./input";
export type {
  ActionName,
  ActionSnapshot,
  Bindings,
  BindingToken,
  InputDevice,
  InputOptions,
} from "./input";

/** The interim free-fly observer. Still the mobile fallback; do not delete. */
export { default as Explorer } from "./Explorer";
