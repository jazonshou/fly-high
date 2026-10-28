import { StandInWalker } from "./standInWalker";
import type { PersonSimulator, PersonSpawn } from "./types";

export * from "./types";

/** The one place the walking session gets the walker's simulator from. */
export function createPersonSimulator(spawn: PersonSpawn): PersonSimulator {
  return new StandInWalker(spawn);
}
