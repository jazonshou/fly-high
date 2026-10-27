import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { FlightVisualState } from "@/src/game/types";
import {
  LC76_CG_HEIGHT,
  LC76_FRONT_AXLE_X,
  LC76_FRONT_TRACK,
  LC76_REAR_AXLE_X,
  LC76_REAR_TRACK,
  LC76_WHEEL_RADIUS,
} from "@/src/sim/ground/standInCar";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { AircraftBuildContext } from "../aircraft/builders";
import type { VehicleVisual } from "../vehicle/types";

/**
 * A STAND-IN LandCruiser 76: boxes for the tub, cab and tray and four
 * cylinders for the wheels, posed from `CarVisualState`'s steer, spin and axle
 * travel, so the seam can be driven and framed before the real model exists.
 * The car-look build replaces it behind `createSurfaceVehicleVisual` with the
 * modelled 76 (land plan P3).
 *
 * Body frame as everywhere: +X forward, +Y up, +Z right, origin at the
 * centre of gravity, 0.80 m above the ground.
 */
export function createWebGpuCar(scene: Scene, kind: SurfaceVehicleKind): VehicleVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode(`${kind}-root`, scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    surfaceVehicleVisual: true,
    vehicleKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", starboard: "+z" },
  };
  const paint = build.material(`${kind}-paint`, 0xe9e6dc, { roughness: 0.42, metallic: 0.05 });
  const glass = build.material(`${kind}-glass`, 0x1a262c, { roughness: 0.08, metallic: 0.2 });
  const rubber = build.material(`${kind}-rubber`, 0x1b1b1b, { roughness: 0.9, metallic: 0 });
  const meshes: Mesh[] = [];
  const ground = -LC76_CG_HEIGHT;

  const part = (mesh: Mesh, parent: TransformNode, castsShadow = true): Mesh => {
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.metadata = { surfaceVehicleVisual: true, castsShadow };
    meshes.push(mesh);
    return mesh;
  };
  const box = (name: string, width: number, height: number, depth: number, x: number, y: number, material = paint) => {
    const mesh = part(CreateBox(`${kind}-${name}`, { width, height, depth }, scene), root);
    mesh.position.set(x, y, 0);
    mesh.material = material;
    return mesh;
  };
  // 4,910 mm overall from the bull bar to the rear door, 1,870 mm wide.
  const front = LC76_FRONT_AXLE_X + 0.84;
  const rear = LC76_REAR_AXLE_X - 1.34;
  // 290 mm clearance under the axles; the tub's sill sits higher, over the wheels.
  const sill = ground + 0.55;
  box("tub", front - rear, 0.72, 1.87, (front + rear) / 2, sill + 0.36);
  box("cab", 2.9, 0.68, 1.8, rear + 1.45 + 0.05, sill + 0.72 + 0.34);
  box("screen", 0.05, 0.55, 1.62, rear + 2.95, sill + 0.72 + 0.32, glass);

  const wheels: TransformNode[] = [];
  const wheelX = [LC76_FRONT_AXLE_X, LC76_FRONT_AXLE_X, LC76_REAR_AXLE_X, LC76_REAR_AXLE_X];
  const wheelZ = [-LC76_FRONT_TRACK / 2, LC76_FRONT_TRACK / 2, -LC76_REAR_TRACK / 2, LC76_REAR_TRACK / 2];
  const restY = ground + LC76_WHEEL_RADIUS;
  for (let i = 0; i < 4; i += 1) {
    const steer = new TransformNode(`${kind}-wheel-${i}-steer`, scene);
    steer.parent = root;
    steer.position.set(wheelX[i]!, restY, wheelZ[i]!);
    const spin = new TransformNode(`${kind}-wheel-${i}-spin`, scene);
    spin.parent = steer;
    spin.rotationQuaternion = null;
    const tyre = part(CreateCylinder(`${kind}-wheel-${i}`, {
      diameter: LC76_WHEEL_RADIUS * 2,
      height: 0.265,
      tessellation: 20,
    }, scene), spin);
    // The cylinder's axis is +Y; the axle is body Z.
    tyre.rotation.x = Math.PI / 2;
    tyre.material = rubber;
    wheels.push(steer);
  }
  const spins = wheels.map((steer) => steer.getChildren()[0] as TransformNode);

  return {
    kind,
    root,
    cockpitParts: meshes.filter((mesh) => mesh.name.endsWith("cab") || mesh.name.endsWith("screen")),
    meshes: meshes as AbstractMesh[],
    update(state: FlightVisualState): void {
      const car = state.vehicle?.kind === "car" ? state.vehicle : null;
      for (let i = 0; i < 4; i += 1) {
        const steer = wheels[i]!;
        // Positive steer turns the front to the right (+Z): a negative turn about +Y.
        steer.rotation.y = -(car?.wheelSteer[i] ?? 0);
        const axle = i < 2 ? 0 : 1;
        const side = wheelZ[i]! > 0 ? 1 : -1;
        const track = i < 2 ? LC76_FRONT_TRACK : LC76_REAR_TRACK;
        steer.position.y = restY + (car?.axleHeave[axle] ?? 0) + side * (track / 2) * Math.sin(car?.axleRoll[axle] ?? 0);
        // Rolling forward turns the top of the wheel forward: a negative turn about +Z.
        spins[i]!.rotation.z = -(car?.wheelSpin[i] ?? 0);
      }
    },
    setLightState(): void {
      // No lamps on the stand-in.
    },
    setCockpitView(enabled: boolean): void {
      for (const mesh of meshes) {
        if (mesh.name.endsWith("cab") || mesh.name.endsWith("screen")) mesh.setEnabled(!enabled);
      }
    },
    dispose(): void {
      for (const mesh of meshes) mesh.dispose(false, false);
      for (const node of [...spins, ...wheels]) node.dispose(false, false);
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}
