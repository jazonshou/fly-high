import { describe, expect, it } from "vitest";
import type { TerrainErosionResult } from "../src/render/webgpu/terrain/TerrainErosionCompute";
import { TERRAIN_EROSION_PRODUCTION_CONFIG } from "../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  aggregateTerrainPageHydrologyChildren,
  buildTerrainMacroLakeFieldFromGrid,
  buildTerrainPageHydrology,
  terrainHydrologyFloat16Bits,
  terrainPageHydrologyTransferables,
  terrainSignedShoreDistance,
  terrainTopographicWetnessIndex,
} from "../src/render/webgpu/terrain/TerrainPageHydrology";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  decodeWorldPageFlowAccum,
  decodeWorldPageLakeDepth,
  decodeWorldPageShoreDistance,
  decodeWorldPageSoilDepth,
  encodeWorldPageFlowAccum,
  encodeWorldPageLakeDepth,
  encodeWorldPageShoreDistance,
  encodeWorldPageSoilDepth,
  type QuantizedHydrologyPage,
} from "../src/render/webgpu/world/payload";
import { createWorldPageAddress } from "../src/render/webgpu/world/pageKey";
import {
  isTerrainErosionWorkerEvent,
  terrainErosionWorkerTransferables,
} from "../src/workers/terrainErosionProtocol";

function erosionFixture(): TerrainErosionResult {
  const coreSize = 8;
  const haloTexels = 4;
  const scratchEdge = coreSize + haloTexels * 2;
  const count = scratchEdge * scratchEdge;
  const evolvedHeight = new Float32Array(count);
  const flowAccumulation = new Float32Array(count);
  for (let row = 0; row < scratchEdge; row += 1) {
    for (let column = 0; column < scratchEdge; column += 1) {
      const index = row * scratchEdge + column;
      evolvedHeight[index] = 100 - column * 0.2 - row * 0.1;
      flowAccumulation[index] = 1 + row * scratchEdge + column;
    }
  }
  return {
    coreSize,
    haloTexels,
    scratchEdge,
    texelSizeMeters: 2,
    evolvedHeight,
    drainageHeight: evolvedHeight.slice(),
    receivers: new Int32Array(count).fill(-1),
    flowAccumulation,
    erosionMask: new Uint8Array(count),
    config: TERRAIN_EROSION_PRODUCTION_CONFIG,
  };
}

function lakeFixture(allWet = false) {
  const width = 16;
  const lakeMask = new Uint8Array(width * width);
  for (let z = 0; z < width; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (allWet || (x >= 1 && x <= 6 && z >= 1 && z <= 6)) {
        lakeMask[z * width + x] = 1;
      }
    }
  }
  return buildTerrainMacroLakeFieldFromGrid({
    layout: {
      width,
      height: width,
      texelSizeMeters: 4,
      sampleOriginX: 0,
      sampleOriginZ: 0,
    },
    lakeMask,
    basins: [{
      basinId: 0,
      outletIndex: allWet ? 0 : width + 1,
      spillElevationMeters: 110,
    }],
  });
}

function quantized(values: {
  readonly area: readonly number[];
  readonly lake: readonly number[];
  readonly soil: readonly number[];
  readonly shore: readonly number[];
}): QuantizedHydrologyPage {
  const count = values.area.length;
  const page: QuantizedHydrologyPage = {
    format: "r16uint-log-flow+r16uint-lake-depth+r8unorm-soil+r16sint-shore-v2",
    flowAccum: new Uint16Array(count),
    lakeDepth: new Uint16Array(count),
    soilDepth: new Uint8Array(count),
    shoreDistance: new Int16Array(count),
    ...TERRAIN_PAGE_HYDROLOGY_ENCODING,
  };
  for (let index = 0; index < count; index += 1) {
    page.flowAccum[index] = encodeWorldPageFlowAccum(page, values.area[index]!);
    page.lakeDepth[index] = encodeWorldPageLakeDepth(page, values.lake[index]!);
    page.soilDepth[index] = encodeWorldPageSoilDepth(page, values.soil[index]!);
    page.shoreDistance[index] = encodeWorldPageShoreDistance(page, values.shore[index]!);
  }
  return page;
}

