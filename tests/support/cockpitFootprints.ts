import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "@/src/render/cameraPresentation";
import { createWebGpuAircraft } from "@/src/render/webgpu/aircraft";
import type { AircraftVisual } from "@/src/render/webgpu/aircraft/types";
import type { AircraftKind } from "@/src/sim";

/**
 * What a deck's cockpit occupies on screen from the eye — the instrument the
 * cockpit HUD layout was measured with (docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md),
 * kept here so the tests measure the same way.
 *
 * Each deck is built under NullEngine as tests/render.cockpit-*.test.ts build it
 * (root at the origin, body +X nose / +Y up / +Z starboard, cockpit view on). The
 * camera is the renderer's cockpit camera: the catalogue eye, looking down the body
 * axis, HORIZONTAL-FIXED at the gameplay lens, sized to the window being tested, so
 * its picking rays come from Babylon's own projection for that window shape.
 *
 * A pick returns the first surface the GPU DRAWS along the ray, which is not what a
 * plain ray cast returns: the eye sits inside the Global's and the 747's fuselages,
 * and a ray hits the back faces the GPU culls. The winding convention is the one
 * tests/render.cockpit-drawn-faces.test.ts measured: a drawn face has
 * dot(cross(p1 - p0, p2 - p0), rayDirection) > 0, unless its material is two-sided.
 */
export const DECKS = ["trainer", "jet", "bizjet", "airliner"] as const;
export type Deck = (typeof DECKS)[number];

/** What a drawn surface is, for the HUD's purposes. */
export type CockpitCategory = "display" | "bezel" | "glareshield" | "panel" | "hud-frame" | "structure";
/** The surfaces the HUD must never print on: the deck, its screens and their bezels. */
export const DECK_CATEGORIES: ReadonlySet<CockpitCategory> = new Set(["display", "bezel", "glareshield", "panel"]);

export interface CockpitHit {
  readonly category: CockpitCategory;
  /** The mesh, or for merged screens and bezels the source part (`metadata.mergedFrom`). */
  readonly part: string;
}

function categoryOf(name: string): CockpitCategory {
  if (/screens|gauge|needle|attitude-(sky|ground|pitch)/.test(name)) return "display";
  if (/bezel/.test(name)) return "bezel";
  if (/glare-?shield/.test(name)) return "glareshield";
  if (/instrument-panel/.test(name)) return "panel";
  if (/hud-frame/.test(name)) return "hud-frame";
  return "structure";
}

export interface CockpitView {
  readonly width: number;
  readonly height: number;
  readonly eye: Vector3;
  /** The first drawn surface at a pixel (its centre is `x + 0.5, y + 0.5`), or null for the world outside. */
  pick(x: number, y: number): CockpitHit | null;
  /** The first drawn surface along a direction from the eye, in the body frame. */
  pickDirection(direction: Vector3): CockpitHit | null;
  dispose(): void;
}

