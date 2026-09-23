import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import {
  AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID,
  keepOpaqueDepthForRenderingGroup,
} from "../core/RenderingGroups";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  AIRCRAFT_PAINT_FEATURES,
  createAircraftReliefTextures,
  createAircraftSurfaceTextures,
  synthesizeAircraftSurface,
  type AircraftPaintRecipe,
} from "./materialSynthesis";

export interface AircraftMaterialOptions {
  readonly roughness?: number;
  readonly metallic?: number;
  readonly alpha?: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  /** Keep the material in the alpha-blend bucket even when alpha reaches 1. */
  readonly alphaBlend?: boolean;
  readonly doubleSided?: boolean;
  readonly clearCoat?: Readonly<{
    intensity: number;
    roughness: number;
    indexOfRefraction?: number;
  }>;
  readonly transmission?: Readonly<{
    indexOfRefraction: number;
    minimumThickness: number;
    maximumThickness: number;
    tintColor: number;
    tintColorAtDistance: number;
  }>;
}

export interface PlanformPoint {
  readonly x: number;
  readonly z: number;
}

export interface SurfacePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A patch of some other surface, as `[span][chord]` points in one frame. */
export type SurfacePatch = readonly (readonly SurfacePoint[])[];

export interface VerticalProfilePoint {
  readonly x: number;
  readonly y: number;
}

export interface LoftSection {
  readonly x: number;
  readonly yRadius: number;
  readonly zRadius: number;
  readonly yOffset?: number;
  readonly zOffset?: number;
  /**
   * Superellipse exponent. 2 (the default) is the classic ellipse every
   * shipped aircraft lofts with, and the loft is bit-identical there; higher
   * values square the section off toward a rounded rectangle, for a chined
   * flat-wide fuselage a pure ellipse cannot express.
   */
  readonly squareness?: number;
  /**
   * Half-width at the CROWN, for a section that is not the same width all the
   * way up — an egg rather than an ellipse.
   *
   * A wide-body's forward fuselage is widest at the main deck floor and
   * narrower at the top, and a superellipse cannot say that: `zRadius` applies
   * equally above and below the section's centre. Modelling it instead as two
   * intersecting lofts, which is what the 747's raised upper deck was, leaves
   * a crease where the two surfaces cross — 31 degrees of included angle on
   * that aeroplane, which reads as a second tube laid on the first.
   *
   * With this, the half-width stays `zRadius` over the whole lower half and
   * eases to `crownZRadius` by the crown, so the lower lobe is untouched and
   * the upper one leans in. The ramp is a smoothstep of the section's own
   * height, whose derivative is zero at both ends, so the taper does not
   * introduce a crease of its own at the equator while removing one higher up.
   *
   * Defaults to `zRadius`, where the arithmetic is the identity and every
   * existing loft is bit-identical.
   */
  readonly crownZRadius?: number;
  /**
   * Superellipse exponent of the UPPER half alone (above `yOffset`), where
   * `squareness` sets both. Below 2 it draws the upper half toward a V: the
   * flanks straighten and the shoulders come down and in, while the crown's
   * height, the half-width at the widest point and the lower half all stay.
   * That is a flight deck of flat windshield panes meeting at a centre post,
   * which an ellipse through the same crown and width stands proud of on
   * both shoulders.
   *
   * It must be above 1: the upper half stays tangent-continuous, horizontal
   * at the crown and vertical at the widest point, for any exponent above 1;
   * at 1 the crown is a ridge. Where it is absent the section is exactly what
   * it was, bit for bit.
   */
  readonly crownSquareness?: number;
}

export interface AirfoilWingOptions {
  readonly rootLeadingX: number;
  readonly rootTrailingX: number;
  readonly tipLeadingX: number;
  readonly tipTrailingX: number;
  readonly rootZ: number;
  readonly tipZ: number;
  /** Maximum section thickness as a fraction of local chord. */
  readonly thicknessRatio: number;
  /** Maximum camber as a fraction of local chord. */
  readonly camberRatio?: number;
  readonly chordSegments?: number;
  readonly spanSegments?: number;
}

interface VertexMeshOptions {
  readonly uvs?: readonly number[];
  readonly colors?: readonly number[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly castsShadow?: boolean;
  /**
   * Groups of vertex indices that sit at the SAME POINT and must share one
   * normal. See `weldNormals`.
   */
  readonly weldedNormals?: readonly (readonly number[])[];
}

export class AircraftBuildContext {
  readonly meshes: AbstractMesh[] = [];
  readonly materials: Material[] = [];
  readonly textures: BaseTexture[] = [];

  constructor(readonly scene: Scene) {
    // The translucent parts built below draw in their own group after the
    // water (see `finishMesh`); that group must inherit the opaque depth or
    // the canopy would draw over the fuselage behind it.
    keepOpaqueDepthForRenderingGroup(scene, AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID);
  }

  material(
    name: string,
    color: number,
    options: AircraftMaterialOptions = {},
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    prepareMaterialForClusteredLighting(material);
    material.albedoColor = color3(color);
    material.metallic = options.metallic ?? 0.08;
    material.roughness = options.roughness ?? 0.48;
    if (options.emissive !== undefined) {
      material.emissiveColor = color3(options.emissive);
      material.emissiveIntensity = options.emissiveIntensity ?? 1;
    }
    if (options.alpha !== undefined) material.alpha = options.alpha;
    if (options.alphaBlend || (options.alpha !== undefined && options.alpha < 1)) {
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      // The WebGPU frame graph supplies an explicit reactive/material mask;
      // glass alpha is no longer overloaded as a post-process classifier.
      //
      // The pre-pass WRITES DEPTH. That is what lets two-sided glass sort
      // against itself, and it is also why every mesh wearing this material
      // is moved behind the water in draw order (`finishMesh`): drawn before
      // the sea, the propeller disc's pre-pass depth cut the ocean out of the
      // whole lower frame in cockpit view and the seabed showed through.
      material.needDepthPrePass = true;
      material.backFaceCulling = false;
    }
    if (options.doubleSided) material.backFaceCulling = false;
    if (options.clearCoat) {
      material.clearCoat.isEnabled = true;
      material.clearCoat.intensity = options.clearCoat.intensity;
      material.clearCoat.roughness = options.clearCoat.roughness;
      material.clearCoat.indexOfRefraction = options.clearCoat.indexOfRefraction ?? 1.5;
    }
    if (options.transmission) {
      material.subSurface.isRefractionEnabled = true;
      material.subSurface.refractionIntensity = 1;
      material.subSurface.indexOfRefraction = options.transmission.indexOfRefraction;
      material.subSurface.volumeIndexOfRefraction = options.transmission.indexOfRefraction;
      material.subSurface.minimumThickness = options.transmission.minimumThickness;
      material.subSurface.maximumThickness = options.transmission.maximumThickness;
      material.subSurface.useThicknessAsDepth = true;
      material.subSurface.tintColor = color3(options.transmission.tintColor);
      material.subSurface.tintColorAtDistance = options.transmission.tintColorAtDistance;
      material.subSurface.linkRefractionWithTransparency = true;
      material.subSurface.useAlbedoToTintRefraction = true;
    }
    this.materials.push(material);
    return material;
  }

