import type { WeatherPreset } from "@/src/game/types";
import { homeMarina } from "@/src/world/marina";
import type { WorldDefinition } from "@/src/world/types";
import { createSeaTwin } from "../water/seaTwin";
import type { SpectralOceanConfig } from "../water/spectrumConfig";
import type { HullWaterSampler, WaterBedPoint, WaterSurfaceSample, WaveFieldFocus } from "../water/types";

/**
 * How far above sea level the car's own ground must stand for the sea to be
 * dry there for certain, metres: more than a tyre's contact can stand off the
 * lattice point under it.
 */
export const CAR_SEA_DRY_MARGIN = 0.1;

/**
 * The twin is stepped once it is this far behind the car's time, seconds:
 * every fourth step at 120 Hz. In between, a sample is carried to the car's
 * time by the surface's vertical velocity.
 */
export const CAR_SEA_TWIN_SECONDS = 0.03;

/** The sea twin as the car uses it (`SeaTwin`; tests pass a stand-in). */
export interface CarSeaTwin extends HullWaterSampler {
  setConfig(config: SpectralOceanConfig): void;
}

/**
 * The sea the car wades: the boat's sea twin (the drawn ocean's spectrum,
 * seed and weather, calmed in the home marina's basin), asked only where
 * the car is in it.
 *
 * The drawn ocean exists only over ground below the still sea level; above
 * it the terrain owns the swash (SpectralOceanSystem). So the car meets the
 * sea only where its own ground is under the still level, up to the twin's
 * surface, and it decides that itself (`GroundVehicleSimulator`): the twin
 * reads no bed, and `isDry` answers from the car's ground. A car whose
 * wheels all stand higher never steps or samples the twin: its time and
 * the car's footprint are held here and handed over only with a sample.
 *
 * Every sample costs the twin's per-step work, about 115 us, as a boat's
 * 171 do (most of it the 8-32 m band's grid, rebuilt every 71 ms). For the
 * car's four points the twin is stepped every `twinSeconds` instead and
 * each sample carried to the car's time by the surface's vertical velocity.
 */
export class CarSea implements HullWaterSampler {
  private time = Number.NaN;
  private twinTime = Number.NaN;
  private readonly focus: WaveFieldFocus = { x: 0, z: 0, heading: 0, halfLength: 1, halfBeam: 1 };

  constructor(
    private readonly twin: CarSeaTwin,
    private readonly seaLevel: number,
    private readonly twinSeconds = CAR_SEA_TWIN_SECONDS,
  ) {}

  /** A new sea state (a weather change): the twin rebuilds its waves, about 0.2 s. */
  setConfig(config: SpectralOceanConfig): void {
    this.twin.setConfig(config);
  }

  setTime(time: number): void {
    this.time = time;
  }

  setFocus(focus: Readonly<WaveFieldFocus>): void {
    this.focus.x = focus.x;
    this.focus.z = focus.z;
    this.focus.heading = focus.heading;
    this.focus.halfLength = focus.halfLength;
    this.focus.halfBeam = focus.halfBeam;
  }

  /** Dry for certain where the car's ground stands over the still sea: the sea is not drawn there. */
  isDry(at: Readonly<WaterBedPoint>): boolean {
    return at.height > this.seaLevel + CAR_SEA_DRY_MARGIN;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const time = this.time;
    const behind = time - this.twinTime;
    // The footprint goes over with the time, so the twin's track (which its
    // grid leads along) is the car's over the same interval.
    if (Number.isFinite(time) && !(behind >= 0 && behind < this.twinSeconds)) {
      this.twin.setTime(time);
      this.twin.setFocus(this.focus);
      this.twinTime = time;
    }
    this.twin.sample(x, z, out);
    const lag = time - this.twinTime;
    if (lag > 0) out.height += out.velocity.y * lag;
    return out;
  }
}

/** The car's sea for a session: the twin the boat would get, under the session's weather, with no bed. */
export function createCarSea(world: WorldDefinition, weather: WeatherPreset): CarSea {
  const twin = createSeaTwin(world, weather);
  twin.setShelter([homeMarina(world).shelter]);
  return new CarSea(twin, world.seaLevel);
}
