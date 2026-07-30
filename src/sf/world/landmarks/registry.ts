/**
 * registry.ts — the one place that maps a `LandmarkKind` to the code that
 * builds it.
 *
 * Adding a landmark is: write the module, add the kind to `sfGeo`, add the row
 * here. Nothing else in the game needs to know it exists — the streamer walks
 * `LANDMARKS` and asks this table.
 */
import type { LandmarkKind } from "../../geo/sfGeo";
import type { LandmarkModule } from "./types";

import { goldenGateBridge } from "./goldenGate";
import { bayBridge } from "./bayBridge";
import { transamerica } from "./transamerica";
import { salesforceTower } from "./salesforce";
import { coitTower } from "./coitTower";
import { ferryBuilding } from "./ferryBuilding";
import { paintedLadies } from "./paintedLadies";
import { palaceOfFineArts } from "./palaceOfFineArts";
import { alcatraz } from "./alcatraz";
import { lombardStreet } from "./lombardStreet";
import { cityHall } from "./cityHall";
import { oraclePark } from "./oraclePark";
import { sutroTower } from "./sutroTower";
import { pier39, shipyardCranes, windmill } from "./waterfront";
import { cableCarTurnaround, chinatownGate, graceCathedral } from "./civicSmall";
import { fiveFiveFiveCalifornia, millenniumTower, sfmoma } from "./towers";

export const LANDMARK_BUILDERS: Record<LandmarkKind, LandmarkModule> = {
  "golden-gate-bridge": goldenGateBridge,
  "bay-bridge": bayBridge,
  transamerica,
  "salesforce-tower": salesforceTower,
  "coit-tower": coitTower,
  "ferry-building": ferryBuilding,
  "painted-ladies": paintedLadies,
  "palace-of-fine-arts": palaceOfFineArts,
  alcatraz,
  "lombard-street": lombardStreet,
  "city-hall": cityHall,
  "oracle-park": oraclePark,
  "cable-car-turnaround": cableCarTurnaround,
  "pier-39": pier39,
  "sutro-tower": sutroTower,
  "chinatown-gate": chinatownGate,
  sfmoma,
  "grace-cathedral": graceCathedral,
  "millennium-tower": millenniumTower,
  "555-california": fiveFiveFiveCalifornia,
  "shipyard-cranes": shipyardCranes,
  windmill,
};

/** The module for a kind, or `null` if nothing has been written for it yet. */
export function builderFor(kind: LandmarkKind): LandmarkModule | null {
  return LANDMARK_BUILDERS[kind] ?? null;
}