  /** Deterministic A-2 paint using the shared CPU-mip convention. */
  paintMaterial(name: string, recipe: AircraftPaintRecipe): PBRMaterial {
    const synthesis = synthesizeAircraftSurface(recipe);
    const textures = createAircraftSurfaceTextures(this.scene, name, synthesis);
    this.textures.push(textures.albedo, textures.normal, textures.metallicRoughness);
    textures.normal.level = 0.42;
    return this.dressPaint(name, textures.albedo, textures.normal, textures.metallicRoughness, {
      aircraftPaint: true,
      aircraftPaintFeatures: [...AIRCRAFT_PAINT_FEATURES],
      aircraftPaintRecipe: { ...recipe },
      aircraftPaintFeatureCoverage: { ...synthesis.featureCoverage },
    });
  }

  /**
   * `painted`'s paint under another albedo: its normal and metallic-roughness
   * maps are the SAME texture objects, not copies, and `albedo` becomes this
   * context's to dispose.
   *
   * Not `painted.clone()`. `PBRMaterial.clone` clones every texture, and a
   * cloned RawTexture comes back with the defaults: the normal map's 0.42 level
   * became 1 (surface tilt p95 7.5 deg -> 17.3 deg), WRAP became CLAMP and
   * anisotropy 8 became 4. Each clone also allocated a GPU texture that nothing
   * owned, and neither the clone nor its textures were in `materials` or
   * `textures`, so disposing the aircraft left them all behind.
   */
  repaintMaterial(name: string, painted: PBRMaterial, albedo: BaseTexture): PBRMaterial {
    const { bumpTexture, metallicTexture } = painted;
    if (!bumpTexture || !metallicTexture) {
      throw new Error(`${painted.name} has no normal or metallic-roughness map to share; is it a paintMaterial?`);
    }
    this.textures.push(albedo);
    return this.dressPaint(name, albedo, bumpTexture, metallicTexture, {
      ...(painted.metadata as Record<string, unknown> | null),
    });
  }

  /**
   * A recipe's RELIEF under a livery's COLOUR: the recipe's own normal and
   * metallic-roughness maps, and `albedo` in place of its albedo, which is
   * never uploaded. For a surface that needs different relief from the part
   * of the airframe `repaintMaterial` would share it with -- the Global's
   * fuselage, where the body recipe's grid, soot and filler are stretched to
   * half-metre smears the wings do not have. `albedo` becomes this context's
   * to dispose.
   */
  liveryPaintMaterial(name: string, recipe: AircraftPaintRecipe, albedo: BaseTexture): PBRMaterial {
    const synthesis = synthesizeAircraftSurface(recipe);
    const relief = createAircraftReliefTextures(this.scene, name, synthesis);
    this.textures.push(albedo, relief.normal, relief.metallicRoughness);
    relief.normal.level = 0.42;
    return this.dressPaint(name, albedo, relief.normal, relief.metallicRoughness, {
      aircraftPaint: true,
      aircraftPaintFeatures: [...AIRCRAFT_PAINT_FEATURES],
      aircraftPaintRecipe: { ...recipe },
      aircraftPaintFeatureCoverage: { ...synthesis.featureCoverage },
    });
  }

  /** The one construction `paintMaterial`, `repaintMaterial` and `liveryPaintMaterial` share. */
  private dressPaint(
    name: string,
    albedo: BaseTexture,
    normal: BaseTexture,
    metallicRoughness: BaseTexture,
    metadata: Record<string, unknown>,
  ): PBRMaterial {
    const material = this.material(name, 0xffffff, { roughness: 1, metallic: 1 });
    material.albedoTexture = albedo;
    material.bumpTexture = normal;
    material.metallicTexture = metallicRoughness;
    material.useAmbientOcclusionFromMetallicTextureRed = true;
    material.useRoughnessFromMetallicTextureAlpha = false;
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    material.metadata = {
      ...(material.metadata as Record<string, unknown> | null),
      ...metadata,
    };
    return material;
  }

  box(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateBox(name, { width, height, depth }, this.scene),
      material,
      parent,
    );
  }

