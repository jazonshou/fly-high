import type { WeatherPreset } from "@/src/game/types";
import {
  createSeaTwin,
  resolveSeaSpectrumConfig,
  SEA_TWIN_CASCADES,
  type SeaTwin,
  type WaveFieldFocus,
} from "@/src/sim/water";
import type { WorldDefinition } from "@/src/world";
import { homeMarina } from "@/src/world/marina";
import { HULL_LENGTH } from "@/src/vehicles/boat/hullLines";

/**
 * The swell a renderer tier does not draw, as the boat's presentation offset.
 *
 * The physics floats the hull on the sea twin, which holds every cascade the
 * canonical sea has. A tier that draws fewer (`profile.oceanCascades`: the low
 * tier three, medium four) shows a sea without the longest swell, so a hull
 * riding that swell would rise out of the drawn water on its crests and sink
 * through it in its troughs. The boat, its spray and the camera that follows
 * it are drawn lowered by the heave of the cascades the tier leaves out
 * (`SeaTwin.undrawnHeave`), so the hull sits on the sea on screen.
 *
 * The renderer's own twin, beside the worker's: the same waves at the same
 * simulation time, focused on the boat, and only the long-wave expansion is
 * ever evaluated. A tier that draws every cascade never builds it.
 */
export class UndrawnSeaHeave {
  private twin: SeaTwin | null = null;
  private weather: WeatherPreset;
  private drawnCascades: number;
  private readonly focus: WaveFieldFocus = { x: 0, z: 0, heading: 0, halfLength: HULL_LENGTH / 2, halfBeam: 1.2 };

  constructor(
    private readonly world: WorldDefinition,
    weather: WeatherPreset,
    drawnCascades: number,
  ) {
    this.weather = weather;
    this.drawnCascades = drawnCascades;
  }

  /** Whether this tier leaves any of the twin's cascades undrawn. */
  get active(): boolean {
    return this.drawnCascades <= SEA_TWIN_CASCADES[SEA_TWIN_CASCADES.length - 1]!;
  }

  /** Whether the twin has been built (tests: a full tier never builds it). */
  get built(): boolean {
    return this.twin !== null;
  }

  setWeather(weather: WeatherPreset): void {
    if (weather === this.weather) return;
    this.weather = weather;
    this.twin?.setConfig(resolveSeaSpectrumConfig(this.world, weather));
  }

  setDrawnCascades(drawnCascades: number): void {
    this.drawnCascades = drawnCascades;
  }

  /**
   * Metres to LOWER the drawn boat by: the undrawn cascades' height at the
   * boat, at `time` (the simulation clock both twins and the GPU sea run on).
   */
  heaveAt(x: number, z: number, heading: number, time: number): number {
    if (!this.active) return 0;
    const twin = this.twin ?? this.build();
    twin.setTime(time);
    this.focus.x = x;
    this.focus.z = z;
    this.focus.heading = heading;
    twin.setFocus(this.focus);
    return twin.undrawnHeave(this.drawnCascades);
  }

  private build(): SeaTwin {
    const twin = createSeaTwin(this.world, this.weather);
    // The marina's basin calms the drawn sea and the worker's twin alike.
    twin.setShelter([homeMarina(this.world).shelter]);
    this.twin = twin;
    return twin;
  }
}
