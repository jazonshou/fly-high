import { mixSeed } from "../../seed";

/**
 * The kit's dice: one independent channel per choice, so adding a new choice
 * never moves an old one, and the same record always throws the same dice.
 * A channel is a small integer the caller names (`KitChannel`); `index`
 * separates repeats of the same choice (the n-th window, the n-th room).
 */
export class KitRandom {
  constructor(private readonly seed: number) {}

  /** A number in [0, 1) for this channel and index. */
  unit(channel: number, index = 0): number {
    return (mixSeed(mixSeed(this.seed >>> 0, channel), index) >>> 0) / 4_294_967_296;
  }

  range(channel: number, low: number, high: number, index = 0): number {
    return low + (high - low) * this.unit(channel, index);
  }

  pick<T>(channel: number, items: readonly T[], index = 0): T {
    return items[Math.min(items.length - 1, Math.floor(this.unit(channel, index) * items.length))]!;
  }

  chance(channel: number, share: number, index = 0): boolean {
    return this.unit(channel, index) < share;
  }
}

/** The named channels. Append; never renumber (renumbering re-rolls every building). */
export const KitChannel = Object.freeze({
  wallColour: 1,
  trimColour: 2,
  roofColour: 3,
  doorColour: 4,
  plan: 5,
  mirror: 6,
  roofForm: 7,
  pitch: 8,
  cladding: 9,
  chimney: 10,
  porchWidth: 11,
  furniture: 12,
  fabric: 13,
  ridge: 14,
  shutters: 15,
  woodpile: 16,
  split: 17,
  stairEnd: 18,
  accent: 19,
  floorTone: 20,
  windmillTurn: 21,
  mastHeight: 22,
  tankHeight: 23,
  stone: 24,
  plaster: 25,
  attic: 26,
  roomPaint: 27,
  decor: 28,
});