  cylinder(
    name: string,
    height: number,
    diameterTop: number,
    diameterBottom: number,
    tessellation: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateCylinder(
        name,
        { height, diameterTop, diameterBottom, tessellation },
        this.scene,
      ),
      material,
      parent,
    );
  }

  sphere(
    name: string,
    diameter: number,
    segments: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateSphere(name, { diameter, segments }, this.scene),
      material,
      parent,
    );
  }

  torus(
    name: string,
    diameter: number,
    thickness: number,
    tessellation: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const result = this.finishMesh(
      CreateTorus(name, { diameter, thickness, tessellation }, this.scene),
      material,
      parent,
    );
    // Babylon's torus is centred around the Y axis. Aircraft wheels rotate
    // around body +Z, so put the ring in the local X/Y plane.
    result.rotation.x = Math.PI / 2;
    return result;
  }

  planform(
    name: string,
    outline: readonly PlanformPoint[],
    thickness: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (outline.length < 3) throw new RangeError("A planform needs at least three points");
    const halfThickness = thickness * 0.5;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const y of [halfThickness, -halfThickness]) {
      for (const point of outline) positions.push(point.x, y, point.z);
    }
    appendExtrudedIndices(indices, outline.length);
    const uvs = planarUvs(positions, 0, 2);
    return this.vertexMesh(name, positions, indices, material, parent, { uvs });
  }

  /**
   * A thin panel whose TOP FACE IS A GIVEN PATCH OF SOME OTHER SURFACE, handed
   * in as a grid of points, and whose bottom face is that patch dropped by a
   * constant thickness.
   *
   * WHY A GRID AND NOT A BOX. A spoiler, an airbrake or an access panel lies
   * IN the skin of something curved. Drawing it as a box and choosing one
   * height for the whole box can only be right at one station: on a wing with
   * dihedral, taper and a thickness that follows the local chord, every other
   * station is wrong by however much the skin moved. On the 747 that error ran
   * from 44 mm at the inboard panel to 288 mm at the outboard one, and the
   * panels read as plates hovering over the wing with daylight beneath them.
   *
   * Handing in the grid moves the surface law to the caller, who is the only
   * one who knows it, and leaves this method the parts that are the same for
   * every such panel: topology, rim, winding and normals. The caller evaluates
   * the skin AT EACH OF THE PANEL'S OWN VERTICES, so dihedral and twist are
   * absorbed by construction rather than corrected for afterwards.
   *
   * Each patch is `[span][chord]` points in the parent's frame. SEVERAL PATCHES
   * GO IN ONE MESH because panels that share a hinge line share a draw call:
   * the 747's four outboard spoilers all lie on the 54.5% chord line of the
   * same wing panel, so they turn together about one axis and there is no
   * reason for them to be four meshes. Six panels a side cost four draws, not
   * twelve.
   *
   * Winding is taken from the patch rather than required of it: the first
   * quad's normal decides which way round the triangles go, so a panel
   * mirrored to the other wing — whose grid runs the opposite way in z — comes
   * out facing the same way without the call site having to know it is the
   * mirrored one.
   */
  conformedPanels(
    name: string,
    patches: readonly SurfacePatch[],
    thickness: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (patches.length === 0) throw new RangeError("A conformed panel mesh needs at least one patch");
    if (!(thickness > 0)) throw new RangeError("A conformed panel needs a positive thickness");
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (const grid of patches) {
      this.appendConformedPatch(grid, thickness, positions, uvs, indices);
    }
    return this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
      metadata: { aircraftGeometry: "conformed-panel", patches: patches.length },
    });
  }

  private appendConformedPatch(
    grid: SurfacePatch,
    thickness: number,
    positions: number[],
    uvs: number[],
    indices: number[],
  ): void {
    const base = positions.length / 3;
    const spanRows = grid.length;
    if (spanRows < 2) throw new RangeError("A conformed panel needs at least two span rows");
    const chordColumns = grid[0]!.length;
    if (chordColumns < 2) throw new RangeError("A conformed panel needs at least two chord columns");
    for (const row of grid) {
      if (row.length !== chordColumns) {
        throw new RangeError("A conformed panel's span rows must all be the same length");
      }
    }

    for (const face of [0, 1]) {
      for (let span = 0; span < spanRows; span += 1) {
        for (let chord = 0; chord < chordColumns; chord += 1) {
          const point = grid[span]![chord]!;
          positions.push(point.x, point.y - face * thickness, point.z);
          uvs.push(chord / (chordColumns - 1), span / (spanRows - 1));
        }
      }
    }

    // Which way the first quad turns, so the top face ends up facing up on
    // both wings. Cross the chordwise edge into the spanwise one; if that
    // points down, the grid runs the other way round and every triangle below
    // is emitted reversed.
    const a0 = grid[0]![0]!;
    const alongChord = { x: grid[0]![1]!.x - a0.x, y: grid[0]![1]!.y - a0.y, z: grid[0]![1]!.z - a0.z };
    const alongSpan = { x: grid[1]![0]!.x - a0.x, y: grid[1]![0]!.y - a0.y, z: grid[1]![0]!.z - a0.z };
    const upward = alongChord.z * alongSpan.x - alongChord.x * alongSpan.z;
    if (upward === 0) throw new RangeError("A conformed panel's first quad is degenerate");
    // INVERTED, because `upward` is the mathematical right-handed cross product
    // and Babylon's RH mesh winding is its inverse — the same reversal
    // `airfoilWing` applies to its whole index buffer at the end.
    const flipped = upward > 0;
    const quad = (p: number, q: number, r: number, s: number): void => {
      if (flipped) indices.push(base + p, base + r, base + q, base + q, base + r, base + s);
      else indices.push(base + p, base + q, base + r, base + q, base + s, base + r);
    };

    const underside = spanRows * chordColumns;
    for (let span = 0; span < spanRows - 1; span += 1) {
      for (let chord = 0; chord < chordColumns - 1; chord += 1) {
        const corner = span * chordColumns + chord;
        quad(corner, corner + 1, corner + chordColumns, corner + chordColumns + 1);
        quad(
          underside + corner + 1,
          underside + corner,
          underside + corner + chordColumns + 1,
          underside + corner + chordColumns,
        );
      }
    }

    // The rim, walked as one boundary loop of the top face and stitched to the
    // matching vertex of the bottom one. Walking a loop rather than doing four
    // separate edges is what keeps the corners closed.
    const loop: number[] = [];
    for (let chord = 0; chord < chordColumns; chord += 1) loop.push(chord);
    for (let span = 1; span < spanRows; span += 1) loop.push(span * chordColumns + chordColumns - 1);
    for (let chord = chordColumns - 2; chord >= 0; chord -= 1) {
      loop.push((spanRows - 1) * chordColumns + chord);
    }
    for (let span = spanRows - 2; span >= 1; span -= 1) loop.push(span * chordColumns);
    for (let step = 0; step < loop.length; step += 1) {
      const here = loop[step]!;
      const next = loop[(step + 1) % loop.length]!;
      quad(next, here, underside + next, underside + here);
    }

  }

  /**
   * A plate laid ON a curved skin: a grid of skin points, each moved `proud`
   * out along its own skin normal for the outer face and `depth` in for the
   * inner one, with a rim closing the edge.
   *
   * `conformedPanels` cannot do this. It drops its underside straight down in
   * y and takes its winding from the first quad's y-facing component, which is
   * right for a wing and zero on a near-vertical flank. A pane on a nose needs
   * both faces parallel to the skin whichever way the skin faces.
   *
   * WINDING BY GEOMETRY, TRIANGLE BY TRIANGLE: every triangle is emitted so
   * its cross product points INTO the solid, the convention Babylon draws in
   * this right-handed scene (`solidPlate` measured it on a `box`), and the
   * direction into the solid is KNOWN here rather than guessed: against the
   * normal on the outer face, along it on the inner one, and toward the
   * neighbouring interior grid point on the rim. A centroid test, which
   * `solidified` uses, is wrong for a curved plate: the centroid of a pane
   * that wraps a nose lies inside the body, beyond the inner face, so the
   * inner face -- the one the cockpit looks through -- would come out culled.
   *
   * Faces share vertices, so their normals come out smooth; the rim has its
   * own. UVs are the grid's 0..1 on both faces.
   */
  skinPanel(
    name: string,
    points: SurfacePatch,
    normals: SurfacePatch,
    proud: number,
    depth: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const rows = points.length;
    const columns = points[0]?.length ?? 0;
    if (rows < 2 || columns < 2) throw new RangeError("A skin panel needs at least a 2 x 2 grid");
    if (normals.length !== rows || [...points, ...normals].some((row) => row.length !== columns)) {
      throw new RangeError("A skin panel's points and normals must be the same rectangular grid");
    }
    if (!(proud >= 0) || !(depth >= 0) || !(proud + depth > 0)) {
      throw new RangeError("A skin panel needs a non-negative proud and depth with a positive total");
    }
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const offset = (row: number, column: number, distance: number): SurfacePoint => {
      const point = points[row]![column]!;
      const normal = normals[row]![column]!;
      return { x: point.x + normal.x * distance, y: point.y + normal.y * distance, z: point.z + normal.z * distance };
    };
    const vertex = (at: SurfacePoint, row: number, column: number): number => {
      positions.push(at.x, at.y, at.z);
      uvs.push(column / (columns - 1), row / (rows - 1));
      return positions.length / 3 - 1;
    };
    const at = (index: number): SurfacePoint => ({
      x: positions[index * 3]!, y: positions[index * 3 + 1]!, z: positions[index * 3 + 2]!,
    });
    // One triangle, turned so its cross product points along `into`.
    const triangle = (a: number, b: number, c: number, into: SurfacePoint): void => {
      const pa = at(a);
      const pb = at(b);
      const pc = at(c);
      const e1 = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
      const e2 = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
      const cross = {
        x: e1.y * e2.z - e1.z * e2.y,
        y: e1.z * e2.x - e1.x * e2.z,
        z: e1.x * e2.y - e1.y * e2.x,
      };
      const facing = cross.x * into.x + cross.y * into.y + cross.z * into.z;
      if (facing === 0) throw new RangeError(`skin panel "${name}": a degenerate triangle`);
      if (facing > 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    };
    const negate = (v: SurfacePoint): SurfacePoint => ({ x: -v.x, y: -v.y, z: -v.z });
    const mean = (...vs: SurfacePoint[]): SurfacePoint => ({
      x: vs.reduce((s, v) => s + v.x, 0) / vs.length,
      y: vs.reduce((s, v) => s + v.y, 0) / vs.length,
      z: vs.reduce((s, v) => s + v.z, 0) / vs.length,
    });

    const outer: number[] = [];
    const inner: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        outer.push(vertex(offset(row, column, proud), row, column));
      }
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        inner.push(vertex(offset(row, column, -depth), row, column));
      }
    }
    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < columns - 1; column += 1) {
        const k = row * columns + column;
        const corners = [k, k + 1, k + columns, k + columns + 1];
        const normal = mean(...corners.map((c) => normals[Math.floor(c / columns)]![c % columns]!));
        // Outer face: the solid is inward, against the normal. Inner: along it.
        triangle(outer[k]!, outer[k + 1]!, outer[k + columns]!, negate(normal));
        triangle(outer[k + 1]!, outer[k + columns + 1]!, outer[k + columns]!, negate(normal));
        triangle(inner[k]!, inner[k + 1]!, inner[k + columns]!, normal);
        triangle(inner[k + 1]!, inner[k + columns + 1]!, inner[k + columns]!, normal);
      }
    }

    // The rim: each boundary edge as its own quad, facing away from the grid
    // point next to it on the inside, so the corners close whatever the order.
    const edges: Array<[number, number, number, number]> = [];
    for (let column = 0; column < columns - 1; column += 1) {
      edges.push([0, column, 0, column + 1]);
      edges.push([rows - 1, column, rows - 1, column + 1]);
    }
    for (let row = 0; row < rows - 1; row += 1) {
      edges.push([row, 0, row + 1, 0]);
      edges.push([row, columns - 1, row + 1, columns - 1]);
    }
    for (const [r0, c0, r1, c1] of edges) {
      // The solid is on the pane's side of its own edge: toward the grid point
      // one step in from the edge.
      const inwardRow = r0 === r1 ? (r0 === 0 ? 1 : rows - 2) : r0;
      const inwardColumn = c0 === c1 ? (c0 === 0 ? 1 : columns - 2) : c0;
      const inwardPoint = points[inwardRow]![inwardColumn]!;
      const midpoint = mean(points[r0]![c0]!, points[r1]![c1]!);
      const into = {
        x: inwardPoint.x - midpoint.x, y: inwardPoint.y - midpoint.y, z: inwardPoint.z - midpoint.z,
      };
      const a = vertex(offset(r0, c0, proud), r0, c0);
      const b = vertex(offset(r1, c1, proud), r1, c1);
      const c = vertex(offset(r0, c0, -depth), r0, c0);
      const d = vertex(offset(r1, c1, -depth), r1, c1);
      triangle(a, b, c, into);
      triangle(b, d, c, into);
    }
    return this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
      metadata: { aircraftGeometry: "skin-panel", grid: [rows, columns] },
    });
  }

  verticalProfile(
    name: string,
    outline: readonly VerticalProfilePoint[],
    thickness: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (outline.length < 3) throw new RangeError("A vertical profile needs at least three points");
    const halfThickness = thickness * 0.5;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const z of [halfThickness, -halfThickness]) {
      for (const point of outline) positions.push(point.x, point.y, z);
    }
    appendExtrudedIndices(indices, outline.length);
    const uvs = planarUvs(positions, 0, 1);
    return this.vertexMesh(name, positions, indices, material, parent, { uvs });
  }

  /**
   * Elliptical cross-sections joined along body +X; never a scaled cylinder.
   *
   * `stationRange` makes several lofts share ONE station parametrisation, so a
   * texture's u does not step where they meet. It shares u ONLY: v stays each
   * loft's own phase, and one phase is a different height on two section
   * tables, so a caller that needs v to mean a height must re-solve it (the
   * 747's radome does, `radomeLiveryPhase`).
   *
   * Without it each loft normalises u over its OWN first and last section: the
   * airliner's fuselage (x -26..30.6) and nose (x 25.5..34) disagree by 0.40
   * of the texture width at x = 30.6, and by about 0.7 where their surfaces
   * cross at band height. That is why the cheatline was body-space vertex paint
   * rather than a texture: a function of world x and y crosses a join without
   * knowing it is there, and a per-loft u does not.
   *
   * IT IS UV1, NOT A SECOND SET, and the reason is the fragment-input budget.
   * WebGPU counts 16 inputs, `front_facing` among them, and the clustered
   * light container every flight builds costs each lit material one more. A
   * second UV set is another: on the airliner's fuselage it measured 15 in
   * Gate A's container-less rig, 16 of 16 live -- no headroom -- where UV1
   * alone keeps the skin at 14 (15 live), the same as every other airframe's
   * paint. A second UV set AND a colour channel was 17 live, and the device
   * refused the pipeline.
   *
   * The cost of sharing UV1 falls on the paint synthesis, which tiles on UV1
   * and WRAPS: its panel lines now repeat over the shared range rather than
   * each loft's own. On the fuselage that is 60 m instead of 56.6 (5.7 %
   * longer, invisible); on the radome it is 60 m instead of its own 8.5, which
   * is a FIX, not a cost -- per-loft UV packed the fuselage's whole panel
   * pattern into the nose and drew its panel lines about 6.7x denser than the
   * fuselage's. One range gives the whole body one panel scale.
   *
   * OMIT IT and nothing changes: u is the loft's own, and the caps keep their
   * literal 0 and 1, so every other loft's positions, indices and UVs stay byte
   * for byte what they were -- by construction, not by float arithmetic
   * happening to agree.
   */
  loft(
    name: string,
    sections: readonly LoftSection[],
    radialSegments: number,
    material: Material,
    parent: TransformNode,
    stationRange?: { readonly minimumX: number; readonly length: number },
  ): Mesh {
    if (sections.length < 2) throw new RangeError("An aircraft loft needs at least two sections");
    if (!Number.isInteger(radialSegments) || radialSegments < 8) {
      throw new RangeError("An aircraft loft needs at least eight radial segments");
    }
    for (let index = 1; index < sections.length; index += 1) {
      if (!(sections[index]!.x > sections[index - 1]!.x)) {
        throw new RangeError("Aircraft loft sections must be strictly ordered along +X");
      }
    }
    const ringSize = radialSegments + 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const minimumX = sections[0]!.x;
    const length = sections[sections.length - 1]!.x - minimumX;
    // u is measured over the shared station range when one is given, so every
    // loft passing the same range agrees on u at every station; otherwise over
    // this loft's own sections, exactly as before.
    const uMinimumX = stationRange?.minimumX ?? minimumX;
    const uLength = stationRange?.length ?? length;
    if (stationRange && !(Number.isFinite(uMinimumX) && Number.isFinite(uLength) && uLength > 0)) {
      throw new RangeError("An aircraft loft's station range must be finite with positive length");
    }
    for (const section of sections) {
      if (!(section.yRadius > 0) || !(section.zRadius > 0)) {
        throw new RangeError("Aircraft loft radii must be positive");
      }
      const squareness = section.squareness ?? 2;
      if (!(squareness >= 2)) {
        throw new RangeError("Aircraft loft squareness must be at least 2");
      }
      const crownZRadius = section.crownZRadius ?? section.zRadius;
      if (!(crownZRadius > 0)) {
        throw new RangeError("Aircraft loft crown radius must be positive");
      }
      if (section.crownSquareness !== undefined && !(section.crownSquareness > 1)) {
        throw new RangeError("Aircraft loft crown squareness must be above 1");
      }
      const shapeExponent = 2 / squareness;
      const crownExponent = section.crownSquareness === undefined ? shapeExponent : 2 / section.crownSquareness;
      for (let radial = 0; radial <= radialSegments; radial += 1) {
        const phase = radial / radialSegments;
        const angle = phase * Math.PI * 2;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        // Superellipse: |cos|^(2/n)·sign(cos). At n = 2 this is exactly the
        // ellipse the pre-fix-pack loft produced. The upper half (cos > 0)
        // takes `crownSquareness` when there is one.
        const exponent = cosine > 0 ? crownExponent : shapeExponent;
        const yShape = Math.sign(cosine) * Math.abs(cosine) ** exponent;
        const zShape = Math.sign(sine) * Math.abs(sine) ** exponent;
        // The crown taper: nothing on the lower half, easing to
        // `crownZRadius` by the top. `rise` is 0 at and below the equator and
        // 1 at the crown; the smoothstep gives it zero slope at both ends, so
        // the widest point stays tangent-continuous.
        const rise = Math.max(0, yShape);
        const lift = rise * rise * (3 - 2 * rise);
        const halfWidth = section.zRadius + (crownZRadius - section.zRadius) * lift;
        positions.push(
          section.x,
          (section.yOffset ?? 0) + yShape * section.yRadius,
          (section.zOffset ?? 0) + zShape * halfWidth,
        );
        uvs.push((section.x - uMinimumX) / uLength, phase);
      }
    }
    for (let section = 0; section < sections.length - 1; section += 1) {
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const a = section * ringSize + radial;
        const b = a + 1;
        const c = a + ringSize;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const startCenter = positions.length / 3;
    const start = sections[0]!;
    positions.push(start.x, start.yOffset ?? 0, start.zOffset ?? 0);
    // The caps are vertices too, and must sit on the shared range with the
    // rings; without one they keep their literal 0 and 1.
    uvs.push(stationRange ? (start.x - uMinimumX) / uLength : 0, 0.5);
    const endCenter = positions.length / 3;
    const end = sections[sections.length - 1]!;
    positions.push(end.x, end.yOffset ?? 0, end.zOffset ?? 0);
    uvs.push(stationRange ? (end.x - uMinimumX) / uLength : 1, 0.5);
    const endRing = (sections.length - 1) * ringSize;
    for (let radial = 0; radial < radialSegments; radial += 1) {
      indices.push(startCenter, radial + 1, radial);
      indices.push(endCenter, endRing + radial, endRing + radial + 1);
    }
    reverseTriangleWinding(indices);
    // THE RING CLOSES AT THE CROWN. `angle` starts at 0, where the superellipse
    // is (yShape 1, zShape 0) — the top centreline — so radial 0 and radial
    // `radialSegments` are the same point on every section, repeated only so
    // the UV can run 0..1 round the section. Nothing is duplicated at the keel:
    // that is the single vertex at angle pi, and with an odd `radialSegments`
    // there is no vertex exactly there at all.
    //
    // Their normals are welded because the surface is SMOOTH across that seam
    // and was not being shaded as though it were.
    const crownSeam: number[][] = [];
    for (let section = 0; section < sections.length; section += 1) {
      crownSeam.push([section * ringSize, section * ringSize + radialSegments]);
    }
    return this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
      weldedNormals: crownSeam,
      metadata: {
        aircraftGeometry: "lofted-fuselage",
        loftSectionCount: sections.length,
        radialSegments,
        capped: true,
      },
    });
  }

  /**
   * A closed NACA-like wing volume whose section thickness follows chord.
   * Separate calls for port/starboard and controls leave real physical gaps.
   */
  airfoilWing(
    name: string,
    options: AirfoilWingOptions,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const chordSegments = options.chordSegments ?? 12;
    const spanSegments = options.spanSegments ?? 2;
    if (!Number.isInteger(chordSegments) || chordSegments < 6) {
      throw new RangeError("An aircraft airfoil needs at least six chord segments");
    }
    if (!Number.isInteger(spanSegments) || spanSegments < 1) {
      throw new RangeError("An aircraft airfoil needs at least one span segment");
    }
    if (!(options.thicknessRatio > 0 && options.thicknessRatio < 0.3)) {
      throw new RangeError("Aircraft airfoil thickness ratio must be in (0, 0.3)");
    }
    const camberRatio = options.camberRatio ?? 0;
    const rowSize = chordSegments + 1;
    const surfaceSize = (spanSegments + 1) * rowSize;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (const side of [1, -1] as const) {
      for (let span = 0; span <= spanSegments; span += 1) {
        const spanT = span / spanSegments;
        const leadingX = mixNumber(options.rootLeadingX, options.tipLeadingX, spanT);
        const trailingX = mixNumber(options.rootTrailingX, options.tipTrailingX, spanT);
        const chord = leadingX - trailingX;
        if (!(chord > 0)) throw new RangeError("Aircraft airfoil leading edge must be ahead of trailing edge");
        const z = mixNumber(options.rootZ, options.tipZ, spanT);
        for (let chordIndex = 0; chordIndex <= chordSegments; chordIndex += 1) {
          const chordT = chordIndex / chordSegments;
          const x = leadingX - chordT * chord;
          const thickness = nacaThickness(chordT, options.thicknessRatio) * chord;
          const camber = 4 * camberRatio * chordT * (1 - chordT) * chord;
          positions.push(x, camber + side * thickness, z);
          uvs.push(chordT, spanT);
        }
      }
    }
    const portward = options.tipZ > options.rootZ;
    for (let surface = 0; surface < 2; surface += 1) {
      const offset = surface * surfaceSize;
      const top = surface === 0;
      for (let span = 0; span < spanSegments; span += 1) {
        for (let chord = 0; chord < chordSegments; chord += 1) {
          const a = offset + span * rowSize + chord;
          const b = a + 1;
          const c = a + rowSize;
          const d = c + 1;
          const naturalWinding = top === portward;
          if (naturalWinding) indices.push(a, b, c, b, d, c);
          else indices.push(a, c, b, b, c, d);
        }
      }
    }
    // Close leading edge, trailing edge, root and tip. The duplicated top and
    // bottom vertices keep their smooth airfoil normals instead of averaging
    // across the sharp trailing seam.
    appendAirfoilEdge(indices, 0, surfaceSize, rowSize, spanSegments, true, portward);
    appendAirfoilEdge(
      indices,
      chordSegments,
      surfaceSize + chordSegments,
      rowSize,
      spanSegments,
      false,
      portward,
    );
    appendAirfoilCap(indices, 0, surfaceSize, rowSize, chordSegments, true, portward);
    appendAirfoilCap(
      indices,
      spanSegments * rowSize,
      surfaceSize + spanSegments * rowSize,
      rowSize,
      chordSegments,
      false,
      portward,
    );
    // The construction above uses mathematical RH counter-clockwise winding;
    // Babylon's RH mesh/ComputeNormals convention is the inverse.
    reverseTriangleWinding(indices);
    return this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
      metadata: {
        aircraftGeometry: "airfoil-wing",
        airfoilThicknessRatio: options.thicknessRatio,
        airfoilCamberRatio: camberRatio,
        chordSegments,
        spanSegments,
      },
    });
  }

  /** A radial-opacity propeller blur disc in the local Y/Z plane. */
  radialBlurDisc(
    name: string,
    radius: number,
    segments: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (!(radius > 0) || !Number.isInteger(segments) || segments < 16) {
      throw new RangeError("A propeller blur disc needs a positive radius and >=16 segments");
    }
    const radialFractions = [0, 0.18, 0.62, 0.9, 1] as const;
    const radialAlpha = [0, 0.18, 0.62, 0.34, 0] as const;
    const ringSize = segments + 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let ring = 0; ring < radialFractions.length; ring += 1) {
      for (let segment = 0; segment <= segments; segment += 1) {
        const phase = segment / segments;
        const angle = phase * Math.PI * 2;
        const radial = radialFractions[ring]!;
        positions.push(0, Math.cos(angle) * radius * radial, Math.sin(angle) * radius * radial);
        uvs.push(0.5 + Math.cos(angle) * radial * 0.5, 0.5 + Math.sin(angle) * radial * 0.5);
        const alpha = radialAlpha[ring]! * (0.9 + 0.1 * Math.cos(angle * 2));
        colors.push(0.8, 0.84, 0.86, alpha);
      }
    }
    for (let ring = 0; ring < radialFractions.length - 1; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const a = ring * ringSize + segment;
        const b = a + 1;
        const c = a + ringSize;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const mesh = this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
      colors,
      castsShadow: false,
      metadata: { aircraftGeometry: "radial-propeller-blur" },
    });
    mesh.hasVertexAlpha = true;
    return mesh;
  }

  strutBetween(
    name: string,
    from: Vector3,
    to: Vector3,
    radius: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const direction = to.subtract(from);
    const length = direction.length();
    if (!Number.isFinite(length) || length < 1e-6) {
      throw new RangeError("Aircraft strut endpoints must be distinct and finite");
    }
    const strut = this.cylinder(
      name,
      length,
      radius * 2,
      radius * 2.16,
      8,
      material,
      parent,
    );
    strut.position.copyFrom(from.add(to).scale(0.5));
    strut.rotationQuaternion = Quaternion.FromUnitVectorsToRef(
      Vector3.UpReadOnly,
      direction.scale(1 / length),
      new Quaternion(),
    );
    return strut;
  }

  /**
   * Fold parts that never move relative to `parent` into ONE mesh, so they
   * cost one draw instead of one each.
   *
   * A draw is paid per MESH, and a shadow caster pays it three times a frame
   * (the colour pass and both sun cascades). The 747 measured +0.70 ms of CPU
   * against the Cessna for +2% triangles, which is that and nothing else: 141
   * meshes, most of them bolted rigidly to the same root. Geometry that shares
   * a material and never moves apart has no reason to be more than one mesh.
   *
   * It REFUSES rather than guesses, because every way this goes wrong is
   * silent — a merged mesh renders something, just not the right thing:
   *
   *  - A source may hang only from `parent`, or from nodes the caller lists in
   *    `staticNodes`. A hinge, its `-frame`, a rudder `-mount`, a fan spool or
   *    the gear node is none of those, so an animated part cannot be folded in
   *    by accident: it would be baked at its rest pose and stop moving.
   *  - Every source must agree on material, layer mask, rendering group,
   *    visibility and whether it casts a shadow. One mesh has one of each, so
   *    a mismatch would quietly change how some of the parts are drawn — the
   *    cockpit-excluded skin bit is a layer mask, glass is a rendering group.
   *  - No thin instances: `MergeMeshes` reads the base geometry and drops the
   *    instance buffer, so 228 windows would come back as one.
   *  - One vertex layout. Babylon throws on a mismatch; this says which part.
   *
   * `MergeMeshes` bakes each source's WORLD matrix into its vertices, so the
   * result is carried back into `parent`'s frame before it is parented. At
   * build time that is the identity on every airframe, and it is done anyway
   * so the helper does not depend on when it is called.
   *
   * The sources are disposed and LEAVE `meshes`; the result joins it through
   * `finishMesh` like any built part and records the names it was folded from
   * in `metadata.mergedFrom`, so a part can still be followed by name. Metadata
   * every source agrees on is kept; per-part geometry notes are not, since no
   * one value would be true of the whole. Nodes in `staticNodes` that are left
   * childless are disposed with them.
   *
   * What it CANNOT do is update lists the caller holds. A source that was in
   * `cockpitParts` or `wingSurfaces` is a disposed mesh there now, and the
   * result has to be put in its place by whoever owns the list.
   */
  mergeStatic(
    name: string,
    sources: readonly AbstractMesh[],
    parent: TransformNode,
    options: { readonly staticNodes?: readonly TransformNode[] } = {},
  ): Mesh {
    if (sources.length < 2) {
      throw new RangeError(`Merging "${name}" needs at least two parts`);
    }
    const staticNodes = new Set<unknown>(options.staticNodes ?? []);
    const parts: Mesh[] = [];
    for (const source of sources) {
      if (!(source instanceof Mesh)) {
        throw new Error(`Cannot merge "${source.name}" into "${name}": it is not a Mesh`);
      }
      parts.push(source);
    }
    const first = parts[0]!;
    const layout = (mesh: Mesh) => [...mesh.getVerticesDataKinds()].sort().join(",");
    const shadow = (mesh: Mesh) =>
      (mesh.metadata as { castsShadow?: boolean } | null)?.castsShadow !== false;
    for (const [position, source] of parts.entries()) {
      const refuse = (why: string): never => {
        throw new Error(`Cannot merge "${source.name}" into "${name}": ${why}`);
      };
      if (parts.indexOf(source) !== position) refuse("it is listed twice");
      if (source.isDisposed() || !this.meshes.includes(source)) {
        refuse("this build does not own it");
      }
      if (source.hasThinInstances || source.instances.length > 0) {
        refuse("it is instanced, and a merge keeps only the base geometry");
      }
      if (source.getChildren().length > 0) refuse("it has children, which would be disposed");
      for (let walk = source.parent; walk !== parent; walk = walk.parent) {
        if (!walk) return refuse(`it does not hang from "${parent.name}"`);
        if (!staticNodes.has(walk)) {
          refuse(`it hangs from "${walk.name}", which was not declared static`);
        }
      }
      if (source.material !== first.material) refuse("its material differs");
      if (source.layerMask !== first.layerMask) refuse("its layer mask differs");
      if (source.renderingGroupId !== first.renderingGroupId) {
        refuse("its rendering group differs");
      }
      if (source.isVisible !== first.isVisible || source.isEnabled() !== first.isEnabled()) {
        refuse("its visibility differs");
      }
      if (source.hasVertexAlpha !== first.hasVertexAlpha) refuse("its vertex alpha differs");
      if (shadow(source) !== shadow(first)) refuse("it disagrees about casting a shadow");
      if (layout(source) !== layout(first)) {
        refuse(`its vertex layout is [${layout(source)}], not [${layout(first)}]`);
      }
    }
    const material = first.material;
    if (!material) throw new Error(`Cannot merge "${name}": its parts have no material`);

    // Read everything off the sources BEFORE the merge disposes them.
    const layerMask = first.layerMask;
    const renderingGroupId = first.renderingGroupId;
    const mergedFrom = parts.map((part) => part.name);
    const agreed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      (first.metadata as Record<string, unknown> | null) ?? {},
    )) {
      const primitive = value === null || typeof value !== "object";
      if (primitive && parts.every(
        (part) => (part.metadata as Record<string, unknown> | null)?.[key] === value,
      )) agreed[key] = value;
    }

    const target = new Mesh(name, this.scene);
    const merged = Mesh.MergeMeshes(parts, true, false, target);
    if (!merged) {
      // Babylon declines before it disposes anything, so the sources are
      // intact and only the empty target needs taking back out of the scene.
      target.dispose();
      throw new Error(`Babylon declined to merge "${name}"`);
    }
    for (const part of parts) {
      const index = this.meshes.indexOf(part);
      if (index >= 0) this.meshes.splice(index, 1);
    }
    const intoParent = parent.computeWorldMatrix(true).clone().invert();
    if (!intoParent.isIdentity()) merged.bakeTransformIntoVertices(intoParent);
    merged.refreshBoundingInfo();
    for (const candidate of options.staticNodes ?? []) {
      if (candidate.getChildren().length === 0) candidate.dispose();
    }

    const finished = this.finishMesh(merged, material, parent);
    finished.layerMask = layerMask;
    finished.renderingGroupId = renderingGroupId;
    finished.metadata = {
      ...(finished.metadata as Record<string, unknown> | null),
      ...agreed,
      mergedFrom,
    };
    return finished;
  }

  disposeMaterials(): void {
    for (const material of this.materials) material.dispose(false, false);
    this.materials.length = 0;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
  }

  private vertexMesh(
    name: string,
    positions: number[],
    indices: number[],
    material: Material,
    parent: TransformNode,
    options: VertexMeshOptions = {},
  ): Mesh {
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    if (options.weldedNormals) weldNormals(normals, options.weldedNormals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    if (options.uvs) vertexData.uvs = [...options.uvs];
    if (options.colors) vertexData.colors = [...options.colors];
    const mesh = new Mesh(name, this.scene);
    vertexData.applyToMesh(mesh, false);
    mesh.refreshBoundingInfo();
    const finished = this.finishMesh(mesh, material, parent);
    finished.metadata = {
      ...(finished.metadata as Record<string, unknown> | null),
      ...options.metadata,
      castsShadow: options.castsShadow ?? true,
    };
    return finished;
  }

  private finishMesh(mesh: Mesh, material: Material, parent: TransformNode): Mesh {
    mesh.material = material;
    if (isAlphaBlendedAirframeMaterial(material)) {
      // Composited AFTER the water, never before it: see the material
      // builder's note on the depth pre-pass, and `core/RenderingGroups.ts`.
      mesh.renderingGroupId = AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID;
    }
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.metadata = {
      ...(mesh.metadata as Record<string, unknown> | null),
      aircraftVisual: true,
      castsShadow: true,
    };
    this.meshes.push(mesh);
    return mesh;
  }
}

