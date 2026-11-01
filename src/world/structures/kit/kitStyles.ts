import type { StructureArchetype, StructureRecord, StructureStyle } from "../structureRecord";
import type { StructureSurface } from "../structureModel";
import { KitChannel, KitRandom } from "./kitRandom";

/**
 * The regional accents of the one building family (the plan's "Styles per
 * biome"). Everywhere: rectangular plans, pitched gable or hip roofs of
 * 20-45 degrees, timber or rendered walls, stone or post foundations, the same
 * doors and windows. A style changes only the cladding, the colours, the
 * roof's material and pitch, the foundation's look, the porch and the
 * chimney. Colours are albedo in sRGB, chosen to read on their own: Low draws
 * vertex colours only, and the texture layers modulate round them.
 */

export type WallCladding = "clapboard" | "boards" | "logs" | "render" | "stone" | "metal";
export type RoofCovering = "slate" | "shingle" | "metal" | "tile";
export type RoofForm = "gable" | "hip";
/** How the ground floor stands: a solid plinth, stone corner piers, short stumps, or tall posts. */
export type FoundationLook = "plinth" | "piers" | "stumps" | "posts";

interface StyleAccent {
  /** Main houses' and cottages' cladding, weighted picks. */
  readonly cladding: readonly WallCladding[];
  readonly wallColours: Readonly<Partial<Record<WallCladding, readonly number[]>>>;
  readonly trimColours: readonly number[];
  readonly roofs: readonly { readonly covering: RoofCovering; readonly colours: readonly number[] }[];
  /** Share of hip roofs on houses and cottages. */
  readonly hip: number;
  /** Roof pitch range, degrees. */
  readonly pitch: readonly [number, number];
  readonly foundation: FoundationLook;
  readonly plinthSurface: StructureSurface;
  readonly plinthColour: number;
  /** Share of houses with a masonry chimney; `pipe` puts a stovepipe on the rest. */
  readonly chimney: number;
  readonly pipe: boolean;
  /** Window clear width and height, metres, and sill above the floor. */
  readonly window: readonly [number, number, number];
  readonly doorColours: readonly number[];
  /** Window shutters beside each house window. */
  readonly shutters: number;
  /** A porch across the whole front (verandah), or centred on the door. */
  readonly verandah: boolean;
  /** Inside: wall lining and its colours, ceiling, floor tones. */
  readonly lining: StructureSurface;
  readonly liningColours: readonly number[];
  readonly ceiling: StructureSurface;
  readonly ceilingColour: number;
  readonly floorColours: readonly number[];
}

const WHITE_TRIM = 0xeeebe2;
const CREAM_TRIM = 0xe4dcc6;

