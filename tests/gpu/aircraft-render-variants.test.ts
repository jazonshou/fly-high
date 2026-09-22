import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fragmentInputCount, INTER_STAGE_LIMIT } from "./interStageBudget";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";
import { AIRCRAFT_KINDS, type AircraftKind } from "../../src/sim";
import { aircraftCameraLayerMask, createWebGpuAircraft, type AircraftVisual } from "../../src/render/webgpu/aircraft";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "../../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { ClusteredLightingSystem } from "../../src/render/webgpu/lighting/ClusteredLighting";
import { AIRCRAFT_CAST_POOLS, aircraftWashLights } from "../../src/render/webgpu/lighting/AircraftLighting";
import { DEFAULT_ENVIRONMENT_STATE } from "../../src/render/webgpu/nature/EnvironmentState";

/**
 * THE AIRCRAFT IN THE PASSES GATE A DOES NOT BUILD.
 *
 * Gate A (`aircraft-material-compile.test.ts`) compiles every airframe in a
 * container-less rig and holds each material to 15 of 16, leaving the slot
 * the clustered container takes. That covers one permutation per pass it
 * builds, and there are passes it does not build: its reflection probe has an
 * empty render list, and it has no clip plane, no fog, no night lamps and no
 * cockpit layers. Each of those can add a fragment input, and at 16 of 16 one
 * input is the difference between a mesh that draws and a device that refuses
 * the pipeline -- which the game shows as a BLACK CANVAS UNDER A LIVE HUD.
 *
 * So this builds each airframe, in a scene of its own, WITH the container
 * (built as FlightRenderer builds it in every flight: the aircraft's own cast
 * pools and wash lights), in five variants:
 *
 *   day         the baseline: sun and its four-cascade CSM, sky fill, probe.
 *   reflection  the aircraft IN a reflection pass: Babylon's MirrorTexture
 *               under a water plane, the aircraft in its render list -- what
 *               the lake capture 5-12 plans would build. The live game has no
 *               such pass today (2-10 retired the mirror). Its clip plane is
 *               the input it costs.
 *   night       sun down, a dim moon, the container's lamps lit.
 *   cockpit     the camera's layer mask cleared of the exterior layer, as the
 *               cockpit view does: the shell is hidden from the camera but
 *               still casts into the CSM through the shadow-depth shader.
 *   fog         Babylon scene fog, one more input on every lit material.
 *
 * For each: every device error during the variant's own frames, the worst
 * fragment-input count per material over EVERY render pass (read from each
 * sub-mesh's compiled effect, as Gate A does), and pixels read back from a
 * target rendered DIRECTLY -- this environment cannot read back anything that
 * rides the canvas swapchain (see `light-points-radiometry.test.ts`).
 *
 * Two invariants hold whatever the counts are: the counter and the device
 * agree (over 16 exactly when the device refuses), and the 747 draws in every
 * variant. A last test is the positive control: the black-screen layout (the
 * shell with a second UV set and a colour channel) must be refused, and seen
 * to be.
 */

const SIZE = 192;
type Variant = "day" | "reflection" | "night" | "cockpit" | "fog";
const VARIANTS: readonly Variant[] = ["day", "reflection", "night", "cockpit", "fog"];

/** The variants that are passes the game draws TODAY. Over budget in one of these is a hard fail. */
const LIVE_VARIANTS: ReadonlySet<Variant> = new Set(["day", "night", "cockpit"]);

/**
 * Materials over budget in a pass that does NOT exist live today, each keyed
 * airframe/material/variant with its reason. Asserted BOTH ways: the test
 * fails if a listed material stops being over (the entry is stale -- remove
 * it) and if any material not listed goes over (a regression). Registered as
 * "Global body needs a varying freed (its painted band -> a livery texture, as
 * the 747's) before 5-12 puts aircraft in the lake capture or fog is enabled".
 */
const KNOWN_OVER_BUDGET: ReadonlyMap<string, string> = new Map([
  ["bizjet/bizjet-body/reflection", "carries vertex colour: 16 of 16 live, and the mirror's clip plane is a 17th"],
  ["bizjet/bizjet-body/fog", "carries vertex colour: 16 of 16 live, and fog is a 17th"],
]);

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
let device: GPUDevice;
const gpuErrors: string[] = [];

