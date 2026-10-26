import type { BoatControlState } from "@/src/game/types";
import type { WorldDefinition } from "@/src/world";
import { homeMarina } from "@/src/world/marina";
import { solveRestWaterline, type BoatEnvironment, type BoatSimulator } from "../boat/boatSimulator";
import { ColliderWorld } from "../colliders";
import { rotateVectorInto } from "../math";
import type { SurfaceVehicleEnvironment } from "../surface/types";
import type { Vec3 } from "../types";
import { addMarinaColliders, poseMarinaPontoons, type MarinaColliders } from "./colliders";
import { Mooring } from "./mooring";

const BODY_FORWARD: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });

/**
 * The home marina as one boat meets it: the structures as colliders and the
 * boat's mooring lines, wired in the order `Mooring` documents. The worker
 * builds one per boat it installs; nothing here waits for terrain, because
 * every collider and berth comes from `homeMarina(world)`.
 *
 * The hull meets piles, decks and pontoons through the simulator's own
 * collider contact, the one contact model for every collider a boat meets:
 * each step hands the boat the worker's environment with the marina's
 * colliders added (`beforeStep`).
 */
export class MarinaHarbour {
  readonly colliders = new ColliderWorld();
  readonly marina: MarinaColliders;
  readonly mooring: Mooring;
  private readonly environment: BoatEnvironment = {};
  private readonly forward: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cleatWorld = (index: number, out: Vec3): Vec3 =>
    this.boat.body.bodyToWorldPoint(this.boat.cleatsBody[index]!, out);

  constructor(world: WorldDefinition, private readonly boat: BoatSimulator) {
    const layout = homeMarina(world);
    this.marina = addMarinaColliders(this.colliders, layout);
    const rest = solveRestWaterline(boat.definition);
    this.mooring = new Mooring(layout, this.colliders, this.marina, {
      cleatsBody: boat.cleatsBody,
      cgAboveWater: rest.cgAboveWater,
      trim: rest.trim,
    });
    // The lines own mooring: the simulator stops counting presses, casting
    // off on the lever and holding its own berth, and follows `setMoored`.
    boat.setMooringOwner("external");
    boat.addExternalLoad(this.mooring);
  }

  /** The dock start: made fast in the start berth, lines at the lengths they have now. */
  makeFastAtStart(world: WorldDefinition): void {
    this.mooring.makeFast(homeMarina(world).startBerth, this.heading(), this.cleatWorld);
    this.boat.setMoored(true);
  }

  /**
   * Once per fixed step, after `water.setTime` and before the boat steps: the
   * boat gets `environment` and the marina's colliders, the pontoons ride the
   * water, and the lines take up or pay out.
   */
  beforeStep(controls: Readonly<BoatControlState>, scenic: boolean, environment: Readonly<SurfaceVehicleEnvironment>): void {
    Object.assign(this.environment, environment);
    this.environment.colliders = this.colliders;
    this.boat.setEnvironment(this.environment);
    poseMarinaPontoons(this.colliders, this.marina, environment.water);
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