const STYLE_ACCENTS: Readonly<Record<StructureStyle, StyleAccent>> = Object.freeze({
  temperate: {
    cladding: ["clapboard", "clapboard", "clapboard", "render"],
    wallColours: {
      clapboard: [0xe9e5da, 0xe4d8b8, 0xc9a25a, 0xbfc3bc, 0xb1b59a, 0xd9d2c0],
      render: [0xdcd5c4, 0xe2d6b8],
      boards: [0x8a2e24, 0x7a6a58],
    },
    trimColours: [WHITE_TRIM, WHITE_TRIM, 0x2f4a3a, CREAM_TRIM],
    roofs: [
      { covering: "slate", colours: [0x474c53, 0x3f4247, 0x52555a] },
      { covering: "shingle", colours: [0x5b4c40, 0x6a5848, 0x4d4640] },
    ],
    hip: 0.15,
    pitch: [40, 45],
    foundation: "plinth",
    plinthSurface: "stone",
    plinthColour: 0x8b857a,
    chimney: 0.85,
    pipe: false,
    window: [0.9, 1.4, 0.8],
    doorColours: [0x2e4a3c, 0x7a2a22, 0x2a3a52, 0x3a3532],
    shutters: 0.35,
    verandah: false,
    lining: "plaster",
    liningColours: [0xe8e2d4, 0xdcd4c2, 0xe3dccb],
    ceiling: "plaster",
    ceilingColour: 0xefebe2,
    floorColours: [0x8c6a48, 0x9a7a55, 0x7e5e40],
  },
  boreal: {
    cladding: ["boards", "boards", "logs"],
    wallColours: {
      boards: [0x8c2f22, 0x8a3326, 0x96392a, 0xc4973f, 0x7e2b20],
      logs: [0x6e5d4b, 0x7a6650, 0x5f5242],
      clapboard: [0x8c2f22, 0xc4973f],
    },
    trimColours: [WHITE_TRIM, WHITE_TRIM, CREAM_TRIM],
    roofs: [
      { covering: "metal", colours: [0x2b2c2d, 0x2e2f31, 0x5a2722, 0x3a3d40] },
    ],
    hip: 0.1,
    pitch: [40, 45],
    foundation: "piers",
    plinthSurface: "stone",
    plinthColour: 0x7f7c74,
    chimney: 0.9,
    pipe: false,
    window: [1.0, 1.2, 0.85],
    doorColours: [0x5a4434, 0x2f3e4a, 0xe9e5da],
    shutters: 0,
    verandah: false,
    lining: "boards",
    liningColours: [0xc8b08a, 0xd3be98, 0xe6e0d2],
    ceiling: "boards",
    ceilingColour: 0xcdb48c,
    floorColours: [0xa5865e, 0x9a7b55],
  },
  tundra: {
    cladding: ["boards", "clapboard", "boards"],
    wallColours: {
      boards: [0x8a4a3c, 0xb08a4e, 0x4f6a80, 0x5b6e58, 0xb4ae9c],
      clapboard: [0x8a4a3c, 0xb08a4e, 0x4f6a80, 0xbab4a2],
    },
    trimColours: [WHITE_TRIM, CREAM_TRIM, 0xd8d4c8],
    roofs: [
      { covering: "metal", colours: [0x5e6265, 0x6e2e26, 0x2e3032, 0x4a5258] },
    ],
    hip: 0,
    pitch: [35, 42],
    foundation: "posts",
    plinthSurface: "timber",
    plinthColour: 0x4e463e,
    chimney: 0,
    pipe: true,
    window: [0.8, 0.9, 0.95],
    doorColours: [0x3a3f44, 0x6a2a24, 0x2e4250],
    shutters: 0,
    verandah: false,
    lining: "plaster",
    liningColours: [0xe2ddd0, 0xd6d8d2],
    ceiling: "boards",
    ceilingColour: 0xd8ccb2,
    floorColours: [0x8a7458, 0x7a6a56],
  },
  alpine: {
    cladding: ["boards"],
    wallColours: {
      boards: [0x5a4636, 0x654d38, 0x4e3c2e, 0x6b543e],
      logs: [0x5a4636, 0x654d38],
    },
    trimColours: [0x3e2e22, 0x2e4a34, 0xe6e0d4],
    roofs: [
      { covering: "shingle", colours: [0x5d5650, 0x564e48, 0x6a6058] },
      { covering: "metal", colours: [0x4a4e52, 0x3a3c3e] },
    ],
    hip: 0,
    pitch: [25, 30],
    foundation: "plinth",
    plinthSurface: "stone",
    plinthColour: 0x8a867f,
    chimney: 0.8,
    pipe: false,
    window: [0.9, 1.2, 0.85],
    doorColours: [0x4a3424, 0x3e2e22],
    shutters: 0.75,
    verandah: false,
    lining: "boards",
    liningColours: [0xc4a578, 0xb8986c],
    ceiling: "boards",
    ceilingColour: 0xb8986a,
    floorColours: [0x8e6c48, 0x9a7a52],
  },
  desert: {
    cladding: ["render"],
    wallColours: {
      render: [0xc9a27a, 0xd2b48c, 0xbb8d64, 0xd6c29e, 0xc8ab86],
      boards: [0x9a8a74, 0x8a7a66],
      metal: [0xa3a6a2, 0x9a9d99],
    },
    trimColours: [0x5a4030, 0x6a4c36, 0x3f7f7a, 0xe6dccb],
    roofs: [
      { covering: "metal", colours: [0x9b9d99, 0xa2a49f, 0x8a3e2e] },
      { covering: "tile", colours: [0xa4583c, 0x9a4e36, 0xb0664a] },
    ],
    hip: 0.4,
    pitch: [20, 25],
    foundation: "plinth",
    plinthSurface: "stone",
    plinthColour: 0x9c8870,
    chimney: 0.35,
    pipe: false,
    window: [1.0, 1.2, 0.9],
    doorColours: [0x5a4030, 0x3f7f7a, 0x6a2c22],
    shutters: 0.2,
    verandah: true,
    lining: "render",
    liningColours: [0xe4d8c0, 0xdccdb0],
    ceiling: "boards",
    ceilingColour: 0xb89a74,
    floorColours: [0x9a6a4a, 0xa87c5a],
  },
  savanna: {
    cladding: ["clapboard", "clapboard", "boards"],
    wallColours: {
      clapboard: [0xe2d8bc, 0xbcc6a4, 0xe8e6de, 0xe0cc8e, 0xd8d2be],
      boards: [0xe2d8bc, 0xbcc6a4],
      metal: [0x9a9d99, 0xa4a7a3],
    },
    trimColours: [0x2f4a36, 0x8a3a2c, WHITE_TRIM, 0x3a4a5a],
    roofs: [
      { covering: "metal", colours: [0x8f938f, 0x99a09a, 0x8a3a2a, 0x4a6a4a] },
    ],
    hip: 0.75,
    pitch: [22, 28],
    foundation: "stumps",
    plinthSurface: "timber",
    plinthColour: 0x5a4a3a,
    chimney: 0.1,
    pipe: false,
    window: [1.0, 1.3, 0.85],
    doorColours: [0x2f4a36, 0x8a3a2c, 0x3a4a5a],
    shutters: 0,
    verandah: true,
    lining: "plaster",
    liningColours: [0xe8e2d2, 0xdfe2d4],
    ceiling: "boards",
    ceilingColour: 0xdcd2bc,
    floorColours: [0x9a6e46, 0x8a6240],
  },
  tropical: {
    cladding: ["boards", "clapboard"],
    wallColours: {
      boards: [0x8fc2bd, 0xe8c8a0, 0xd6dea6, 0xa9c0de, 0xf0e0b0, 0xe8e6de],
      clapboard: [0x8fc2bd, 0xe8c8a0, 0xd6dea6, 0xa9c0de, 0xf0e0b0, 0xe8e6de],
    },
    trimColours: [WHITE_TRIM, WHITE_TRIM, 0x2e5a6a],
    roofs: [
      { covering: "metal", colours: [0x9a3a2e, 0x3e6a4e, 0x3e5a7a, 0x8a8e8a] },
      { covering: "shingle", colours: [0x5a4a3e, 0x4a4440] },
    ],
    hip: 0.8,
    pitch: [25, 30],
    foundation: "posts",
    plinthSurface: "timber",
    plinthColour: 0x5a4a3a,
    chimney: 0,
    pipe: false,
    window: [1.0, 1.3, 0.8],
    doorColours: [0x2e5a6a, 0x8a3a2c, 0xe8e6de],
    shutters: 0.4,
    verandah: true,
    lining: "boards",
    liningColours: [0xe8e2d2, 0xd8e2dc, 0xe6dcc6],
    ceiling: "boards",
    ceilingColour: 0xe2d8c2,
    floorColours: [0x9a6e46, 0xa0784e],
  },
} satisfies Record<StructureStyle, StyleAccent>);