describe("terrain page hydrology (5-5)", () => {
  it("uses the canonical physical TWI formula", () => {
    const area = 12_345;
    const slope = 0.17;
    expect(terrainTopographicWetnessIndex(area, slope)).toBeCloseTo(
      Math.log((1 + area) / (Math.tan(slope) + 1e-4)),
      12,
    );
    expect(() => terrainTopographicWetnessIndex(-1, slope)).toThrow(RangeError);
    expect(() => terrainTopographicWetnessIndex(area, Math.PI / 2)).toThrow(RangeError);
  });

  it("computes deterministic signed Euclidean distance with a half-cell shore", () => {
    const wet = new Uint8Array(25);
    wet[2 * 5 + 2] = 1;
    const distance = terrainSignedShoreDistance(wet, 5, 5, 4);
    expect(distance[2 * 5 + 2]).toBe(-2);
    expect(distance[2 * 5 + 3]).toBe(2);
    expect(distance[0]).toBeCloseTo((Math.sqrt(8) - 0.5) * 4, 6);
    expect(terrainSignedShoreDistance(wet, 5, 5, 4)).toEqual(distance);
  });

  it("builds one upload-ready core+gutter product from converged scratch fields", () => {
    const input = {
      address: createWorldPageAddress(0, 0, 0),
      erosion: erosionFixture(),
      macroLakes: lakeFixture(),
      channelCoreSize: 4,
      gutter: 1,
    } as const;
    const first = buildTerrainPageHydrology(input);
    const second = buildTerrainPageHydrology(input);
    expect(first.storedEdge).toBe(6);
    expect(first.texelSizeMeters).toBe(4);
    for (const field of [
      first.hydrology.flowAccum,
      first.hydrology.lakeDepth,
      first.hydrology.soilDepth,
      first.hydrology.shoreDistance,
      first.upload.flowAccumR16Float,
      first.upload.lakeDepthR16Float,
      first.upload.soilDepthR8Unorm,
      first.upload.shoreDistanceR16Sint,
    ]) expect(field).toHaveLength(36);
    expect(first.hydrology.flowAccum).toEqual(second.hydrology.flowAccum);
    expect(first.hydrology.lakeDepth).toEqual(second.hydrology.lakeDepth);
    expect(first.hydrology.soilDepth).toEqual(second.hydrology.soilDepth);
    expect(first.hydrology.shoreDistance).toEqual(second.hydrology.shoreDistance);
    expect(first.hydrology.lakeDepth.some((sample) => sample > 0)).toBe(true);
    expect(first.hydrology.shoreDistance.some((sample) => sample < 0)).toBe(true);
    expect(first.upload.soilDepthR8Unorm).toBe(first.hydrology.soilDepth);
    expect(first.upload.shoreDistanceR16Sint).toBe(first.hydrology.shoreDistance);
    expect(new Set(terrainPageHydrologyTransferables(first)).size).toBe(6);
    const event = {
      type: "page",
      requestId: 7,
      page: {
        address: input.address,
        coreSize: 8,
        haloTexels: 4,
        scratchEdge: 16,
        storedEdge: 16,
        storedHeight: new Float32Array(16 * 16),
        stats: { minHeightMeters: 0, maxHeightMeters: 1, maxDeviationFromParent: 0.1 },
        protectedSampleCount: 0,
        hydrology: first,
      },
    } as const;
    expect(isTerrainErosionWorkerEvent(event)).toBe(true);
    const transfers = terrainErosionWorkerTransferables(event);
    expect(transfers).toContain(event.page.storedHeight.buffer);
    for (const buffer of terrainPageHydrologyTransferables(first)) {
      expect(transfers).toContain(buffer);
    }
    expect(new Set(transfers).size).toBe(7);
    expect(terrainHydrologyFloat16Bits(1)).toBe(0x3c00);
    expect(terrainHydrologyFloat16Bits(2)).toBe(0x4000);
  });

  it("prevents clamped macro samples from extending lakes beyond the D2 rim", () => {
    const page = buildTerrainPageHydrology({
      address: createWorldPageAddress(0, 2_000, 2_000),
      erosion: erosionFixture(),
      macroLakes: lakeFixture(true),
      channelCoreSize: 4,
      gutter: 1,
    });
    expect(page.hydrology.lakeDepth.every((sample) => sample === 0)).toBe(true);
    expect(page.hydrology.shoreDistance.every((sample) => sample > 0)).toBe(true);
  });

  it("aggregates physical child values before re-quantizing the parent", () => {
    const children = [
      quantized({
        area: [100, 200, 300, 400],
        lake: [1, 2, 3, 4],
        soil: [1, 2, 3, 4],
        shore: [-4, -2, 2, 4],
      }),
      quantized({ area: [800, 800, 800, 800], lake: [8, 8, 8, 8], soil: [4, 4, 4, 4], shore: [8, 8, 8, 8] }),
      quantized({ area: [1_200, 1_200, 1_200, 1_200], lake: [12, 12, 12, 12], soil: [6, 6, 6, 6], shore: [12, 12, 12, 12] }),
      quantized({ area: [1_600, 1_600, 1_600, 1_600], lake: [16, 16, 16, 16], soil: [8, 8, 8, 8], shore: [16, 16, 16, 16] }),
    ] as const;
    const parent = aggregateTerrainPageHydrologyChildren(children, 2, 0).hydrology;
    expect(decodeWorldPageFlowAccum(parent, parent.flowAccum[0]!)).toBeCloseTo(250, 0);
    expect(decodeWorldPageLakeDepth(parent, parent.lakeDepth[0]!)).toBeCloseTo(2.5, 2);
    expect(decodeWorldPageSoilDepth(parent, parent.soilDepth[0]!)).toBeCloseTo(2.5, 1);
    expect(decodeWorldPageShoreDistance(parent, parent.shoreDistance[0]!)).toBeCloseTo(0, 2);
    expect(decodeWorldPageFlowAccum(parent, parent.flowAccum[3]!)).toBeCloseTo(1_600, 0);
  });
});

