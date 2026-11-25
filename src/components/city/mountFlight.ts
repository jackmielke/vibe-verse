export type MountKind = "pegasus" | "dragon";
export interface FlightState { x: number; y: number; z: number; yaw: number; speed: number; lift: number; bank: number; }
export interface FlightInput { throttle: number; steer: number; flap: boolean; dive: boolean; }
export const MOUNT_SEAT = 1.55;
export function stepMount(s: FlightState, input: FlightInput, delta: number, floor: number): void {
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const turn = Math.max(-1, Math.min(1, input.steer));
  s.yaw -= turn * 1.25 * dt;
  s.speed += ((22 + Math.max(-1, Math.min(1, input.throttle)) * 14) - s.speed) * (1 - Math.exp(-2 * dt));
  s.lift += ((input.flap ? 12 : input.dive ? -15 : -1.5) - s.lift) * (1 - Math.exp(-3 * dt));
  s.bank += (-turn * 0.35 - s.bank) * (1 - Math.exp(-5 * dt));
  s.x += Math.sin(s.yaw) * s.speed * dt;
  s.z += Math.cos(s.yaw) * s.speed * dt;
  s.y = Math.max(floor + 2.5, Math.min(700, s.y + s.lift * dt));
}