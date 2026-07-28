/**
 * The street layer of San Francisco: FREE FALL.
 *
 * Everything between the buildings: the carriageway and its paint, the kerbs
 * and corners, the furniture, the planting and the neon. Mount `<Streets />`
 * once, anywhere inside the Canvas — each subsystem streams itself against the
 * camera and needs no props.
 *
 * The other half of this module is `roadNetwork`, which is a *queryable graph*
 * rather than a renderer. Traffic AI, pedestrian AI, the minimap and anything
 * that needs to know "what street is this and which way do its lanes run"
 * should read it directly; it is the single spatial authority for the street
 * layer in exactly the way `sfGeo` is for the terrain.
 */
import { useEffect } from "react";
import Roads from "./Roads";
import Sidewalks from "./Sidewalks";
import StreetProps from "./StreetProps";
import Vegetation from "./Vegetation";
import Signage from "./Signage";

export { default as Roads } from "./Roads";
export { default as Sidewalks } from "./Sidewalks";
export { default as StreetProps } from "./StreetProps";
export { default as Vegetation } from "./Vegetation";
export { default as Signage } from "./Signage";

/* ---- the graph, for traffic / pedestrians / navigation / the map ---- */
import { roadNetwork as roadNetworkSingleton } from "./roadNetwork";

export {
  RoadNetwork,
  roadNetwork,
  roadSurface,
  pavementY,
  edgeSpan,
  travelLanes,
  parkingLane,
  signalState,
  approachPhase,
  streetAt,
  GRIDS,
  ROAD_LIFT,
  SIDEWALK_WIDTH,
  KERB_HEIGHT,
  CAMBER,
} from "./roadNetwork";

export type {
  RoadNode,
  RoadEdge,
  Lane,
  SurfacePoint,
  SignalState,
  TrafficControl,
} from "./roadNetwork";

/* ---- placement rules other systems may want to agree with ---- */
export { drivewayCuts, treeWells, capacityFor } from "./streetFurniture";
export type { PropKind } from "./streetFurniture";
export type { Species } from "./Vegetation";

/* ---- geometry kit, in case another subsystem wants to emit into a chunk ---- */
export { MeshSink } from "./geom";
export { ChunkStreamer, InstancePool, boxDistance } from "./chunker";

/**
 * The whole street layer. Order matters only for draw-call grouping, not for
 * correctness — every subsystem reads the same `roadNetwork` and none of them
 * talk to each other.
 */
export default function Streets() {
  // The graph is a process-lifetime cache shared by five components, so no one
  // of them may clear it. This is the only place that owns all five.
  useEffect(() => () => roadNetworkSingleton.clear(), []);
  return (
    <>
      <Roads />
      <Sidewalks />
      <StreetProps />
      <Vegetation />
      <Signage />
    </>
  );
}
