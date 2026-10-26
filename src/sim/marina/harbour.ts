import type { BoatControlState } from "@/src/game/types";
import type { WorldDefinition } from "@/src/world";
import { homeMarina } from "@/src/world/marina";
import { solveRestWaterline, type BoatSimulator } from "../boat/boatSimulator";
import { ColliderWorld } from "../colliders";
import { rotateVectorInto } from "../math";
import type { Vec3 } from "../types";
import type { WaterSurfaceAuthority } from "../water/types";
import { addMarinaColliders, poseMarinaPontoons, type MarinaColliders } from "./colliders";
import { MarinaContactLoad } from "./contact";
import { Mooring } from "./mooring";

const BODY_FORWARD: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });

/**
 * The home marina as one boat meets it: the structures as colliders, the
 * boat's mooring lines, and the hull's contact with piles, decks and
 * pontoons, wired in the order `Mooring` documents. The worker builds one per
 * boat it installs; nothing here waits for terrain, because every collider
 * and berth comes from `homeMarina(world)`.
 *
 * The hull's contact is `MarinaContactLoad` alone (its per-material crash
 * speeds are what the marina's tests hold), so the simulator's environment is
 * given no colliders of its own.
 */
export class MarinaHarbour {
  readonly colliders = new ColliderWorld();
  readonly marina: MarinaColliders;
  readonly mooring: Mooring;
  readonly contact: MarinaContactLoad;
  private readonly forward: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cleatWorld = (index: number, out: Vec3): Vec3 =>
    this.boat.body.bodyToWorldPoint(this.boat.cleatsBody[index]!, out);

  constructor(world: WorldDefinition, private readonly boat: BoatSimulator) {
    const layout = homeMarina(world);
    this.marina = addMarinaColliders(this.colliders, layout);
    this.mooring = new Mooring(layout, this.colliders, this.marina, {
      cleatsBody: boat.cleatsBody,
      cgAboveWater: solveRestWaterline(boat.definition).cgAboveWater,
    });
    this.contact = new MarinaContactLoad(this.colliders);
    // The lines own mooring: the simulator stops counting presses, casting
    // off on the lever and holding its own berth, and follows `setMoored`.
    boat.setMooringOwner("external");
    boat.addExternalLoad(this.mooring);
    boat.addExternalLoad(this.contact);
  }

  /** The dock start: made fast in the start berth, lines at the lengths they have now. */
  makeFastAtStart(world: WorldDefinition): void {
    this.mooring.makeFast(homeMarina(world).startBerth, this.heading(), this.cleatWorld);
    this.boat.setMoored(true);
  }

  /** Once per fixed step, after `water.setTime` and before the boat steps. */
  beforeStep(controls: Readonly<BoatControlState>, scenic: boolean, water: WaterSurfaceAuthority): void {
    poseMarinaPontoons(this.colliders, this.marina, water);
    this.mooring.update(
      controls,
      scenic,
      this.boat.body.position,
      this.boat.body.velocity,
      this.heading(),
      this.cleatWorld,
    );
  }

  /** After the boat steps: the simulator's flag (the HUD's MOORED) follows the lines. */
  afterStep(): void {
    this.boat.setMoored(this.mooring.state === "moored");
  }

  private heading(): number {
    rotateVectorInto(this.forward, this.boat.body.orientation, BODY_FORWARD);
    return Math.atan2(this.forward.x, this.forward.z);
  }
}
