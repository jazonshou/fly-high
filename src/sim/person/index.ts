import type { PersonSimulator, PersonSpawn } from "./types";
import { Walker } from "./walker";

export * from "./types";

/** The one place the walking session gets the walker's simulator from. */
export function createPersonSimulator(spawn: PersonSpawn): PersonSimulator {
  return new Walker(spawn);
}
