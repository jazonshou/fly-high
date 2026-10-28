import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { RoadSurfaceRegion } from "../../src/render/webgpu/roads/RoadSurfaceIndex";
import { ROAD_RIBBON_LOOK } from "../../src/render/webgpu/roads/RoadSurfaceMaterialPlugin";
import { RoadSurfaceSystem, type RoadSurfaceTerrain } from "../../src/render/webgpu/roads/RoadSurfaceSystem";
import { surfaceArrayLayerIds, synthesizeSurfaceArrayLayer } from "../../src/render/webgpu/terrain/GroundGrainSynthesis";
import { uploadSurfaceMaterialArrays } from "../../src/render/webgpu/terrain/MaterialArrayUpload";
import { createTerrainMaterial } from "../../src/render/webgpu/terrain/TerrainClipmapSystem";
import { TerrainDrawnHeight } from "../../src/render/webgpu/terrain/TerrainDrawnHeight";
import { INFRASTRUCTURE_PAINT_ID_OFFSET } from "../../src/render/webgpu/terrain/TerrainInfrastructureKernel";
import { buildTerrainNodeGrid, packTerrainNodeSubIndex } from "../../src/render/webgpu/terrain/TerrainQuadtree";
import {
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { TerrainSurfacePlugin } from "../../src/render/webgpu/terrain/TerrainSurfacePlugin";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { ROAD_CLASS, roadClass, type RoadClassId } from "../../src/world/roads/roadClasses";
import type { RoadPiece } from "../../src/world/roads/roadNetwork";
import { DRAWN_FRAME_CAMERA, buildDrawnFrame } from "../support/terrainDrawnFrame";

/**
 * The ribbon is the terrain's paint, only sharp: drawn over the splat that
 * paints the same material, it is the same colour. A gravel road and a sealed
 * one lie on flat ground the terrain's own material paints gravel and asphalt
 * as it paints a road (`createTerrainMaterial` + `TerrainSurfacePlugin` on its
 * CDLOD + page-channel path, the page's splat ids carrying the paint offset,
 * the same material arrays), seen from a car's height down the road under a
 * low sun, a sky fill and an environment. The frame is drawn with the roads
 * and again without them, and the ribbon's pixels are compared with the
 * paint's at the same pixels. Before the ribbon took the terrain's wash,
 * roughness, cavity and F0 it was 15-20% lighter in captures (36% here), and
 * 4-7% before it took the meso band's tilt. Now it is within 0.7% of the
 * paint, but for Low's gravel, 1.7% darker: the patchwork, which Low skips,
 * shades gravel's paint (15% vegetated) a little darker where it runs.
 *
 * Twice: as a Low tier draws it, and with the ground grain's layer a Medium
 * or higher one adds to the arrays. The grain is centred on zero, so it moves
 * no mean; what it adds is a pattern of patches, which the ribbon has to
 * carry where the paint has them or it reads as a strip laid over them. So
 * with the grain, the paint is drawn again with its grain switched off, and
 * the ribbon again from arrays without the layer: band by band down each
 * road, what the grain does to the ribbon is what it does to the paint.
 */

const CANVAS = 256;
const SKY = [0.42, 0.55, 0.72] as const;
const GRAVEL_ROAD_X = -8;
const SEALED_ROAD_X = 9;
/** Clear of sea level, whose shore wetness the terrain paints at every height near it. */
const GROUND = 60;
/** One level-0 page, 8 x 8 nodes of 64 m, centred on the camera's x and z. */
const PAGE_METERS = 512;
const NODE_METERS = 64;
const CHANNEL = Object.freeze({ edge: 136, core: 128, gutter: 4 });

function straight(classId: RoadClassId, edgeId: number, ax: number, az: number, bx: number, bz: number, pieces: number): RoadPiece[] {
  const out: RoadPiece[] = [];
  for (let index = 0; index < pieces; index += 1) {
    out.push({
      classId, edgeId, index,
      ax: ax + ((bx - ax) * index) / pieces, az: az + ((bz - az) * index) / pieces,
      bx: ax + ((bx - ax) * (index + 1)) / pieces, bz: az + ((bz - az) * (index + 1)) / pieces,
      ha: GROUND, hb: GROUND, ca: 0, cb: 0, ka: 0, kb: 0,
    });
  }
  return out;
}

/** A page-channel texture, RGBA bytes by texel column. */
function channelTexture(scene: Scene, texel: (column: number) => readonly number[]): RawTexture {
  const bytes = new Uint8Array(CHANNEL.edge * CHANNEL.edge * 4);
  for (let row = 0; row < CHANNEL.edge; row += 1) {
    for (let column = 0; column < CHANNEL.edge; column += 1) bytes.set(texel(column), (row * CHANNEL.edge + column) * 4);
  }
  return RawTexture.CreateRGBATexture(
    bytes, CHANNEL.edge, CHANNEL.edge, scene, false, false,
    Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
}

/** A splat id as the page bake stores it (`id / (count - 1)` in a byte), painted: a road's paint offset up. */
function paintedId(material: number): number {
  return Math.round(((material + INFRASTRUCTURE_PAINT_ID_OFFSET) / (SURFACE_MATERIAL_COUNT - 1)) * 255);
}

/**
 * Flat ground at GROUND, one resident level-0 page with (x0, z0) its corner,
 * drawn as the terrain draws it: 8 x 8 thin-instanced nodes of the CDLOD grid,
 * its page painted gravel up to `splitX` and asphalt past it.
 */
function paintedGround(scene: Scene, plugin: TerrainSurfacePlugin, x0: number, z0: number, splitX: number): Mesh {
  const heightEdge = 264;
  plugin.setHeightAtlas(
    RawTexture.CreateRTexture(
      new Float32Array(heightEdge * heightEdge).fill(GROUND), heightEdge, heightEdge, scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
    ),
    { atlasEdge: heightEdge, slotEdge: heightEdge, gutter: 4, gridEdge: 1 },
  );
  const metersPerTexel = PAGE_METERS / CHANNEL.core;
  const gravelBelow = CHANNEL.gutter + (splitX - x0) / metersPerTexel;
  const ids = (column: number) => [paintedId(column < gravelBelow ? SurfaceMaterial.Gravel : SurfaceMaterial.Asphalt), 0, 0, 0];
  // One material at full weight; lane 3 is the canopy closure (low) and the far-sward gate (high): none.
  const weights = () => [255, 0, 0, 0];
  plugin.setChannelAtlas(
    // Open sky (r), baked (a); a horizon under the sun.
    channelTexture(scene, () => [255, 128, 128, 128]),
    channelTexture(scene, () => [8, 8, 8, 8]),
    channelTexture(scene, () => [8, 8, 8, 8]),
    [channelTexture(scene, ids), channelTexture(scene, weights), channelTexture(scene, weights), null],
    null,
    null,
    {
      atlasEdge: CHANNEL.edge, slotEdge: CHANNEL.edge, core: CHANNEL.core, gutter: CHANNEL.gutter,
      gridEdge: 1, basePageExtentMeters: PAGE_METERS,
    },
  );
  const mesh = new Mesh("painted-ground", scene);
  buildTerrainNodeGrid().applyToMesh(mesh, false);
  const nodes = PAGE_METERS / NODE_METERS;
  const matrices = new Float32Array(nodes * nodes * 16);
  const laneA = new Float32Array(nodes * nodes * TERRAIN_NODE_ATTRIBUTE_STRIDE);
  const laneB = new Float32Array(nodes * nodes * TERRAIN_NODE_ATTRIBUTE_STRIDE);
  for (let subZ = 0; subZ < nodes; subZ += 1) {
    for (let subX = 0; subX < nodes; subX += 1) {
      const index = subZ * nodes + subX;
      Matrix.Scaling(NODE_METERS, 1, NODE_METERS)
        .multiply(Matrix.Translation(x0 + subX * NODE_METERS, 0, z0 + subZ * NODE_METERS))
        .copyToArray(matrices, index * 16);
      // A = (height slot, sub-node, level, -); B = (morph, parent slot, channel lane = slot * 32 + level, corner morphs).
      laneA.set([0, packTerrainNodeSubIndex(subX, subZ, 0, 0), 0, 0], index * TERRAIN_NODE_ATTRIBUTE_STRIDE);
      laneB.set([0, 0, 0, 0], index * TERRAIN_NODE_ATTRIBUTE_STRIDE);
    }
  }
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
  mesh.thinInstanceSetBuffer(TERRAIN_NODE_ATTRIBUTE_A, laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, true);
  mesh.thinInstanceSetBuffer(TERRAIN_NODE_ATTRIBUTE_B, laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, true);
  mesh.thinInstanceCount = nodes * nodes;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.useVertexColors = false;
  return mesh;
}

const toLinear = (value: number) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (rgb: readonly number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

/** Screen rows per band down the road, for the grain's pattern. */
const BAND_ROWS = 6;

/** Two frames' luminance, summed over one band's pixels. */
interface BandSums {
  with: number;
  without: number;
  count: number;
}

/**
 * What the grain does to each band, as the log of its luminance with it over
 * without it; bands of a few pixels at the far end are left out.
 */
function grainByBand(bands: Map<number, BandSums>): Map<number, number> {
  return new Map([...bands]
    .filter(([, sums]) => sums.count >= 30)
    .map(([band, sums]) => [band, Math.log(sums.with / sums.without)]));
}

/** The spread of values about their mean. */
function spreadAboutMean(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function grainArrays(scene: Scene, seed: string, grain: boolean) {
  const layers = surfaceArrayLayerIds(grain, false).map((id) => synthesizeSurfaceArrayLayer(id, seed, 128));
  return uploadSurfaceMaterialArrays(scene, {
    albedoHeight: layers.map((layer) => layer.albedoHeight),
    normalMaterial: layers.map((layer) => layer.normalMaterial),
  }, seed, 128);
}

describe("the road ribbon against the terrain's paint", () => {
  it.each([
    { tier: "low", grain: false },
    { tier: "medium and up", grain: true },
  ])("is the colour of the paint it is drawn over, gravel and sealed ($tier)", async ({ grain }) => {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS;
    canvas.height = CANVAS;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    const errors: string[] = [];
    try {
      await engine.initAsync();
      engine.compatibilityMode = false;
      const device = (engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        errors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const scene = new Scene(engine);
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      scene.autoClear = true;
      scene.clearColor = new Color4(SKY[0], SKY[1], SKY[2], 1);
      const x = DRAWN_FRAME_CAMERA.x;
      const z = DRAWN_FRAME_CAMERA.z;
      // A car's chase height, looking down the roads.
      const camera = new FreeCamera("chase", new Vector3(x, GROUND + 4.5, z - 30), scene);
      camera.setTarget(new Vector3(x, GROUND, z + 6));
      camera.fov = 0.9;
      camera.minZ = 0.5;
      camera.maxZ = 2_000;
      scene.activeCamera = camera;
      const sun = new DirectionalLight("sun", new Vector3(-0.45, -0.55, 0.7).normalize(), scene);
      sun.intensity = 2.4;
      new HemisphericLight("sky", Vector3.Up(), scene).intensity = 0.7;
      // The empty probe holds the sky's clear colour: an environment for both.
      const probe = new ReflectionProbe("sky-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      // The tier's arrays; the patchwork runs exactly where the grain is built.
      const arrays = grainArrays(scene, "road-ribbon-tone", grain);
      const terrainMaterial = createTerrainMaterial(scene);
      const paint = new TerrainSurfacePlugin(terrainMaterial);
      paint.setArrays(arrays.albedoHeight, arrays.normalMaterial, grain);
      paint.setGroundPatchwork(grain);
      paint.setSamplingProfile("biplanar", 3);
      paint.setCanopyBands(150, 3_000, 0.045);
      paint.setSunDirection(-sun.direction.x, -sun.direction.y, -sun.direction.z);
      const ground = paintedGround(scene, paint, x - PAGE_METERS / 2, z - PAGE_METERS / 2, x);
      ground.material = terrainMaterial;

      const frame = buildDrawnFrame(undefined, () => GROUND);
      const atlas = new RawTexture(
        frame.atlas.heights, frame.atlas.shape.atlasEdge, frame.atlas.shape.atlasEdge, Constants.TEXTUREFORMAT_R,
        scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      let lookup: TerrainDrawnHeight | null = null;
      const terrain: RoadSurfaceTerrain = {
        drawnHeight: (reach) => {
          lookup ??= new TerrainDrawnHeight(scene, reach);
          return lookup;
        },
        refreshDrawnHeight: (px, pz, radius) => lookup?.refresh(frame.records, px, pz, radius),
        drawnHeightAtlas: { texture: atlas, shape: frame.atlas.shape },
        surfaceMaterialArrays: arrays,
      };
      const region: RoadSurfaceRegion = {
        key: "tone",
        pieces: [
          ...straight(ROAD_CLASS.gravel, 1, x + GRAVEL_ROAD_X, z - 160, x + GRAVEL_ROAD_X, z + 160, 16),
          ...straight(ROAD_CLASS.airport, 2, x + SEALED_ROAD_X, z - 160, x + SEALED_ROAD_X, z + 160, 16),
        ],
        pads: [],
        rails: [],
      };
      const ranges = { roadRibbonRangeMeters: 300, barrierDrawRangeMeters: 300 };
      const system = new RoadSurfaceSystem(scene, terrain, ranges);
      const settle = (roads: RoadSurfaceSystem) => {
        for (let step = 0; step < 100 && roads.pendingWork > 0; step += 1) roads.update(x, z);
        expect(roads.pendingWork).toBe(0);
      };
      system.apply([region], []);
      system.setFloatingOrigin(0, 0);
      settle(system);
      await scene.whenReadyAsync();
      const render = async (roads = system) => {
        for (let pass = 0; pass < 4; pass += 1) {
          roads.update(x, z);
          engine.beginFrame();
          scene.render();
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        roads.update(x, z);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        const copy = document.createElement("canvas");
        copy.width = CANVAS;
        copy.height = CANVAS;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, CANVAS, CANVAS).data;
      };
      const withRoads = await render();
      expect(errors.join(" | ")).toBe("");
      system.apply([], ["tone"]);
      settle(system);
      const paintOnly = await render();
      expect(errors.join(" | ")).toBe("");
      // Without the grain: the paint with its switch off, and the ribbon of a
      // second system bound to arrays without the layer.
      let flat: { paint: Uint8ClampedArray; withRoads: Uint8ClampedArray } | null = null;
      if (grain) {
        paint.setArrays(arrays.albedoHeight, arrays.normalMaterial, false);
        const paintFlat = await render();
        const flatSystem = new RoadSurfaceSystem(scene, { ...terrain, surfaceMaterialArrays: grainArrays(scene, "road-ribbon-tone", false) }, ranges);
        flatSystem.apply([region], []);
        flatSystem.setFloatingOrigin(0, 0);
        settle(flatSystem);
        await scene.whenReadyAsync();
        flat = { paint: paintFlat, withRoads: await render(flatSystem) };
        expect(errors.join(" | ")).toBe("");
        flatSystem.dispose();
      }

      // The ground point under each pixel, and the pixels well inside each
      // road's surface: off the gravel's ragged edge, inside the seal's edge lines.
      const gravelInside = roadClass(ROAD_CLASS.gravel).carriageHalfWidth;
      const sealed = roadClass(ROAD_CLASS.airport);
      const sealInside = sealed.carriageHalfWidth - ROAD_RIBBON_LOOK.edgeLineInsetMeters - ROAD_RIBBON_LOOK.edgeLineWidthMeters - 0.3;
      const site = () => ({
        road: [0, 0, 0], paint: [0, 0, 0], count: 0, pixelDelta: 0,
        // By band down the road: each frame with the grain and without it.
        ribbonGrain: new Map<number, BandSums>(),
        paintGrain: new Map<number, BandSums>(),
      });
      const sums = { gravel: site(), sealed: site() };
      // A pixel's ray through the camera's frame (square canvas, vertical field of view).
      const forward = camera.getDirection(Vector3.Forward());
      const right = camera.getDirection(Vector3.Right());
      const up = camera.getDirection(Vector3.Up());
      const spread = Math.tan(camera.fov / 2);
      for (let row = 0; row < CANVAS; row += 1) {
        for (let column = 0; column < CANVAS; column += 1) {
          const across = ((2 * (column + 0.5)) / CANVAS - 1) * spread;
          const along = (1 - (2 * (row + 0.5)) / CANVAS) * spread;
          const direction = forward.add(right.scale(across)).add(up.scale(along));
          if (direction.y > -1e-3) continue;
          const distance = (GROUND - camera.position.y) / direction.y;
          const groundX = camera.position.x + direction.x * distance - x;
          const groundZ = camera.position.z + direction.z * distance - z;
          // From just ahead of the car to where the road is a few pixels wide.
          if (groundZ < -18 || groundZ > 40) continue;
          const which = Math.abs(groundX - GRAVEL_ROAD_X) < gravelInside - 0.2
            ? sums.gravel
            : Math.abs(groundX - SEALED_ROAD_X) < sealInside ? sums.sealed : null;
          if (!which) continue;
          const at = (row * CANVAS + column) * 4;
          const pixel = (frame: Uint8ClampedArray) => [0, 1, 2].map((channel) => toLinear(frame[at + channel]!));
          const road = pixel(withRoads);
          const painted = pixel(paintOnly);
          for (let channel = 0; channel < 3; channel += 1) {
            which.road[channel]! += road[channel]!;
            which.paint[channel]! += painted[channel]!;
            which.pixelDelta += Math.abs(withRoads[at + channel]! - paintOnly[at + channel]!);
          }
          which.count += 1;
          if (flat) {
            const band = Math.floor(row / BAND_ROWS);
            const add = (bands: Map<number, BandSums>, withGrain: readonly number[], without: readonly number[]) => {
              const sums = bands.get(band) ?? { with: 0, without: 0, count: 0 };
              sums.with += luminance(withGrain);
              sums.without += luminance(without);
              sums.count += 1;
              bands.set(band, sums);
            };
            add(which.ribbonGrain, road, pixel(flat.withRoads));
            add(which.paintGrain, painted, pixel(flat.paint));
          }
        }
      }
      for (const [name, sum] of Object.entries(sums)) {
        expect(sum.count, `${name}: too few pixels on the road`).toBeGreaterThan(400);
        const road = sum.road.map((value) => value / sum.count);
        const painted = sum.paint.map((value) => value / sum.count);
        const offset = luminance(road) / luminance(painted) - 1;
        const pixelDelta = sum.pixelDelta / (3 * sum.count);
        console.log(`${name}: ${sum.count} px, ribbon ${road.map((v) => v.toFixed(4)).join("/")} vs paint ${painted.map((v) => v.toFixed(4)).join("/")}, luminance ${(offset * 100).toFixed(2)}%, mean pixel step ${pixelDelta.toFixed(2)}/255`);
        // The ribbon drew there: its texels are sharp where the paint's are
        // warped and blended, so pixel by pixel the two differ...
        expect(pixelDelta, `${name}: the ribbon left the paint's pixels untouched`).toBeGreaterThan(1);
        // ...and on the mean they are one colour.
        expect(Math.abs(offset), `${name}: ribbon ${(offset * 100).toFixed(1)}% off the paint's luminance`).toBeLessThan(0.02);
        for (let channel = 0; channel < 3; channel += 1) {
          expect(Math.abs(road[channel]! / painted[channel]! - 1), `${name}: channel ${channel} off the paint's hue`).toBeLessThan(0.03);
        }
        if (flat) {
          // The grain's patches, band by band: on the ribbon what they are on
          // the paint (the means are held above).
          const onRibbon = grainByBand(sum.ribbonGrain);
          const onPaint = grainByBand(sum.paintGrain);
          const bands = [...onPaint.keys()];
          const grainSpread = spreadAboutMean(bands.map((band) => onPaint.get(band)!));
          const mismatch = spreadAboutMean(bands.map((band) => onRibbon.get(band)! - onPaint.get(band)!));
          console.log(`${name}: the grain moves the paint's bands ${(grainSpread * 100).toFixed(2)}% rms, the ribbon's by ${(mismatch * 100).toFixed(2)}% rms more or less`);
          expect(grainSpread, `${name}: no grain on the paint to compare`).toBeGreaterThan(0.01);
          expect(mismatch, `${name}: the ribbon does not carry the paint's grain`).toBeLessThan(0.3 * grainSpread);
        }
      }
      system.dispose();
      scene.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
