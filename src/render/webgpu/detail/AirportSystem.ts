import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { runwayToWorld, type AirportDefinition } from "@/src/world";
import {
  WINDSOCK_MAST_HEIGHT_METERS,
  WINDSOCK_PART_KINDS,
  buildWindsockPart,
  windsockWorldPosition,
  buildPerimeterFenceGeometry,
  buildFuelFarmGeometry,
  buildSignageGeometry,
  type FenceOpening,
} from "./AirfieldFurniture";
import {
  buildTowerGeometry,
  TOWER_PART_NAMES,
  type TowerAttachments,
} from "./towerGeometry";
import { createAirfieldMaterials, type AirfieldMaterialSet } from "../airfield/AirfieldMaterials";
import {
  HANGAR_SITING,
  buildHangar,
  type HangarAttachments,
} from "../airfield/AirfieldStructures";
import {
  hangarSite,
  poseWindsock,
  towerSite,
  WINDSOCK_LENGTH_SCALE,
  windsockNodePosition,
} from "../airfield/AirfieldPlacement";

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
  /** `7-13`: the sock, the only furniture that moves. Null when unbuilt. */
  private windsockSock: Mesh | null = null;
  /**
   * Where the sock stands, in ABSOLUTE world metres — the point the renderer
   * must sample wind at. Absolute rather than origin-relative because
   * `sampleWind` is a world field; the floating origin moves the MESH, not the
   * weather.
   */
  readonly windsockSamplePoint: { readonly x: number; readonly y: number; readonly z: number };
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
  private readonly airfieldMaterials: AirfieldMaterialSet;
  /** Scratch for the per-frame sock pose, so it allocates nothing. */
  private readonly windsockAxis = new Vector3();

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
    /** Where roads pass through the perimeter fence (the home field's access road). */
    fenceOpenings: readonly FenceOpening[] = [],
  ) {
    this.windsockSamplePoint = windsockWorldPosition(definition);
    this.root = new TransformNode("airport", scene);
    this.root.rotation.y = definition.headingRadians;

    // `7-10`: the parametric hangars. Every one is built HERE, in the
    // constructor, and parented under `root` before it returns — same reason
    // the tower is, spelled out below.
    this.airfieldMaterials = createAirfieldMaterials(scene, seedHash);
    const hangars: Mesh[] = [];
    const hangarCasters: Mesh[] = [];
    const attachments: HangarAttachments[] = [];
    for (let index = 0; index < HANGAR_SITING.count; index += 1) {
      // Seated on the ground under its WHOLE footprint, by the placement
      // `AirfieldPlacement.hangarSite` shares with every spawned airfield.
      const site = hangarSite(definition, index, seedHash, groundHeight);
      const mounts = site.attachments;
      const node = new TransformNode(`airport-hangar-${index}`, scene);
      node.parent = this.root;
      // `root` sits at the datum, so a child's local y is measured from it.
      node.position.set(site.position[0], site.position[1], site.position[2]);
      // Set out by eye, not by instancing. The mesh is unchanged — this is a
      // node rotation, so it costs nothing in the draw budget or the vertex
      // count, and it is the one cue that survives however much the roofs vary.
      node.rotation.y = site.yawRadians;
      const built = buildHangar(scene, node, index, site.plan, mounts, this.airfieldMaterials);
      hangars.push(...built.meshes);
      // `7-10` detail: the CASTER list is the builder's, not this loop's. The
      // clerestory glazing is a mesh that draws and does not cast, so the two
      // lists have diverged and `hangars` is no longer a stand-in for either.
      hangarCasters.push(...built.shadowCasters);
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

    // Placed on the hangar side, nearer the runway than the hangars and offset
    // along it, standing on the ground it reads (`AirfieldPlacement.towerSite`).
    const towerPlacement = towerSite(definition, tower, groundHeight);
    towerNode.position.set(
      towerPlacement.position[0],
      towerPlacement.position[1],
      towerPlacement.position[2],
    );

    // `7-11` third pass: ALL SEVEN PARTS ARE NOW ON THE SHARED SET. The
    // stand-ins are gone and no tower-local material remains.
    //
    // **Concrete was the last holdout and the blocker was the UV contract, not
    // the palette** — it is the only one of the three that is TEXTURED. Both
    // halves of the contract were broken in `towerGeometry` and both read as
    // plausible, which is why this took a pass of its own:
    //
    //   - **V ran BACKWARDS.** The contract runs V down the face so weathering
    //     grows with gravity; `band()` emitted V = 0 at the bottom and 1 at the
    //     top, so oxidation climbed toward the mast and left the base clean. An
    //     inverted gradient still looks weathered, just wrongly.
    //   - **U was `i / SIDES`** — one tile per face regardless of size. With
    //     dU = 1/8 per face and chord = girth/8, metres-per-tile came out equal
    //     to the band's GIRTH: the base ran **46.4 m per 3.0 m tile, a 15.5x
    //     stretch**, essentially one tile wrapped around the whole tower.
    //
    // **MEASURED, and it corrects the prediction the previous pass recorded
    // here.** That comment said seams would "read coarser on the mast than on
    // the base"; it is the other way round. The mast's 2.32 m girth happens to
    // land within 3% of its 2.4 m tile period, so the mast was accidentally
    // RIGHT while every large band was stretched 11-18x. A check that sampled
    // one band could have picked the mast and passed —
    // `render.tower-uv-contract.test.ts` therefore asserts every band, and
    // samples the synthesized texture at the emitted UVs rather than reasoning
    // about the numbers.
    // (`AirfieldPlacement.TOWER_PART_SURFACES` is this table for the merged
    // spawned towers; the spawned-airfield test holds the two to the same
    // triangles per material.)
    const towerMaterials: Readonly<Record<string, PBRMaterial>> = {
      base: this.airfieldMaterials.concrete,
      shaft: this.airfieldMaterials.concrete,
      gallery: this.airfieldMaterials.concrete,
      railing: this.airfieldMaterials.steel,
      cab: this.airfieldMaterials.glass,
      cabRoof: this.airfieldMaterials.steel,
      mast: this.airfieldMaterials.steel,
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
      mesh.material = towerMaterials[name] ?? this.airfieldMaterials.concrete;
      mesh.parent = towerNode;
      towerMeshes.push(mesh);
    }

    // Attachment points carry the tower's placement so a consumer does not have
    // to know it. Still runway-local — `root` supplies heading and elevation.
    this.towerAttachments = towerPlacement.attachments;

    // `7-13`: the windsock. Built here for the same reason the hangars and the
    // tower are — parented under `root` before the constructor returns, so it
    // is carried by `setFloatingOrigin` and picked up by the shadow, cloud and
    // aerial registrations that read `root.getChildMeshes()`.
    const windsockNode = new TransformNode("airport-windsock", scene);
    windsockNode.parent = this.root;
    const windsockAt = windsockNodePosition(definition);
    windsockNode.position.set(windsockAt[0], windsockAt[1], windsockAt[2]);
    const windsockMeshes: Mesh[] = [];
    for (const kind of WINDSOCK_PART_KINDS) {
      const mesh = new Mesh(`airport-windsock-${kind}`, scene);
      const geometry = buildWindsockPart(kind, 1);
      const data = new VertexData();
      data.positions = Array.from(geometry.positions);
      data.normals = Array.from(geometry.normals);
      data.indices = Array.from(geometry.indices);
      data.applyToMesh(mesh, false);
      // The sock is high-visibility fabric, the mast and swivel are steel.
      mesh.material = kind === "sock"
        ? this.airfieldMaterials.accent
        : this.airfieldMaterials.metal;
      // The sock hangs from the swivel at the mast top and is the only part
      // that moves; mast and swivel are static in the node's frame.
      if (kind === "sock") {
        mesh.position.y = WINDSOCK_MAST_HEIGHT_METERS;
        mesh.rotationQuaternion = Quaternion.Identity();
        mesh.scaling.set(1, WINDSOCK_LENGTH_SCALE, 1);
        this.windsockSock = mesh;
      }
      mesh.parent = windsockNode;
      windsockMeshes.push(mesh);
    }

    const localHeight = (along: number, across: number): number => {
      const point = runwayToWorld(definition, along, across);
      return groundHeight(point.x, point.z) - definition.elevation;
    };
    // `7-13`: the perimeter fence. ONE merged mesh — the sizing disqualified
    // the alternative before it was written: 1,211 posts and 1,211 rail bays on
    // this runway's 3,632 m perimeter is 2,422 draw calls against a night
    // ceiling of 157.
    //
    // Ground-following rather than platform-relative: at 168 m across, the
    // perimeter stands on natural terrain, and a fence pinned to the platform
    // elevation floats over falling ground and sinks into rising ground.
    const fenceMesh = new Mesh("airport-fence", scene);
    {
      const geometry = buildPerimeterFenceGeometry(definition, localHeight, fenceOpenings);
      const data = new VertexData();
      data.positions = Array.from(geometry.positions);
      data.normals = Array.from(geometry.normals);
      data.indices = Array.from(geometry.indices);
      data.applyToMesh(fenceMesh, false);
      fenceMesh.material = this.airfieldMaterials.metal;
      fenceMesh.parent = this.root;
    }

    // Fuel farm and signage: one merged mesh each, same reasoning as the fence.
    // Both DO cast — unlike the fence, a 2.5 m tank and a 1.1 m sign board are
    // resolvable at approach range and their shadows are part of reading the
    // airfield as inhabited. Two meshes at 3 draws each is 6, against the
    // fence's 2,422-draw alternative; the trade is not close in either case.
    const furniture: Mesh[] = [];
    for (const [name, geometry] of [
      ["airport-fuel-farm", buildFuelFarmGeometry(localHeight)],
      ["airport-signage", buildSignageGeometry(definition, localHeight)],
    ] as const) {
      const mesh = new Mesh(name, scene);
      const data = new VertexData();
      data.positions = Array.from(geometry.positions);
      data.normals = Array.from(geometry.normals);
      data.indices = Array.from(geometry.indices);
      data.applyToMesh(mesh, false);
      mesh.material = this.airfieldMaterials.metal;
      mesh.parent = this.root;
      furniture.push(mesh);
    }

    // THE FENCE DOES NOT CAST, and it is a decision rather than an oversight —
    // someone will ask. A shadow-casting mesh costs 1 beauty draw plus one per
    // cascade, and tier 1 runs 2, so registering it here would spend 3 draws
    // per shot instead of 1. What that buys is the shadow of a 1.2 m post,
    // 168 m off the centreline, at ranges where the whole perimeter is a few
    // pixels tall. Nobody can resolve it, and it would be paid on every shot
    // including the ones where the airfield is not even in frame.
    // `hangarCasters`, NOT `hangars`: `7-10`'s clerestory glazing is a mesh that
    // draws and does not cast, so the two lists diverged and `hangars` stopped
    // being a stand-in for either. Every other contributor here still casts
    // everything it builds.
    this.shadowCasters = Object.freeze([
      ...hangarCasters, ...towerMeshes, ...windsockMeshes, ...furniture,
    ]);
  }

  /**
   * Point and inflate the sock.
   *
   * **The wind must be sampled AT THE SOCK.** The renderer's only other wind
   * consumer samples at the aircraft and forwards four scalars, and a sock
   * driven by that snapshot still points, still swings and still gusts — no
   * frame distinguishes it. `lighting.windsock.test.ts` asserts the two samples
   * differ in heading and speed, which is the assertion a shared-snapshot sock
   * fails; this is wired to satisfy it rather than around it.
   *
   * `windHeadingRadians` is world-referenced. Children of `root` are
   * runway-local, and `root` carries `rotation.y = headingRadians`, so the
   * local direction is the axis at the DIFFERENCE of the two headings — no
   * inverse rotation, and no chance of applying one the wrong way round.
   */
  setWindsockState(windHeadingRadians: number, windSpeedMetersPerSecond: number): void {
    if (!this.windsockSock) return;
    // Droop and inflation are BOTH functions of speed, so the caller passes
    // speed and `poseWindsock` derives them — one implementation shared with
    // every spawned airfield's sock.
    poseWindsock(
      this.windsockSock,
      this.definition.headingRadians,
      windHeadingRadians,
      windSpeedMetersPerSecond,
      this.windsockAxis,
    );
  }

  setFloatingOrigin(x: number, z: number): void {
    this.root.position.set(
      this.definition.centerX - x,
      this.definition.elevation,
      this.definition.centerZ - z,
    );
  }

  /**
   * The structure materials this field built and owns. Airports spawned in
   * flight draw with THESE — sharing them is what keeps a spawn from creating a
   * material, a texture or a shader pipeline mid-flight — and never dispose
   * them; this system does, last.
   */
  get materials(): AirfieldMaterialSet {
    return this.airfieldMaterials;
  }

  dispose(): void {
    this.root.dispose(false, false);
    this.airfieldMaterials.dispose();
  }
}
