import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { AircraftBuildContext } from "../aircraft/builders";
import type { VehicleVisual } from "./types";

/** Body-frame heights, from the boat simulators' centre of gravity. */
const KEEL_Y = -0.65;
const WATERLINE_Y = -0.2;
const SHEER_Y = 0.35;
const BEAM = 2.3;
/** Transom and the shoulder where the bow wedge starts, +X forward. */
const TRANSOM_X = -3.0;
const SHOULDER_X = 2.2;

/**
 * A stand-in speedboat built from boxes, so the shared base can drive, frame
 * and light a boat before the real model exists. About the size of a 21 ft
 * runabout: 6.35 m overall, 2.3 m beam, keel 0.45 m under the waterline, a
 * centre console and an outboard on the transom. The boat-presentation work
 * replaces it wholesale behind `createSurfaceVehicleVisual`.
 */
export function createPlaceholderBoat(scene: Scene, kind: SurfaceVehicleKind): VehicleVisual {
  const context = new AircraftBuildContext(scene);
  const root = new TransformNode(`${kind}-root`, scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = { surfaceVehicleVisual: true, vehicleKind: kind };

  const gelcoat = context.material(`${kind}-gelcoat`, 0xf1efe8, { roughness: 0.32, metallic: 0 });
  const antifouling = context.material(`${kind}-antifouling`, 0x1d2a44, { roughness: 0.7, metallic: 0 });
  const deck = context.material(`${kind}-deck`, 0xb9b2a2, { roughness: 0.8, metallic: 0 });
  const tint = context.material(`${kind}-screen`, 0x2a3640, { roughness: 0.08, metallic: 0.1 });
  const cowl = context.material(`${kind}-cowl`, 0x2b2d30, { roughness: 0.4, metallic: 0.2 });

  const hullLength = SHOULDER_X - TRANSOM_X;
  const hullCenterX = (SHOULDER_X + TRANSOM_X) / 2;
  const bottomHeight = WATERLINE_Y - KEEL_Y;
  const topsideHeight = SHEER_Y - WATERLINE_Y;
  const bottom = context.box(`${kind}-bottom`, hullLength, bottomHeight, BEAM, antifouling, root);
  bottom.position.set(hullCenterX, (KEEL_Y + WATERLINE_Y) / 2, 0);
  const topsides = context.box(`${kind}-topsides`, hullLength, topsideHeight, BEAM, gelcoat, root);
  topsides.position.set(hullCenterX, (WATERLINE_Y + SHEER_Y) / 2, 0);

  // A square turned 45 degrees: its diagonal is the beam, so the bow comes to
  // a point half a beam ahead of the shoulder.
  const bowSide = BEAM / Math.SQRT2;
  const bowTurn = Quaternion.RotationYawPitchRoll(Math.PI / 4, 0, 0);
  const bowBottom = context.box(`${kind}-bow-bottom`, bowSide, bottomHeight, bowSide, antifouling, root);
  bowBottom.position.set(SHOULDER_X, (KEEL_Y + WATERLINE_Y) / 2, 0);
  bowBottom.rotationQuaternion = bowTurn.clone();
  const bowTopsides = context.box(`${kind}-bow-topsides`, bowSide, topsideHeight, bowSide, gelcoat, root);
  bowTopsides.position.set(SHOULDER_X, (WATERLINE_Y + SHEER_Y) / 2, 0);
  bowTopsides.rotationQuaternion = bowTurn.clone();

  const sole = context.box(`${kind}-sole`, hullLength - 0.3, 0.04, BEAM - 0.2, deck, root);
  sole.position.set(hullCenterX + 0.1, SHEER_Y + 0.02, 0);
  const helm = context.box(`${kind}-console`, 0.65, 0.9, 0.75, gelcoat, root);
  helm.position.set(0.2, SHEER_Y + 0.45, 0);
  const screen = context.box(`${kind}-screen`, 0.05, 0.32, 0.8, tint, root);
  screen.position.set(0.55, SHEER_Y + 1.0, 0);
  screen.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, 0, -0.35);
  const outboard = context.box(`${kind}-outboard`, 0.5, 1.1, 0.45, cowl, root);
  outboard.position.set(TRANSOM_X - 0.25, WATERLINE_Y + 0.15, 0);

  const meshes = [bottom, topsides, bowBottom, bowTopsides, sole, helm, screen, outboard];
  return {
    kind,
    root,
    cockpitParts: [],
    meshes,
    update: () => {},
    setLightState: () => {},
    setCockpitView: () => {},
    dispose: () => {
      for (const mesh of meshes) mesh.dispose(false, false);
      root.dispose(false, false);
      context.disposeMaterials();
    },
  };
}