/** Builds `kind`'s deck with the cockpit camera for a `width` x `height` window. */
export function cockpitView(kind: AircraftKind, width: number, height: number): CockpitView {
  const engine = new NullEngine({
    renderWidth: width, renderHeight: height, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const spec = aircraftSpec(kind).cockpitEye;
  const eye = new Vector3(spec.forward, spec.up, spec.right);
  const camera = new UniversalCamera("cockpit-footprint-camera", eye.clone(), scene);
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.fov = (COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 180;
  camera.minZ = 0.08;
  camera.setTarget(eye.add(new Vector3(1, 0, 0)));
  scene.activeCamera = camera;
  const aircraft: AircraftVisual = createWebGpuAircraft(scene, kind);
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);

  const drawn = (mesh: AbstractMesh) => {
    const material = mesh.material as PBRMaterial | null;
    return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
      && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
  };
  const worldPositions = new Map<AbstractMesh, Float32Array>();
  const trianglePoints = (mesh: AbstractMesh, faceId: number): Vector3[] => {
    let world = worldPositions.get(mesh);
    if (!world) {
      const local = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const matrix = mesh.getWorldMatrix();
      world = new Float32Array(local.length);
      for (let i = 0; i + 2 < local.length; i += 3) {
        const v = Vector3.TransformCoordinates(new Vector3(local[i]!, local[i + 1]!, local[i + 2]!), matrix);
        world[i] = v.x;
        world[i + 1] = v.y;
        world[i + 2] = v.z;
      }
      worldPositions.set(mesh, world);
    }
    const indices = mesh.getIndices()!;
    return [0, 1, 2].map((k) => {
      const i = indices[faceId * 3 + k]! * 3;
      return new Vector3(world![i]!, world![i + 1]!, world![i + 2]!);
    });
  };
  const firstDrawn = (hits: PickingInfo[], direction: Vector3): CockpitHit | null => {
    const sorted = hits.filter((h) => h.hit && h.pickedMesh).sort((a, b) => a.distance - b.distance);
    for (const hit of sorted) {
      const mesh = hit.pickedMesh!;
      const material = mesh.material as PBRMaterial | null;
      if (!(material && material.backFaceCulling === false)) {
        const [p0, p1, p2] = trianglePoints(mesh, hit.faceId);
        if (Vector3.Dot(Vector3.Cross(p1!.subtract(p0!), p2!.subtract(p0!)), direction) <= 0) continue;
      }
      const merged = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
      // Merged screens and bezels are 24-vertex boxes, 12 triangles each, in mergedFrom order.
      const part = merged && /screens|bezels/.test(mesh.name) ? merged[Math.floor(hit.faceId / 12)] ?? mesh.name : mesh.name;
      return { category: categoryOf(mesh.name), part };
    }
    return null;
  };
  return {
    width, height, eye,
    pick(x, y) {
      const ray = scene.createPickingRay(x + 0.5, y + 0.5, Matrix.Identity(), camera);
      return firstDrawn(scene.multiPickWithRay(ray, drawn) ?? [], ray.direction);
    },
    pickDirection(direction) {
      // From the near plane, as the camera's own rays start.
      const unit = direction.normalizeToNew();
      const ray = new Ray(eye.add(unit.scale(camera.minZ)), unit, 80);
      return firstDrawn(scene.multiPickWithRay(ray, drawn) ?? [], unit);
    },
    dispose() {
      worldPositions.clear();
      aircraft.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

/**
 * The deck's top as the catalogue states it (`cockpitDeckLineDegrees`): the
 * largest drop below the centre row, per unit of the lens's focal length, at
 * which a column's first drawn surface is deck — returned as the angle whose
 * tangent that is. Straight ahead it is the deck edge's depression; off-centre it
 * describes the ROW, which is what the window cares about.
 *
 * A column is walked down in 0.1 degree steps from 2 degrees below the centre row
 * to its first deck hit, then bisected to 1e-4 degrees. `coarse` columns span the
 * frame; the best three are then re-searched `fine` columns either side, at a
 * tenth of the spacing, so a crown between two coarse columns is found.
 */
export function measureDeckLineDegrees(view: CockpitView, coarse = 160, fine = 10): number {
  const halfWidth = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
  const isDeck = (tx: number, depressionDegrees: number) => {
    const hit = view.pickDirection(new Vector3(1, -Math.tan((depressionDegrees * Math.PI) / 180), tx));
    return hit !== null && DECK_CATEGORIES.has(hit.category);
  };
  /** A column's deck top in degrees, or +Infinity if it has none above `limit`. */
  const columnTop = (tx: number, limit: number): number => {
    let above = 2;
    let below = Number.NaN;
    // One step past the limit, so a deck starting between the last step and the limit is not missed.
    for (let d = 2; d <= Math.min(limit, 30) + 0.1; d += 0.1) {
      if (isDeck(tx, d)) { below = d; break; }
      above = d;
    }
    if (Number.isNaN(below)) return Number.POSITIVE_INFINITY;
    while (below - above > 1e-4) {
      const mid = (above + below) / 2;
      if (isDeck(tx, mid)) below = mid; else above = mid;
    }
    return below;
  };
  const spacing = (2 * halfWidth) / coarse;
  const tops: { tx: number; top: number }[] = [];
  for (let column = 0; column <= coarse; column += 1) {
    const tx = -halfWidth + spacing * column;
    tops.push({ tx, top: columnTop(tx, 30) });
  }
  let best = Math.min(...tops.map((t) => t.top));
  for (const { tx } of [...tops].sort((a, b) => a.top - b.top).slice(0, 3)) {
    for (let k = -fine; k <= fine; k += 1) {
      const x = tx + (spacing * k) / fine;
      if (Math.abs(x) > halfWidth) continue;
      best = Math.min(best, columnTop(x, best));
    }
  }
  return best;
}
