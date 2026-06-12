// Shared analog input vector. Populated by touch joystick on mobile.
// Range: [-1, 1] for each axis. `fire` is a one-shot edge — set true by a
// tap or keypress, consumed (reset to false) by the Player frame loop.
export const input = { x: 0, z: 0, fire: false };
