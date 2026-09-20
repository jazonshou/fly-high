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
    const material = this.material(name, 0xffffff, { roughness: 1, metallic: 1 });
    material.albedoTexture = textures.albedo;
    material.bumpTexture = textures.normal;
    material.bumpTexture.level = 0.42;
    material.metallicTexture = textures.metallicRoughness;
    material.useAmbientOcclusionFromMetallicTextureRed = true;
    material.useRoughnessFromMetallicTextureAlpha = false;
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    material.metadata = {
      ...(material.metadata as Record<string, unknown> | null),
      aircraftPaint: true,
      aircraftPaintFeatures: [...AIRCRAFT_PAINT_FEATURES],
      aircraftPaintRecipe: { ...recipe },
      aircraftPaintFeatureCoverage: { ...synthesis.featureCoverage },
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

  /** Elliptical cross-sections joined along body +X; never a scaled cylinder. */
  loft(
    name: string,
    sections: readonly LoftSection[],
    radialSegments: number,
    material: Material,
    parent: TransformNode,
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
    for (const section of sections) {
      if (!(section.yRadius > 0) || !(section.zRadius > 0)) {
        throw new RangeError("Aircraft loft radii must be positive");
      }
      const squareness = section.squareness ?? 2;
      if (!(squareness >= 2)) {
        throw new RangeError("Aircraft loft squareness must be at least 2");
      }
      const shapeExponent = 2 / squareness;
      for (let radial = 0; radial <= radialSegments; radial += 1) {
        const phase = radial / radialSegments;
        const angle = phase * Math.PI * 2;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        // Superellipse: |cos|^(2/n)·sign(cos). At n = 2 this is exactly the
        // ellipse the pre-fix-pack loft produced.
        const yShape = Math.sign(cosine) * Math.abs(cosine) ** shapeExponent;
        const zShape = Math.sign(sine) * Math.abs(sine) ** shapeExponent;
        positions.push(
          section.x,
          (section.yOffset ?? 0) + yShape * section.yRadius,
          (section.zOffset ?? 0) + zShape * section.zRadius,
        );
        uvs.push((section.x - minimumX) / length, phase);
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
    uvs.push(0, 0.5);
    const endCenter = positions.length / 3;
    const end = sections[sections.length - 1]!;
    positions.push(end.x, end.yOffset ?? 0, end.zOffset ?? 0);
    uvs.push(1, 0.5);
    const endRing = (sections.length - 1) * ringSize;
    for (let radial = 0; radial < radialSegments; radial += 1) {
      indices.push(startCenter, radial + 1, radial);
      indices.push(endCenter, endRing + radial, endRing + radial + 1);
    }
    reverseTriangleWinding(indices);
    return this.vertexMesh(name, positions, indices, material, parent, {
      uvs,
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

function mixNumber(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

/** Closed trailing-edge form of the classic NACA four-digit thickness law. */
function nacaThickness(chordFraction: number, thicknessRatio: number): number {
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
