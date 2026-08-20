import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { runwayToWorld, type AirportDefinition } from "@/src/world";

/**
 * The authored detail around the starter airport — which, since `3-9`, is the
 * hangars and nothing else.
 *
 * Deleted at `3-9`: the 0.16 m runway box at y = 0.08, the ~9 centreline
 * stripes and ~18 threshold bars floating at y = 0.175, and the apron slab.
 * That stack of 28 coplanar boxes was the z-fighting the audit names, and it
 * floated above ground that had been flattened into a circular plateau to
 * receive it. The runway is now PAINTED into the terrain surface by the
 * analytic airport SDF (`terrain/RunwaySurface.ts`), on ground shaped by the
 * earthworks profile (`terrain/RunwayEarthworks.ts`) — nothing is coplanar
 * with anything, because there is only one surface.
 *
 * The hangars stay: `RENDERING_PLAN.md` §1.5 keeps them because they are the
 * only scale reference on final approach, and Phase 7 `7-10` replaces them
 * properly, apron included.
 */
export class AirportSystem {
  readonly root: TransformNode;
  readonly shadowCasters: readonly Mesh[];
  private readonly materials: PBRMaterial[] = [];

  /**
   * `groundHeight` samples the shipped terrain at a WORLD coordinate. It is
   * required since `3-9`: the hangars used to stand on the apron slab, which
   * was itself pinned to `airport.elevation` and floated above whatever the
   * ground did. The slab is gone and the ground beneath them is now the
   * earthworks batter — 118 m across the centreline, well outside the graded
   * platform — so a hangar pinned to the datum floats or sinks by however much
   * the batter has fallen away. Each one is placed on the ground it stands on.
   */
  constructor(
    scene: Scene,
    private readonly definition: Readonly<AirportDefinition>,
    groundHeight: (x: number, z: number) => number,
  ) {
    this.root = new TransformNode("airport", scene);
    this.root.rotation.y = definition.headingRadians;

    const metal = this.material(scene, "hangar-metal", new Color3(0.20, 0.25, 0.27), 0.48, 0.42);

    const hangars: Mesh[] = [];
    for (let index = 0; index < 3; index += 1) {
      const height = 14 + index * 2;
      const hangar = CreateBox(`airport-hangar-${index}`, {
        width: 46,
        height,
        depth: 34,
      }, scene);
      // The node's local +x is the runway's ACROSS axis and local +z its ALONG
      // axis (the root carries the heading rotation), so these are runway-local
      // coordinates and `runwayToWorld` converts them for the ground query.
      const across = definition.runwayWidth * 0.5 + 118;
      const along = -definition.runwayLength * 0.12 + (index - 1) * 52;
      const world = runwayToWorld(definition, along, across);
      const ground = groundHeight(world.x, world.z);
      // The root sits at `definition.elevation`, so a hangar's local y is its
      // own half-height plus however far the ground has fallen from the datum.
      // Sunk 0.4 m so the sill meets the ground rather than hovering on it.
      const sit = Number.isFinite(ground) ? ground - definition.elevation : 0;
      hangar.position.set(across, sit + height * 0.5 - 0.4, along);
      hangar.material = metal;
      hangar.parent = this.root;
      hangars.push(hangar);
    }
    this.shadowCasters = Object.freeze(hangars);
  }

  setFloatingOrigin(x: number, z: number): void {
    this.root.position.set(
      this.definition.centerX - x,
      this.definition.elevation,
      this.definition.centerZ - z,
    );
  }

  dispose(): void {
    this.root.dispose(false, false);
    for (const material of this.materials) material.dispose(true, true);
  }

  private material(
    scene: Scene,
    name: string,
    color: Color3,
    roughness: number,
    metallic = 0,
  ): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = color;
    material.roughness = roughness;
    material.metallic = metallic;
    // 1C-6: full-strength now that scene.environmentTexture exists.
    material.environmentIntensity = 1;
    this.materials.push(material);
    return material;
  }
}
