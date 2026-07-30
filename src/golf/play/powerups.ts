/**
 * Vibe Golf — power-up balls.
 *
 * Owns the ball-type inventory UI hooks, pickups scattered on the course, and
 * the per-type behaviours that need a system (nitro burn, ghost phasing).
 *
 * STUB: placeholder. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createPowerups: SystemFactory = (_ctx) => ({ name: "powerups" }) as System;

export default createPowerups;