/** One building's resolved look: every colour and material the kit paints it with. */
export interface StructureLook {
  readonly style: StructureStyle;
  readonly wall: WallCladding;
  readonly wallColour: number;
  /** A chalet's ground storey: stone or render below, timber above. */
  readonly groundWall: WallCladding;
  readonly groundWallColour: number;
  readonly trimColour: number;
  readonly roof: RoofCovering;
  readonly roofColour: number;
  readonly roofForm: RoofForm;
  /** Radians. */
  readonly pitch: number;
  readonly foundation: FoundationLook;
  readonly plinthSurface: StructureSurface;
  readonly plinthColour: number;
  readonly chimney: "masonry" | "pipe" | "none";
  readonly chimneyColour: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly windowSill: number;
  readonly doorColour: number;
  readonly shutters: boolean;
  readonly verandah: boolean;
  readonly lining: StructureSurface;
  readonly liningColour: number;
  readonly ceiling: StructureSurface;
  readonly ceilingColour: number;
  readonly floorColour: number;
  readonly timberColour: number;
  readonly glazingColour: number;
  readonly doorwayColour: number;
  readonly fabricColours: readonly number[];
}

/** The closed shell's glazing: dark, faintly blue glass. */
export const GLAZING_COLOUR = 0x1f262b;
/** The dark inside of an open doorway, seen from outside. */
export const DOORWAY_COLOUR = 0x17130f;

