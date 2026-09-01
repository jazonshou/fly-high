import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/index";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

/**
 * `7-4b` — the clustered lighting surface. Airfield lamps that actually
 * ILLUMINATE, as opposed to `LightPoints`' billboards, which are the lamps you
 * SEE and light nothing.
 *
 * **This module is the consumer that four other items were waiting on.** `7-8`'s
 * landing and taxi lights and `7-14`'s obstruction lights both wire through it,
 * and `7-9`'s tier row cannot carry a clustered light count until something
 * constructs a container. Until this file existed, `ClusteredLightContainer`
 * appeared in `src/` only inside comments.
 *
 * ## The measured constraints this is built around
 *
 * **THE VARYING BUDGET IS THE BINDING ONE, and it is nearly spent.** A container
 * is a scene light: it reaches every material taking Babylon's light loop and
 * costs each exactly **one** `@location` (`vViewDepth`, gated on
 * `CLUSTLIGHT_BATCH > 0` rather than on whether a material has a clustered
 * light, so it lands on all of them). Measured per material against a device
 * maximum of 16:
 *
 *     terrain 15   detail 15   aircraft 14   wildlife 13   ground cover 13   airport 4
 *
 * **Terrain and detail have exactly ONE slot each**, and detail only has that
 * because `7-4b` freed it with `forceIrradianceInFragment`. Before that it sat
 * at 16 of 16 and attaching a container made the foliage stop drawing
 * altogether — pipeline creation fails, it does not degrade.
 * `tests/gpu/interStageBudget.ts` holds those numbers as a live gate.
 *
 * **So an EMPTY container is not free, and this module refuses to build one.**
 * The `vViewDepth` cost is paid by every material the moment a container
 * exists, whether or not it holds a light. Constructing with no definitions
 * therefore leaves `container` null and spends nothing.
 *
 * **THE PER-FRAME FLUSH IS THE COST OF EXISTING, NOT THE COST OF ANIMATING —
 * and I had this backwards.** `_updateLightData` is guarded on the SCENE RENDER
 * ID (`this._lightDataRenderId === renderId`), not on whether any light
 * changed, and its `engine.flushFramebuffer()` on WebGPU sits inside that
 * guard. So the container rewrites its whole light buffer and flushes **once
 * per frame, unconditionally, from the moment it exists**.
 *
 * **Consequence, stated because I told two sessions the opposite:** animating a
 * clustered fixture's intensity adds NOTHING to that cost. There is no
 * performance reason to keep light data static, and a beacon whose cast light
 * flashes is not paying for the privilege. **Price the flush into the baseline
 * for having a container at all; do not treat static data as a way to avoid
 * it.**
 *
 * Whether a given emitter's *illumination* should flash is therefore a LOOK
 * question, not a budget one — the billboard is what you see flashing, and
 * whether the pool of light beneath it flashes too is art direction. Nothing in
 * this class mutates a light after construction, but that is now a default
 * rather than a rule, and a caller with a reason may rebuild.
 *
 * **`IsLightSupported` rejects silently, so this counts rejections.** Babylon's
 * `addLight` merely warns and returns for a light carrying a shadow generator
 * (while shadows are enabled), a non-default falloff, anything that is not a
 * point or spot, or a spot with a projection or IES texture. A caller that
 * assumed its light was added would get no error and no light. `rejectedCount`
 * makes that visible, and the recorded consequence stands: **clustered lights
 * cast no shadows.**
 */

/**
 * Babylon's `_maxSimultaneousLights` default is **4**, and production runs
 * exactly three lights — `sun`, `sky-ambient` and `moon` (`AtmosphereSystem`).
 * **The container is itself a Light**, so it takes the fourth slot and consumes
 * the cap exactly.
 *
 * `PrepareDefinesForLights` `break`s at the cap rather than reporting anything,
 * so the next light added anywhere would silently stop contributing — no error,
 * no warning, just an unlit scene element. Raising the cap costs nothing until
 * the lights exist (Babylon iterates ACTUAL lights, not slots), so the headroom
 * is free and the silence is not worth risking.
 */