/**
 * `6-6` — the consumer-per-channel table, made executable.
 *
 * `RENDERING_PLAN`'s 6-6 row states the rule this file's producer is measured
 * against: **"three channels, each with a named ground-layer consumer, or the
 * item produces data nothing reads"**. Phase 5 shipped four channels and two of
 * them — `lakeDepth` and `soilDepth` — had zero consumers anywhere in the tree
 * (Phase 5 register row **C-9**). A grep found the debt; only a test keeps it
 * closed, because "nothing reads this" is exactly the defect that a green suite
 * and a correct-looking screenshot both hide.
 *
 * Each row names a channel, the file that consumes it and a source marker that
 * fails if the consumer is deleted or renamed. `pendingItem` was the ONLY
 * escape hatch and it was spent on `lakeDepth`, 6-5's by the recorded split of
 * C-9; **6-5 has now landed and deleted that row**, so the pending list is
 * asserted EMPTY. C-9 is discharged in full: every channel Phase 5 produces has
 * a named ground-layer consumer, and the escape hatch stays in the type only so
 * that a NEW channel arriving without one has somewhere honest to be recorded —
 * where the emptiness assertion will immediately fail it.
 */
const ECOLOGY_CHANNEL_CONSUMERS: readonly {
  readonly channel: "flowAccum" | "lakeDepth" | "soilDepth" | "shoreDistance";
  readonly pendingItem?: string;
  readonly consumers: readonly { readonly file: string; readonly marker: string }[];
}[] = [
  {
    channel: "flowAccum",
    consumers: [
      // 4-6's classifier: real drainage supersedes the moisture proxy.
      {
        file: "src/render/webgpu/terrain/LandCoverClassifier.ts",
        marker: "input.flowAccumulationValid = select(0.0, 1.0, flowLog2 > 0.0);",
      },
    ],
  },
  {
    channel: "shoreDistance",
    consumers: [
      // 5-13, the DENSITY half (live before 6-6).
      {
        file: "src/render/webgpu/detail/densityField.ts",
        marker: "export function riparianVegetationFactors(",
      },
      // 6-6, the SPECIES half: reed/fern archetype weight.
      {
        file: "src/render/webgpu/detail/generation.ts",
        marker: "const bank = field.riparianBand;",
      },
      // 6-6, the APPEARANCE half: wet-litter darkening in the splat.
      {
        file: "src/render/webgpu/terrain/TerrainSurfacePlugin.ts",
        marker: "fn terrainSurfaceRiparianBand(uv: vec4f) -> f32 {",
      },
    ],
  },
  {
    channel: "soilDepth",
    consumers: [
      // 6-6: 2-15's clutter density, off the moisture stand-in at last.
      {
        file: "src/render/webgpu/detail/generation.ts",
        marker: "function litterDriver(sample: DetailTerrainSample): number {",
      },
      // 6-6: litter depth in the forest-floor splat, baked per page.
      {
        file: "src/render/webgpu/terrain/LandCoverClassifier.ts",
        marker: "fn landCoverLitter(input: LandCoverInput) -> f32 {",
      },
      // 6-6: the CPU delivery path the detail worker reads it through.
      {
        file: "src/render/webgpu/terrain/TerrainConsumerAuthority.ts",
        marker: "sampleSoilDepth(x: number, z: number): number | null {",
      },
    ],
  },
  {
    channel: "lakeDepth",
    // 6-5 CLOSED C-9's last row. The recorded split of C-9 assigned lakeDepth's
    // named consumer to terrain wetness, and this is it: the fragment reads the
    // channel by textureLoad and turns metres of water column into the lake's
    // own submerged fraction, which drives both `3-7` response instructions and
    // the silt tint. `pendingItem` is gone, and the assertion below now
    // requires the pending list to be EMPTY.
    consumers: [
      // 6-5, the field: the lake-bed/bank term in the terrain fragment.
      {
        file: "src/render/webgpu/terrain/TerrainSurfacePlugin.ts",
        marker: "fn terrainSurfaceLakeWetness(uv: vec4f, beachSlope: f32) -> vec2f {",
      },
      // 6-5, the binding: the atlas texture that carries it to that fragment.
      {
        file: "src/render/webgpu/terrain/TerrainClipmapSystem.ts",
        marker: "? this.channelAtlas.hydrologyTextures().lakeDepth",
      },
    ],
  },
];