interface Reading {
  readonly kind: AircraftKind;
  readonly variant: Variant;
  /** Worst count over every pass, per material. */
  readonly inputs: ReadonlyMap<string, number>;
  readonly errors: readonly string[];
  /** Pixels that differ from the clear colour, and how bright the brightest of them is. */
  readonly drawn: number;
  readonly peakLuminance: number;
}
const readings: Reading[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);
  // SPEC-DEFAULT LIMITS, as FlightRenderer asks for them. A device granted
  // more inputs would let the over-budget control compile and make every
  // verdict here vacuous.
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/**
 * One canvas frame, opened and CLOSED as the engine's own render loop does. A
 * bare `scene.render()` leaves the frame open, and the swapchain texture it
 * acquired is presented (destroyed) as soon as the test yields -- after which
 * the next submit that still references it is refused ("Destroyed texture
 * ... WebgpuSwapChainTexture ... used in a submit"), once per scene.
 */
function canvasFrame(scene: Scene): void {
  engine.beginFrame();
  scene.render();
  engine.endFrame();
}

/** Every device error the frames since `offset` produced, once the queue has drained. */
async function errorsSince(offset: number): Promise<string[]> {
  await device.queue.onSubmittedWorkDone();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return gpuErrors.slice(offset);
}

/** The worst fragment-input count per material over every render pass the meshes were drawn in. */
function worstInputs(meshes: readonly AbstractMesh[]): Map<string, number> {
  const worst = new Map<string, number>();
  for (const mesh of meshes) {
    const material = mesh.material?.name ?? "(none)";
    for (const subMesh of mesh.subMeshes ?? []) {
      const wrappers = (subMesh as unknown as {
        _drawWrappers: ({ effect?: { fragmentSourceCode?: string } | null } | undefined)[];
      })._drawWrappers ?? [];
      for (const wrapper of wrappers) {
        const code = wrapper?.effect?.fragmentSourceCode ?? "";
        if (code) worst.set(material, Math.max(worst.get(material) ?? 0, fragmentInputCount(code)));
      }
    }
  }
  return worst;
}

/** Pixels that differ from the clear colour, and the peak luminance among them. */
function drawnPixels(pixels: ArrayBufferView, clear: Color4): { drawn: number; peakLuminance: number } {
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const cr = Math.round(clear.r * 255);
  const cg = Math.round(clear.g * 255);
  const cb = Math.round(clear.b * 255);
  let drawn = 0;
  let peakLuminance = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const r = bytes[index]!;
    const g = bytes[index + 1]!;
    const b = bytes[index + 2]!;
    if (Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) <= 6) continue;
    drawn += 1;
    peakLuminance = Math.max(peakLuminance, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return { drawn, peakLuminance };
}

interface Rig {
  scene: Scene;
  camera: FreeCamera;
  visual: AircraftVisual;
  lighting: ClusteredLightingSystem;
  /** The airframe's extent, for placing cameras and the water plane. */
  centre: Vector3;
  radius: number;
  lowestY: number;
}

