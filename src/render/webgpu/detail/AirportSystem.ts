import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { runwayToWorld, type AirportDefinition } from "@/src/world";
import {
  buildTowerGeometry,
  TOWER_PART_NAMES,
  type TowerAttachments,
} from "./towerGeometry";

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
  /**
   * `7-15`: where `7-14` hangs obstruction lights and `7-7` mounts its rotating
   * beacon, in RUNWAY-LOCAL coordinates plus the tower's own placement offset —
   * i.e. the same frame as `root`'s children. Published rather than left to be
   * rediscovered from constants, and part of the class surface so a rename
   * breaks a test instead of silently relocating someone else's lights.
   */
  readonly towerAttachments: TowerAttachments;
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
    // `7-15`: the ATC tower. Built HERE, in the constructor, and parented under
    // `root` before it returns — because `FlightRenderer` registers airport
    // meshes exactly once: `shadowCasters` is frozen below and read at
    // `FlightRenderer.ts:876`, and `root.getChildMeshes(false)` is walked at
    // `:986` (cloud shadows) and `:1002` (aerial perspective). A mesh built
    // lazily or reparented afterwards joins none of the three and there is no
    // error — it just loses cloud shadows and aerial perspective, which is
    // visible only in a capture. `render.webgpu-airport-tower.test.ts` asserts
    // against those registries rather than against this build.
    const tower = buildTowerGeometry();
    const towerNode = new TransformNode("airport-tower", scene);
    towerNode.parent = this.root;

    // Placed on the hangar side, nearer the runway than the hangars (+95 m
    // against their +118) and offset along it, so on final approach it reads as
    // a separate structure at a different range rather than a fourth hangar.
    const towerAcross = definition.runwayWidth * 0.5 + 95;
    const towerAlong = definition.runwayLength * 0.06;
    const towerWorld = runwayToWorld(definition, towerAlong, towerAcross);
    const towerGround = groundHeight(towerWorld.x, towerWorld.z);
    // Same rule as the hangars: the root sits at the datum, so the tower's
    // local y is however far the ground has fallen from it. The earthworks
    // batter is 118 m across the centreline and the tower stands inside that,
    // so this is not a formality.
    const towerSit = Number.isFinite(towerGround) ? towerGround - definition.elevation : 0;
    towerNode.position.set(towerAcross, towerSit, towerAlong);

    const concrete = this.material(scene, "tower-concrete", new Color3(0.52, 0.51, 0.48), 0.72);
    const glass = this.material(scene, "tower-glass", new Color3(0.06, 0.09, 0.11), 0.14, 0.35);
    const steel = this.material(scene, "tower-steel", new Color3(0.30, 0.32, 0.34), 0.40, 0.55);
    // 7-11 owns the real material set; these are local stand-ins chosen to read
    // correctly at range rather than to anticipate that item's palette.
    const towerMaterials: Readonly<Record<string, PBRMaterial>> = {
      base: concrete, shaft: concrete, gallery: concrete,
      railing: steel, cab: glass, cabRoof: steel, mast: steel,
    };

    const towerMeshes: Mesh[] = [];
    for (const name of TOWER_PART_NAMES) {
      const part = tower.parts[name];
      const mesh = new Mesh(`airport-tower-${name}`, scene);
      const data = new VertexData();
      data.positions = part.positions as unknown as number[];
      data.normals = part.normals as unknown as number[];
      data.uvs = part.uvs as unknown as number[];
      data.indices = part.indices as unknown as number[];
      data.applyToMesh(mesh, false);
      mesh.material = towerMaterials[name] ?? concrete;
      mesh.parent = towerNode;
      towerMeshes.push(mesh);
    }

    // Attachment points carry the tower's placement so a consumer does not have
    // to know it. Still runway-local — `root` supplies heading and elevation.
    const offset = (p: readonly [number, number, number]): readonly [number, number, number] =>
      [p[0] + towerAcross, p[1] + towerSit, p[2] + towerAlong];
    this.towerAttachments = Object.freeze({
      beaconMount: offset(tower.attachments.beaconMount),
      mastTip: offset(tower.attachments.mastTip),
      cabRoofRing: Object.freeze(tower.attachments.cabRoofRing.map(offset)),
      heightMeters: tower.attachments.heightMeters,
    });

    this.shadowCasters = Object.freeze([...hangars, ...towerMeshes]);
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
