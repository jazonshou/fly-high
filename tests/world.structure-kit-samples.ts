import { hashSeed } from "../src/world/seed";
import { settlementStyleRule } from "../src/world/settlements/settlementStyles";
import { STRUCTURE_BODY, STRUCTURE_STAIR_RISE, structurePorchDepth } from "../src/world/structures/structureEnvelope";
import {
  STRUCTURE_ARCHETYPES,
  STRUCTURE_STYLES,
  type StructureArchetype,
  type StructureRecord,
  type StructureStyle,
} from "../src/world/structures/structureRecord";

/**
 * Sample records for the building kit's tests and shots: one building of
 * every archetype in every style, sized and founded the way the settlement
 * layout does it (`settlementLayout.ts`), on flat ground (plinth styles) or
 * a gentle slope down to the front (posts styles), with `variant` turning
 * the seed and the seeded scale.
 */

const TOWER_LIKE = new Set<StructureArchetype>(["watchtower", "lookout", "lighthouse"]);
const PROPS = new Set<StructureArchetype>(["windmill", "tank", "mast"]);

function unit(seed: number, channel: number): number {
  return (hashSeed(`${seed}:${channel}`) >>> 0) / 4_294_967_296;
}

const round = (v: number) => Math.round(v * 100) / 100;

export function structureKitSample(archetype: StructureArchetype, style: StructureStyle, variant = 0): StructureRecord {
  const rule = settlementStyleRule(style);
  const seed = hashSeed(`kit-sample:${archetype}:${style}:${variant}`);
  const [w, d] = archetype === "house" ? rule.house : STRUCTURE_BODY[archetype];
  const fixed = TOWER_LIKE.has(archetype) || PROPS.has(archetype);
  const scale = fixed ? 1 : 0.9 + 0.2 * unit(seed, 1);
  let storeys = 1;
  if (archetype === "house") storeys = rule.houseStoreys;
  else if (archetype === "watchtower") storeys = 2;
  else if (archetype === "lookout" || archetype === "lighthouse") storeys = 4 + Math.floor(unit(seed, 2) * 3);
  const width = round(w * scale);
  const depth = round(d * scale);
  const [f0, f1] = rule.foundationHeight;
  const foundationHeight = f0 + (f1 - f0) * unit(seed, 3);
  const padY = 120;
  const onPad = rule.foundation === "plinth" || fixed;
  let floorY: number;
  let baseY: number;
  let entryY: number;
  if (onPad) {
    floorY = round(padY + (fixed ? 0.3 : foundationHeight));
    baseY = round(padY - 0.3);
    entryY = padY;
  } else {
    // A slope of 1 in 12 down towards the front: the back corners high, the steps' foot lowest.
    const slope = 1 / 12;
    const hi = padY + slope * depth * 0.5;
    const lo = padY - slope * depth * 0.5;
    floorY = round(Math.max(hi + 0.4, lo + foundationHeight));
    baseY = round(lo - 0.3);
    const start = depth * 0.5 + structurePorchDepth(archetype, style);
    let entry = padY - slope * (start + 0.5);
    for (let pass = 0; pass < 2; pass += 1) {
      const run = Math.max(0, Math.round((floorY - entry) / STRUCTURE_STAIR_RISE)) * 0.28;
      entry = Math.min(entry, padY - slope * (start + run));
    }
    entryY = round(Math.min(entry, floorY - 0.2));
  }
  return Object.freeze({
    id: seed,
    archetype,
    style,
    x: 0,
    z: 0,
    heading: 0,
    width,
    depth,
    storeys,
    floorY,
    baseY,
    entryY,
    foundation: onPad ? "plinth" : "posts",
    seed: hashSeed(`kit-sample:${archetype}:${style}:${variant}:seed`),
    settlement: 1,
    settlementKind: archetype === "lighthouse" ? "lighthouse" : archetype === "lookout" ? "lookout" : "hamlet",
    basalt: false,
  });
}

/** Every archetype in every style, `variants` of each. */
export function structureKitSamples(variants = 1): StructureRecord[] {
  const out: StructureRecord[] = [];
  for (const archetype of STRUCTURE_ARCHETYPES) {
    for (const style of STRUCTURE_STYLES) {
      for (let v = 0; v < variants; v += 1) out.push(structureKitSample(archetype, style, v));
    }
  }
  return out;
}