/** The shipping lighting and receivers around one airframe, with the container attached. */
async function buildRig(kind: AircraftKind, night: boolean): Promise<Rig> {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.05, 0.09, 0.13, 1);
  const visual = createWebGpuAircraft(scene, kind);
  visual.update({ ...INITIAL_VISUAL_STATE, engineRpm: 2_250, simulationTime: 1 }, 1 / 60);
  visual.root.computeWorldMatrix(true);
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of visual.meshes) {
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, box.minimumWorld);
    max = Vector3.Maximize(max, box.maximumWorld);
  }
  const centre = min.add(max).scale(0.5);
  const radius = max.subtract(min).length() / 2;

  const camera = new FreeCamera(`${kind}-variant-camera`, centre.add(new Vector3(-0.9, 0.55, 1.6).scale(radius * 1.6)), scene);
  camera.setTarget(centre);
  camera.minZ = 0.5;
  camera.maxZ = radius * 20;
  scene.activeCamera = camera;

  const sun = new DirectionalLight(`${kind}-variant-sun`, new Vector3(-0.6, -0.8, 0.2).normalize(), scene);
  sun.intensity = night ? 0 : 2.4;
  const fill = new HemisphericLight(`${kind}-variant-fill`, Vector3.Up(), scene);
  fill.intensity = night ? 0.04 : 0.7;
  if (night) {
    const moon = new DirectionalLight(`${kind}-variant-moon`, new Vector3(0.3, -0.9, -0.3).normalize(), scene);
    moon.diffuse = new Color3(0.7, 0.75, 0.9);
    moon.intensity = 0.05;
  }
  const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
  shadows.numCascades = 4;
  for (const mesh of visual.meshes) {
    if (mesh.metadata?.castsShadow !== false) shadows.addShadowCaster(mesh, false);
  }
  const probe = new ReflectionProbe(`${kind}-variant-probe`, 16, scene, true, true);
  scene.environmentTexture = probe.cubeTexture;
  new CloudShadowReceiverRegistry().registerMeshes(visual.meshes);
  const aerial = new AerialPerspectiveRegistry();
  aerial.registerMeshes(visual.meshes);
  aerial.setProjection({
    state: DEFAULT_ENVIRONMENT_STATE,
    cameraAltitudeMeters: camera.position.y,
    sunColor: [1, 0.95, 0.88],
    skyHorizonColor: [0.35, 0.55, 0.72],
    sunIlluminanceNormalized: night ? 0 : 1,
    moonDirection: [0, -1, 0],
    moonIlluminanceNormalizedToFull: night ? 1 : 0,
  }, 0, 0);

  // THE CONTAINER, as FlightRenderer builds it in every flight: the cast pools
  // and this airframe's wash lights, sited on the airframe. Lit at night only,
  // as the daylight attenuation leaves them by day -- but present either way,
  // which is what costs the slot.
  const world = visual.root.getWorldMatrix();
  const site = (offset: readonly [number, number, number]) => {
    const at = Vector3.TransformCoordinates(new Vector3(...offset), world);
    return [at.x, at.y, at.z] as const;
  };
  const lighting = new ClusteredLightingSystem(scene, [
    ...AIRCRAFT_CAST_POOLS.map((pool) => ({
      name: pool.name, position: site(pool.offset), color: pool.color,
      intensity: night ? pool.intensity : 0, rangeMeters: pool.rangeMeters,
    })),
    ...aircraftWashLights(kind).map((wash) => ({
      name: wash.name, position: site(wash.offset), color: wash.color,
      intensity: night ? wash.intensity : 0, rangeMeters: wash.rangeMeters,
    })),
  ]);
  expect(lighting.container, `${kind}: no clustered container -- the rig is lighter than a flight`).not.toBeNull();
  expect(lighting.rejected, `${kind}: lamps the container refused`).toEqual([]);
  return { scene, camera, visual, lighting, centre, radius, lowestY: min.y };
}

/** A target rendered DIRECTLY (never through the swapchain), readable afterwards. */
function directTarget(name: string, scene: Scene, camera: FreeCamera, meshes: readonly AbstractMesh[], clear: Color4) {
  const target = new RenderTargetTexture(name, SIZE, scene, { generateMipMaps: false, generateDepthBuffer: true });
  target.activeCamera = camera;
  target.renderList = [...meshes];
  target.clearColor = clear;
  return target;
}