const FABRICS = [0x7a3a32, 0x3e5a72, 0x6a7a4a, 0xb89a5a, 0x8a6a8a, 0xc8c0b0, 0x4a6a6a];

function wallSurfaceOf(cladding: WallCladding): WallCladding {
  return cladding;
}

/** The archetype's cladding in this style: barns and sheds in boards or sheet, cabins in logs where logs grow. */
function claddingFor(archetype: StructureArchetype, style: StructureStyle, accent: StyleAccent, rng: KitRandom): WallCladding {
  switch (archetype) {
    case "barn":
      if (style === "desert" || style === "savanna") return rng.chance(KitChannel.cladding, 0.6) ? "metal" : "boards";
      if (style === "tropical") return rng.chance(KitChannel.cladding, 0.5) ? "metal" : "boards";
      return "boards";
    case "shed":
      if (style === "desert" || style === "savanna" || style === "tropical") return rng.chance(KitChannel.cladding, 0.5) ? "metal" : "boards";
      return "boards";
    case "cabin":
    case "sauna":
      if (style === "boreal" || style === "alpine") return "logs";
      if (style === "desert") return rng.chance(KitChannel.cladding, 0.5) ? "render" : "boards";
      return "boards";
    case "store":
      if (style === "desert") return "render";
      return "boards";
    case "lighthouse":
      return style === "boreal" || style === "alpine" || style === "tundra" ? "stone" : "render";
    default:
      return rng.pick(KitChannel.cladding, accent.cladding);
  }
}

const DEFAULT_COLOURS: Readonly<Record<WallCladding, readonly number[]>> = {
  clapboard: [0xe2ddd0],
  boards: [0x7a6a58, 0x6e5e4e],
  logs: [0x6e5d4b],
  render: [0xe6e2d8, 0xdcd6c8],
  stone: [0x8a867e, 0x9a958c],
  metal: [0x9a9d99],
};

function wallColourFor(archetype: StructureArchetype, style: StructureStyle, cladding: WallCladding, accent: StyleAccent, rng: KitRandom): number {
  if (archetype === "barn" && cladding === "boards") {
    if (style === "temperate" || style === "boreal") return rng.pick(KitChannel.wallColour, [0x8c2f22, 0x7e2b20, 0x6e6458, 0x8a3326]);
    if (style === "alpine") return rng.pick(KitChannel.wallColour, [0x4e3c2e, 0x5a4636]);
    return rng.pick(KitChannel.wallColour, [0x7a6a58, 0x8a7a64, 0x6e6052]);
  }
  if ((archetype === "shed" || archetype === "store") && cladding === "boards" && style !== "boreal" && style !== "tundra") {
    return rng.pick(KitChannel.wallColour, [0x6e6458, 0x7a6a58, 0x5e5448, 0x8a7a66]);
  }
  if (archetype === "lighthouse") {
    return cladding === "stone" ? rng.pick(KitChannel.wallColour, [0x8e8a82, 0x9a958c]) : 0xeae8e2;
  }
  if (cladding === "metal") return rng.pick(KitChannel.wallColour, [0x9a9d99, 0xa3a6a2, 0x8e928e]);
  const list = accent.wallColours[cladding] ?? DEFAULT_COLOURS[cladding];
  return rng.pick(KitChannel.wallColour, list);
}