export const CLUSTERED_MAX_SIMULTANEOUS_LIGHTS = 6;

/** One clustered emitter. Deliberately not a `LightPointFixture`: those are billboards. */
export interface ClusteredLightDefinition {
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  /** Scene-linear intensity. Static — see the note on `flushFramebuffer`. */
  readonly intensity: number;
  /** Beyond this the light contributes nothing; it is the clustering bound. */
  readonly rangeMeters: number;
}

/**
 * Tile and slice geometry. **Set ONCE, at construction.** Changing any of the
 * three at runtime reallocates the tile-mask texture, the storage buffer and the
 * thin-instance matrix buffer, so these are profile data rather than levers.
 */
export interface ClusteredLightingGeometry {
  readonly horizontalTiles: number;
  readonly verticalTiles: number;
  readonly depthSlices: number;
}

/** Babylon's own defaults, restated so a profile row can be diffed against them. */
export const CLUSTERED_LIGHTING_DEFAULT_GEOMETRY: ClusteredLightingGeometry = Object.freeze({
  horizontalTiles: 64,
  verticalTiles: 64,
  depthSlices: 16,
});

export class ClusteredLightingSystem {
  /** Null when there is nothing to light — see the note on the empty container. */
  readonly container: ClusteredLightContainer | null;
  /** Definitions Babylon's `IsLightSupported` refused, which it does silently. */
  readonly rejected: readonly string[];
  /**
   * Retained even when no container is built. The geometry is profile data and
   * the system is constructed before anything populates it, so holding it here
   * is what lets a later caller add lights without re-deriving the tier row.
   */
  readonly geometry: ClusteredLightingGeometry;
  private readonly lights: readonly PointLight[];

  constructor(
    scene: Scene,
    definitions: readonly ClusteredLightDefinition[],
    geometry: ClusteredLightingGeometry = CLUSTERED_LIGHTING_DEFAULT_GEOMETRY,
  ) {
    this.geometry = geometry;
    if (definitions.length === 0) {
      this.container = null;
      this.lights = [];
      this.rejected = [];
      return;
    }

    const lights: PointLight[] = [];
    const rejected: string[] = [];
    for (const definition of definitions) {
      const light = new PointLight(
        definition.name,
        new Vector3(...definition.position),
        scene,
      );
      light.diffuse = new Color3(...definition.color);
      light.specular = light.diffuse;
      light.intensity = definition.intensity;
      light.range = definition.rangeMeters;
      // Checked BEFORE handing it over: `addLight` only warns on refusal, so a
      // rejected light would otherwise vanish without a signal.
      if (!ClusteredLightContainer.IsLightSupported(light)) {
        rejected.push(definition.name);
        light.dispose();
        continue;
      }
      lights.push(light);
    }

    this.lights = lights;
    this.rejected = rejected;
    if (lights.length === 0) {
      this.container = null;
      return;
    }

    const container = new ClusteredLightContainer("clustered-airfield", lights, scene);
    // Geometry first and once. Assigning after the container has published its
    // buffers is what reallocates them.
    container.horizontalTiles = geometry.horizontalTiles;
    container.verticalTiles = geometry.verticalTiles;
    container.depthSlices = geometry.depthSlices;
    this.container = container;
  }

  /** How many lights the container actually accepted. */
  get lightCount(): number {
    return this.lights.length;
  }

  /**
   * Whether the ENGINE supports clustering at all. Babylon returns a batch size
   * of zero without `texelFetch`, and every light is then refused — so a false
   * here is an engine verdict, not a configuration mistake.
   */
  get supported(): boolean {
    return this.container?.isSupported ?? false;
  }

  dispose(): void {
    this.container?.dispose();
    for (const light of this.lights) light.dispose();
  }
}

/**
 * Raise a receiving material's light-slot cap.
 *
 * Called at every PBR material creation site rather than swept over
 * `scene.materials`, because a material built after the sweep would miss it and
 * the failure is silent: the light simply stops contributing.
 */
export function prepareMaterialForClusteredLighting(material: PBRMaterial): void {
  material.maxSimultaneousLights = CLUSTERED_MAX_SIMULTANEOUS_LIGHTS;
}