describe("6-6 ecology channels: no page channel is dark", () => {
  it("names a live consumer for every produced channel", async () => {
    const { readFile } = await import("node:fs/promises");
    const sources = new Map<string, string>();
    for (const row of ECOLOGY_CHANNEL_CONSUMERS) {
      for (const consumer of row.consumers) {
        if (!sources.has(consumer.file)) {
          sources.set(consumer.file, await readFile(consumer.file, "utf8"));
        }
      }
    }
    for (const row of ECOLOGY_CHANNEL_CONSUMERS) {
      if (row.pendingItem !== undefined) continue;
      expect(
        row.consumers.length,
        `Channel "${row.channel}" has no named consumer. The 6-6 rule is `
        + "\"a named ground-layer consumer, or the item produces data nothing reads\".",
      ).toBeGreaterThan(0);
      for (const consumer of row.consumers) {
        expect(
          sources.get(consumer.file)!.includes(consumer.marker),
          `Channel "${row.channel}" lost its consumer in ${consumer.file}: the marker `
          + `"${consumer.marker}" is gone. Re-point this table at the new consumer, or `
          + "the channel is dark again.",
        ).toBe(true);
      }
    }
  });

  it("covers every produced channel exactly once, with no debt left", () => {
    // The producer's own quantized page names the channels; the table may not
    // drift from it, so a NEW channel arrives dark-and-failing rather than
    // dark-and-silent.
    const page = quantized({
      area: [1, 1, 1, 1], lake: [0, 0, 0, 0], soil: [1, 1, 1, 1], shore: [1, 1, 1, 1],
    }) as unknown as Record<string, unknown>;
    const produced = Object.keys(page).filter(
      (key) => ArrayBuffer.isView(page[key]),
    );
    expect(new Set(ECOLOGY_CHANNEL_CONSUMERS.map((row) => row.channel)))
      .toEqual(new Set(produced));
    expect(
      ECOLOGY_CHANNEL_CONSUMERS.filter((row) => row.pendingItem !== undefined)
        .map((row) => `${row.channel} -> ${row.pendingItem}`),
      "C-9 is DISCHARGED: 6-6 took soilDepth and 6-5 took lakeDepth, so every "
      + "channel Phase 5 produces has a named ground-layer consumer and this "
      + "list is empty. Anything appearing here is a channel that shipped with "
      + "nothing reading it — the exact defect the register row recorded.",
    ).toEqual([]);
  });
});
