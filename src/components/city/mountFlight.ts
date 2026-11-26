export type MountKind = "pegasus" | "dragon" | "turkey";
export interface FlightState { x: number; y: number; z: number; yaw: number; speed: number; lift: number; bank: number; }
export interface FlightInput { throttle: number; steer: number; flap: boolean; dive: boolean; }
export const MOUNT_SEAT = 1.55;
/**
 * How each mount handles. Pegasus and the dragon cruise and glide; the
 * Thanksgiving turkey is slower, turns tighter, and drops the moment you stop
 * flapping, which is about as well as a turkey the size of a van would fly.
 */
export const MOUNT_TUNE: Record<MountKind, { cruise: number; throttle: number; turn: number; flap: number; sink: number; dive: number }> = {
  pegasus: { cruise: 22, throttle: 14, turn: 1.25, flap: 12, sink: -1.5, dive: -15 },
  dragon: { cruise: 22, throttle: 14, turn: 1.25, flap: 12, sink: -1.5, dive: -15 },
  turkey: { cruise: 12, throttle: 7, turn: 1.7, flap: 8, sink: -5, dive: -12 },
};
export function stepMount(s: FlightState, input: FlightInput, delta: number, floor: number, kind: MountKind = "pegasus"): void {
  const k = MOUNT_TUNE[kind];
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const turn = Math.max(-1, Math.min(1, input.steer));
  s.yaw -= turn * k.turn * dt;
  s.speed += ((k.cruise + Math.max(-1, Math.min(1, input.throttle)) * k.throttle) - s.speed) * (1 - Math.exp(-2 * dt));
  s.lift += ((input.flap ? k.flap : input.dive ? k.dive : k.sink) - s.lift) * (1 - Math.exp(-3 * dt));
  s.bank += (-turn * 0.35 - s.bank) * (1 - Math.exp(-5 * dt));
  s.x += Math.sin(s.yaw) * s.speed * dt;
  s.z += Math.cos(s.yaw) * s.speed * dt;
  s.y = Math.max(floor + 2.5, Math.min(700, s.y + s.lift * dt));
}