/** The materials `material()` puts in the alpha-blend bucket, and only those. */
export function isAlphaBlendedAirframeMaterial(material: Material): boolean {
  return material instanceof PBRMaterial
    && material.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHABLEND;
}

function color3(color: number): Color3 {
  return Color3.FromInts(
    (color >>> 16) & 0xff,
    (color >>> 8) & 0xff,
    color & 0xff,
  );
}

function appendExtrudedIndices(indices: number[], count: number): void {
  for (let index = 1; index < count - 1; index += 1) {
    indices.push(0, index, index + 1);
    indices.push(count, count + index + 1, count + index);
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, count + next, index, count + next, count + index);
  }
}

/**
 * Gives vertices that sit at the same point ONE normal, by averaging theirs.
 *
 * WHY THIS IS NEEDED. A closed ring has to repeat its first vertex at the end,
 * because the UV has to run 0..1 round the section and one vertex cannot hold
 * two texture coordinates. Those two vertices are at the same point in space,
 * but `ComputeNormals` only ever sees each one's OWN triangles — the faces on
 * one side of the seam for one, the other side for the other — so it writes
 * them two different normals. The surface is continuous and the shading is not.
 *
 * Measured before this existed, as the angle between the normal a degree to
 * port of the top centreline and the one a degree to starboard: 20.6 degrees
 * on the 747, 18.6 on the Cessna, 18.2 on the F-16 and 8.0 on the Global. That
 * is a shading line down the spine of every lofted body in the game, on the
 * surface the chase camera looks straight down at.
 *
 * NOT EVERY DUPLICATE WANTS THIS. `airfoilWing` also repeats vertices at its
 * leading and trailing edges, and there it is deliberate: an aerofoil's
 * trailing edge IS a crease, and averaging across it would round off the one
 * edge the shape depends on. Welding is opt-in per call for that reason.
 */