async function measure(kind: AircraftKind, variant: Variant): Promise<Reading> {
  const offset = gpuErrors.length;
  const rig = await buildRig(kind, variant === "night");
  const { scene, camera, visual } = rig;
  const clear = scene.clearColor;
  let target: RenderTargetTexture;
  try {
    if (variant === "fog") {
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.5 / (rig.radius * 20);
      scene.fogColor = new Color3(0.6, 0.66, 0.72);
    }
    if (variant === "cockpit") {
      visual.setCockpitView(true);
      camera.layerMask = aircraftCameraLayerMask(camera.layerMask, true);
    }
    if (variant === "reflection") {
      // Babylon's own mirror under a water plane a quarter-radius below the
      // airframe: it renders the scene through the reflected view matrix with
      // `scene.clipPlane` set to the water, as a planar lake capture would.
      const water = rig.lowestY - rig.radius * 0.25;
      // Aimed at the REFLECTED airframe -- its centre mirrored through the
      // water -- so the reflection is on the target for every airframe. Aimed
      // at the airframe itself, the reflection fell off the top of the mirror
      // for the small ones, and a body the mirror never draws never builds a
      // pipeline for the device to refuse.
      camera.setTarget(new Vector3(rig.centre.x, 2 * water - rig.centre.y, rig.centre.z));
      const mirror = new MirrorTexture(`${kind}-reflection`, SIZE, scene, false);
      mirror.mirrorPlane = new Plane(0, -1, 0, water);
      mirror.renderList = [...visual.meshes];
      mirror.clearColor = clear;
      target = mirror;
    } else {
      target = directTarget(`${kind}-${variant}-view`, scene, camera, visual.meshes, clear);
      target.renderList = [...visual.meshes].filter((mesh) => (mesh.layerMask & camera.layerMask) !== 0);
    }
    const drawTarget = () => target.render();
    const drawnNow = async () => {
      const pixels = await target.readPixels();
      return pixels ? drawnPixels(pixels, clear).drawn : 0;
    };

    // The canvas pass first: it renders the shadow maps and updates the
    // container, and compiles the main view's permutations. Then the target,
    // directly, until its meshes are ready.
    await scene.whenReadyAsync();
    for (let frame = 0; frame < 3; frame += 1) canvasFrame(scene);
    // SETTLED, not "ready": the target's own pass compiles its permutations
    // (the mirror's with its clip plane) only as it draws, and a body not yet
    // compiled is simply skipped -- no pixels, and no pipeline for the device
    // to refuse. Asking the meshes answers for the main pass, which the canvas
    // frames have already warmed, and `isReadyForRendering()` binds inside the
    // presented frame, which this environment cannot do (the destroyed
    // swapchain texture of `light-points-radiometry.test.ts`). So: draw the
    // target directly, and read it back until two readbacks agree.
    let previous = -1;
    let settled = false;
    for (let round = 0; round < 12 && !settled; round += 1) {
      for (let frame = 0; frame < 10; frame += 1) {
        drawTarget();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const drawn = await drawnNow();
      settled = drawn === previous;
      previous = drawn;
    }
    expect(settled, `${kind}/${variant}: the target never settled`).toBe(true);
    const pixels = await target.readPixels();
    const errors = await errorsSince(offset);
    const { drawn, peakLuminance } = pixels ? drawnPixels(pixels, clear) : { drawn: 0, peakLuminance: 0 };
    return { kind, variant, inputs: worstInputs(visual.meshes), errors, drawn, peakLuminance };
  } finally {
    rig.lighting.dispose();
    visual.dispose();
    scene.dispose();
  }
}

describe("aircraft render variants, container attached", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`${kind}: day, reflection, night, cockpit and fog`, async () => {
      for (const variant of VARIANTS) readings.push(await measure(kind, variant));
    }, 180_000);
  }

  it("agrees with the device, draws the 747 in every variant, and refuses only the known materials", () => {
    const PAINT = /-(body|skin|accent|underside|spoiler)$/u;
    const table = readings.map((reading) => {
      const paints = [...reading.inputs].filter(([material]) => PAINT.test(material))
        .sort((a, b) => a[0].localeCompare(b[0])).map(([material, inputs]) => `${material} ${inputs}`).join(", ");
      return `${reading.kind.padEnd(8)} ${reading.variant.padEnd(10)} errors ${String(reading.errors.length).padStart(2)}`
        + `  drawn ${String(reading.drawn).padStart(5)}  peak ${reading.peakLuminance.toFixed(0).padStart(3)}  | ${paints}`;
    });
    console.log(`AIRCRAFT RENDER VARIANTS, container attached (limit ${INTER_STAGE_LIMIT}):\n${table.join("\n")}`);
    expect(readings.length, "a variant was never measured").toBe(AIRCRAFT_KINDS.length * VARIANTS.length);

    // THE INSTRUMENT: over 16 by count exactly where the device refused.
    const refused = readings.filter((r) => r.errors.length > 0).map((r) => `${r.kind}/${r.variant}`).sort();
    const overCount = readings.filter((r) => Math.max(...r.inputs.values()) > INTER_STAGE_LIMIT)
      .map((r) => `${r.kind}/${r.variant}`).sort();
    expect(overCount, "the input counter disagrees with the device").toEqual(refused);

    const over = readings.flatMap((r) => [...r.inputs]
      .filter(([, inputs]) => inputs > INTER_STAGE_LIMIT)
      .map(([material]) => ({ key: `${r.kind}/${material}/${r.variant}`, live: LIVE_VARIANTS.has(r.variant) })));
    // A PASS THE GAME DRAWS TODAY: nothing over, anywhere. Hard fail.
    expect(over.filter((entry) => entry.live).map((entry) => entry.key), "over budget in a LIVE pass").toEqual([]);
    // A PASS THAT DOES NOT EXIST LIVE: exactly the known materials, both ways.
    expect(over.filter((entry) => !entry.live).map((entry) => entry.key).sort(),
      "over-budget materials differ from KNOWN_OVER_BUDGET (a new one, or a listed one that is fixed)")
      .toEqual([...KNOWN_OVER_BUDGET.keys()].sort());

    // THE 747, in every variant: no refusal, and the airframe on the target,
    // not black. Its skin is at 16 of 16 in the passes that add an input --
    // no headroom, but it draws.
    for (const reading of readings.filter((r) => r.kind === "airliner")) {
      expect(reading.errors, `airliner/${reading.variant}: the device refused a pipeline`).toEqual([]);
      const skin = reading.inputs.get("airliner-skin");
      expect(skin, `airliner/${reading.variant}: the skin was never compiled`).toBeDefined();
      expect(skin, `airliner/${reading.variant}: airliner-skin inputs`).toBe(reading.variant === "reflection" || reading.variant === "fog" ? 16 : 15);
    }
    // Everything that was not refused drew something that is not black.
    for (const reading of readings.filter((r) => r.errors.length === 0)) {
      expect(reading.drawn, `${reading.kind}/${reading.variant}: nothing drawn`).toBeGreaterThan(SIZE * SIZE * 0.02);
      expect(reading.peakLuminance, `${reading.kind}/${reading.variant}: drawn, but black`).toBeGreaterThan(20);
    }
  });

  it("sees the black-screen build refused: the 747 shell with a second UV set and colour, container attached", async () => {
    // POSITIVE CONTROL for the whole file: the build that blacked out the 747,
    // rebuilt -- the shell with UV1, a SECOND UV set carrying the livery, and a
    // colour channel, with the container attached. That is 17. (A colour
    // channel alone on today's UV1 skin is 16, a legal pipeline -- measured,
    // and the reason this control carries both.) If the device accepts this,
    // or its refusal never reaches `gpuErrors`, every "no error" above is
    // meaningless.
    const offset = gpuErrors.length;
    const rig = await buildRig("airliner", false);
    try {
      const shell = rig.scene.getMeshByName("airliner-fuselage-shell");
      expect(shell).toBeInstanceOf(Mesh);
      const coloured = (shell as Mesh).clone("airliner-fuselage-shell-coloured");
      coloured.makeGeometryUnique();
      coloured.setVerticesData(VertexBuffer.ColorKind, new Array<number>(coloured.getTotalVertices() * 4).fill(1), false);
      coloured.setVerticesData(VertexBuffer.UV2Kind, Array.from(coloured.getVerticesData(VertexBuffer.UVKind)!), false);
      // Its own material, so the shipped skin keeps reading UV1.
      const material = (coloured.material as PBRMaterial).clone("airliner-skin-control");
      material.albedoTexture!.coordinatesIndex = 1;
      coloured.material = material;
      const target = directTarget("control", rig.scene, rig.camera, [coloured], rig.scene.clearColor);
      await rig.scene.whenReadyAsync();
      for (let frame = 0; frame < 3; frame += 1) canvasFrame(rig.scene);
      for (let frame = 0; frame < 30; frame += 1) {
        target.render();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const errors = await errorsSince(offset);
      const inputs = Math.max(...worstInputs([coloured]).values());
      console.log(`CONTROL: shell + colour reads ${inputs} inputs; device errors ${errors.length}: ${errors[0] ?? "-"}`);
      expect(inputs, "the control is not over the limit: it cannot test anything").toBeGreaterThan(INTER_STAGE_LIMIT);
      expect(errors.some((message) => /fragment input variables/iu.test(message)),
        "the device's refusal never reached the harness").toBe(true);
    } finally {
      rig.lighting.dispose();
      rig.visual.dispose();
      rig.scene.dispose();
    }
  }, 120_000);
});