/** Resolve one record's look from its style, archetype and seed. Pure. */
export function structureLook(record: Pick<StructureRecord, "archetype" | "style" | "seed" | "basalt" | "foundation">): StructureLook {
  const rng = new KitRandom(record.seed);
  const accent = STYLE_ACCENTS[record.style];
  const archetype = record.archetype;
  const wall = wallSurfaceOf(claddingFor(archetype, record.style, accent, rng));
  const wallColour = wallColourFor(archetype, record.style, wall, accent, rng);
  const chalet = record.style === "alpine" && (archetype === "house" || archetype === "station" || archetype === "cottage");
  const groundWall: WallCladding = chalet ? (rng.chance(KitChannel.stone, 0.6) ? "stone" : "render") : wall;
  const groundWallColour = chalet ? (groundWall === "stone" ? 0x8e8a82 : 0xe2ddd2) : wallColour;
  let trimColour = rng.pick(KitChannel.trimColour, accent.trimColours);
  // A white trim on a white wall disappears; take the style's darkest instead.
  if (luminance(trimColour) > 0.75 && luminance(wallColour) > 0.7) {
    trimColour = accent.trimColours.reduce((a, b) => (luminance(a) < luminance(b) ? a : b));
    if (luminance(trimColour) > 0.6) trimColour = 0x3e4a44;
  }
  const roofPick = rng.pick(KitChannel.roofColour, accent.roofs);
  let roof: RoofCovering = roofPick.covering;
  let roofColour = rng.pick(KitChannel.roofColour, roofPick.colours, 1);
  if (archetype === "barn" || archetype === "shed") {
    if (roof === "slate" || roof === "tile") {
      roof = "metal";
      roofColour = rng.pick(KitChannel.roofColour, [0x5e6265, 0x7a3a2e, 0x4a4e52], 2);
    }
  }
  if (record.basalt) roofColour = shadeDark(roofColour);
  const houseLike = archetype === "house" || archetype === "cottage" || archetype === "station";
  const roofForm: RoofForm = houseLike && rng.chance(KitChannel.roofForm, accent.hip) ? "hip"
    : archetype === "lookout" || archetype === "watchtower" || archetype === "lighthouse" ? "hip" : "gable";
  const [p0, p1] = accent.pitch;
  const pitchDegrees = archetype === "barn" ? Math.min(p1, p0 + 5) : p0 + (p1 - p0) * rng.unit(KitChannel.pitch);
  let foundation: FoundationLook = record.foundation === "posts" ? "posts" : accent.foundation === "posts" ? "piers" : accent.foundation;
  if (record.basalt && foundation === "stumps") foundation = "plinth";
  const plinthSurface: StructureSurface = record.basalt ? "basalt"
    : foundation === "posts" || foundation === "stumps" ? "timber" : accent.plinthSurface;
  const plinthColour = record.basalt ? 0x36332f : foundation === "posts" || foundation === "stumps" ? 0x544638 : accent.plinthColour;
  const chimney = archetype === "house" || archetype === "cottage" || archetype === "cabin" || archetype === "station" || archetype === "sauna"
    ? rng.chance(KitChannel.chimney, archetype === "sauna" ? 1 : accent.chimney) ? (archetype === "sauna" || archetype === "cabin" && accent.pipe ? "pipe" : "masonry")
      : accent.pipe || archetype === "cabin" ? "pipe" : "none"
    : "none";
  const chimneyColour = record.basalt ? 0x3a3734 : chimney === "pipe" ? 0x2c2c2c
    : record.style === "desert" ? wallColour : rng.pick(KitChannel.chimney, [0x8a4a3a, 0x8a867e, 0x7a4234], 1);
  const [ww, wh, ws] = accent.window;
  const fabricColours = [0, 1, 2].map((i) => rng.pick(KitChannel.fabric, FABRICS, i));
  return {
    style: record.style,
    wall,
    wallColour,
    groundWall,
    groundWallColour,
    trimColour,
    roof,
    roofColour,
    roofForm,
    pitch: (pitchDegrees * Math.PI) / 180,
    foundation,
    plinthSurface,
    plinthColour,
    chimney,
    chimneyColour,
    windowWidth: ww,
    windowHeight: wh,
    windowSill: ws,
    doorColour: rng.pick(KitChannel.doorColour, accent.doorColours),
    shutters: houseLike && rng.chance(KitChannel.shutters, accent.shutters),
    verandah: accent.verandah,
    lining: wall === "logs" ? "logs" : accent.lining,
    liningColour: wall === "logs" ? wallColour : rng.pick(KitChannel.plaster, accent.liningColours),
    ceiling: accent.ceiling,
    ceilingColour: accent.ceilingColour,
    floorColour: rng.pick(KitChannel.floorTone, accent.floorColours),
    timberColour: record.style === "alpine" || record.style === "boreal" ? 0x5a4a3a : 0x6e5a44,
    glazingColour: GLAZING_COLOUR,
    doorwayColour: DOORWAY_COLOUR,
    fabricColours,
  };
}

function shadeDark(colour: number): number {
  const l = luminance(colour);
  return l > 0.18 ? 0x2e2f30 : colour;
}

/** Relative luminance of an sRGB colour, 0-1 (approximate, in sRGB). */
export function luminance(colour: number): number {
  return (0.2126 * ((colour >> 16) & 255) + 0.7152 * ((colour >> 8) & 255) + 0.0722 * (colour & 255)) / 255;
}