function weldNormals(normals: number[], groups: readonly (readonly number[])[]): void {
  for (const group of groups) {
    let x = 0; let y = 0; let z = 0;
    for (const vertex of group) {
      x += normals[vertex * 3]!;
      y += normals[vertex * 3 + 1]!;
      z += normals[vertex * 3 + 2]!;
    }
    const length = Math.hypot(x, y, z);
    // Opposed normals cancel. That is a fold, not a seam, and averaging it
    // would invent a direction; leave those alone rather than guess.
    if (length < 1e-9) continue;
    for (const vertex of group) {
      normals[vertex * 3] = x / length;
      normals[vertex * 3 + 1] = y / length;
      normals[vertex * 3 + 2] = z / length;
    }
  }
}

function mixNumber(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

/**
 * Closed trailing-edge form of the classic NACA four-digit thickness law.
 *
 * Exported because an airframe that wants to lay a part flush INTO the wing —
 * a spoiler panel, a pylon shoulder — has to evaluate the same section the
 * wing itself was drawn from. Re-deriving it at the call site is how a part
 * ends up seated on a surface the wing does not have: the 747 carried a
 * hand-evaluated 0.3753 for this function's value at 60% chord, where it is
 * in fact 0.3789, and every pylon was seated 6 mm off as a result.
 */
export function nacaThickness(chordFraction: number, thicknessRatio: number): number {
  const x = Math.min(1, Math.max(0, chordFraction));
  return 5 * thicknessRatio * (
    0.2969 * Math.sqrt(x)
    - 0.126 * x
    - 0.3516 * x * x
    + 0.2843 * x * x * x
    - 0.1036 * x * x * x * x
  );
}

function appendAirfoilEdge(
  indices: number[],
  topStart: number,
  bottomStart: number,
  rowSize: number,
  spanSegments: number,
  leading: boolean,
  portward: boolean,
): void {
  for (let span = 0; span < spanSegments; span += 1) {
    const topA = topStart + span * rowSize;
    const topB = topA + rowSize;
    const bottomA = bottomStart + span * rowSize;
    const bottomB = bottomA + rowSize;
    const naturalWinding = leading === portward;
    if (naturalWinding) {
      indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
    } else {
      indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
    }
  }
}

function appendAirfoilCap(
  indices: number[],
  topStart: number,
  bottomStart: number,
  _rowSize: number,
  chordSegments: number,
  root: boolean,
  portward: boolean,
): void {
  for (let chord = 0; chord < chordSegments; chord += 1) {
    const topA = topStart + chord;
    const topB = topA + 1;
    const bottomA = bottomStart + chord;
    const bottomB = bottomA + 1;
    const naturalWinding = root === portward;
    if (naturalWinding) {
      indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
    } else {
      indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
    }
  }
}

function planarUvs(
  positions: readonly number[],
  uComponent: 0 | 1 | 2,
  vComponent: 0 | 1 | 2,
): number[] {
  let minimumU = Number.POSITIVE_INFINITY;
  let maximumU = Number.NEGATIVE_INFINITY;
  let minimumV = Number.POSITIVE_INFINITY;
  let maximumV = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minimumU = Math.min(minimumU, positions[index + uComponent]!);
    maximumU = Math.max(maximumU, positions[index + uComponent]!);
    minimumV = Math.min(minimumV, positions[index + vComponent]!);
    maximumV = Math.max(maximumV, positions[index + vComponent]!);
  }
  const rangeU = Math.max(1e-6, maximumU - minimumU);
  const rangeV = Math.max(1e-6, maximumV - minimumV);
  const uvs: number[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    uvs.push(
      (positions[index + uComponent]! - minimumU) / rangeU,
      (positions[index + vComponent]! - minimumV) / rangeV,
    );
  }
  return uvs;
}

function reverseTriangleWinding(indices: number[]): void {
  for (let index = 0; index < indices.length; index += 3) {
    const second = indices[index + 1]!;
    indices[index + 1] = indices[index + 2]!;
    indices[index + 2] = second;
  }
}
