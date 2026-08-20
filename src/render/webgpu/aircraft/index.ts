export {
  PROPELLER_DISC_CROSSFADE_END_RADIANS_PER_SECOND,
  PROPELLER_DISC_CROSSFADE_START_RADIANS_PER_SECOND,
  resolvePropellerPresentation,
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
  type PropellerPresentation,
  type AircraftAnimationPose,
} from "./animation";
export { createAircraft, createWebGpuAircraft } from "./createAircraft";
export {
  AIRCRAFT_EXTERIOR_LAYER_MASK,
  aircraftCameraLayerMask,
  type AircraftVisual,
} from "./types";
export {
  AIRCRAFT_PAINT_EDGE,
  AIRCRAFT_PAINT_FEATURES,
  synthesizeAircraftSurface,
  type AircraftPaintFeature,
  type AircraftPaintRecipe,
  type AircraftSurfaceSynthesis,
} from "./materialSynthesis";
