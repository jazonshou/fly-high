import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
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
import { createAirfieldMaterials, type AirfieldMaterialSet } from "../airfield/AirfieldMaterials";
import {
  HANGAR_SITING,
  MINIMUM_SKIRT_METERS,
  buildHangar,
  hangarAttachments,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarSeatingFrom,
  type HangarAttachments,
} from "../airfield/AirfieldStructures";

/**
 * Ground-sample spacing under a hangar footprint.
 *
 * 2 m over 46 x 34 m is 408 samples per hangar. That is the resolution the
 * relief figures behind `7-10`'s seating rule were measured at, so the rule and
 * the bridge agree about what "the ground under it" means.
 */
const GROUND_SAMPLE_STEP_METERS = 2;

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
  /**
   * `7-14` and `7-7` mount to these. Runway-local with each hangar's own
   * placement folded in — the same frame as `towerAttachments`, and on the
   * class surface for the same reason: a rename breaks a test rather than
   * silently relocating someone else's lights.
   */
  readonly hangarAttachments: readonly HangarAttachments[];
  private readonly materials: PBRMaterial[] = [];
  private readonly airfieldMaterials: AirfieldMaterialSet;

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
    /**
     * `world.seedHash`, NOT `sourceSeedHash`. The airfield is earthworks-
     * coupled and therefore terrain-authority: it must agree with the ground it
     * stands on, and a guaranteed-airport world replaces `seedHash` during the
     * airport search so the two differ.
     */
    seedHash: number,
  ) {
    this.root = new TransformNode("airport", scene);
    this.root.rotation.y = definition.headingRadians;

    // `7-10`: the parametric hangars. Every one is built HERE, in the
    // constructor, and parented under `root` before it returns — same reason
    // the tower is, spelled out below.
    this.airfieldMaterials = createAirfieldMaterials(scene, seedHash);
    const hangars: Mesh[] = [];
    const attachments: HangarAttachments[] = [];
    for (let index = 0; index < HANGAR_SITING.count; index += 1) {
      const footprint = hangarFootprint(definition, index);
      // THE FOOTPRINT, NOT A CENTRE SAMPLE. A 46 x 34 m box on the earthworks
      // batter sits over 2.86-5.52 m of relief; seating on one point buried a
      // corner by up to 2.70 m and floated another by up to 2.85 m.
      const ground: number[] = [];
      for (const local of hangarFootprintSamples(footprint, GROUND_SAMPLE_STEP_METERS)) {
        const world = runwayToWorld(definition, local.along, local.across);
        const height = groundHeight(world.x, world.z);
        // Non-finite means the terrain query failed for that sample. Dropping
        // it is deliberate: `hangarSeatingFrom` THROWS on a non-finite input,
        // which is right for a pure function and wrong here, where it would
        // stop the flight from starting over one bad sample.
        if (Number.isFinite(height)) ground.push(height);
      }
      // If EVERY sample failed there is no ground to stand on, so fall back to
      // the datum — the pre-7-10 behaviour. Recorded rather than silent,
      // because a hangar at the datum on fallen ground looks like a modelling
      // bug rather than a failed query.
      const seating = ground.length > 0
        ? hangarSeatingFrom(ground)
        : { baseAltitudeMeters: definition.elevation, skirtHeightMeters: MINIMUM_SKIRT_METERS, reliefMeters: 0 };
      const plan = hangarPlanFrom(seedHash, index, seating.skirtHeightMeters);
      const mounts = hangarAttachments(definition, index, plan, seating.baseAltitudeMeters);
      const node = new TransformNode(`airport-hangar-${index}`, scene);
      node.parent = this.root;
      // `root` sits at the datum, so a child's local y is measured from it.
      node.position.set(
        footprint.across,
        seating.baseAltitudeMeters - definition.elevation,
        footprint.along,
      );
      const built = buildHangar(scene, node, index, plan, mounts, this.airfieldMaterials);
      hangars.push(...built.meshes);
      attachments.push(mounts);
    }
    this.hangarAttachments = Object.freeze(attachments);
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
    this.airfieldMaterials.dispose();
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
