/**
 * Photograph the COCKPIT view of each airframe in the shipped page, and refuse
 * to save a frame that is not what it claims to be.
 *
 * Two poses per airframe: level flight in daylight (the scenic airborne start,
 * left to settle) and stopped on the runway (the runway start). Every capture
 * asserts, from the LIVE scene rather than from the requested arguments,
 *
 *   - the HUD names the view COCKPIT (the camera key cycles, so it is pressed
 *     until the HUD says so and the HUD is what is believed);
 *   - the aircraft in the scene is the kind that was asked for (read from the
 *     root node's own `aircraftKind` metadata), because an earlier capture
 *     flew a Cessna under an F-16 label when a variable the init script closed
 *     over serialised to `undefined` — values are passed in as ARGUMENTS here;
 *   - the camera really sits at the catalogue's `cockpitEye` — `forward`, `up`
 *     AND `right` — in the aircraft's body frame, and has the lens it is
 *     supposed to (`cockpitHorizontalFieldOfViewForAspect` for this window:
 *     `COCKPIT_HORIZONTAL_FOV_DEGREES` up to 16:9, wider beyond), both read from
 *     the same modules the renderer reads and never typed here, so a frame is
 *     never described by what the code is supposed to do. A mismatch throws.
 *
 * Nothing is written to the page or to src/: the reader is a closure inside one
 * page.evaluate that reaches the scene through Vite's optimised copy of
 * Babylon's engineStore.
 *
 * LENS: to judge a lens before committing to it, `LENS=68` (degrees, horizontal)
 * makes the page's copy of `cameraPresentation.ts` be served with
 * `COCKPIT_HORIZONTAL_FOV_DEGREES` rewritten, so the RENDERER genuinely runs at
 * that lens — terrain LOD, shadow cascades and all — with no hook in src/. The
 * rewrite is counted and the run fails if it never matched; the live camera's
 * field of view is then asserted against the requested lens. Output names gain
 * `-lens68`.
 *
 *   npx tsx scripts/cockpit-frames.mts <outDir> <url> <expectTree> [kinds] [poses]
 *   npx tsx scripts/cockpit-frames.mts /tmp/f http://localhost:3030/ "$PWD" trainer,jet air,runway
 *   LENS=82 npx tsx scripts/cockpit-frames.mts /tmp/f http://localhost:3030/ "$PWD" trainer air,runway
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import {
  COCKPIT_HORIZONTAL_FOV_DEGREES,
  PERF_COCKPIT_HORIZONTAL_FOV_DEGREES,
  cockpitHorizontalFieldOfViewForAspect,
} from "@/src/render/cameraPresentation";
import type { AircraftKind } from "@/src/sim";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kindsArgument, posesArgument] = process.argv.slice(2);
if (!outDir || !url || !expectTree) {
  throw new Error("usage: <outDir> <url> <expectTree> [kinds] [poses]");
}
const KINDS = (kindsArgument ?? "trainer,jet,bizjet,airliner").split(",");
const POSES = (posesArgument ?? "air,runway").split(",");
for (const pose of POSES) if (pose !== "air" && pose !== "runway") throw new Error(`unknown pose ${pose}`);
const WIDTH = Number(process.env.FRAME_WIDTH ?? 1600);
const HEIGHT = Number(process.env.FRAME_HEIGHT ?? 900);
/** Seconds to let each start settle before switching view: a phugoid is a frame of an aeroplane doing something. */
const SETTLE_SECONDS = { air: Number(process.env.SETTLE_AIR ?? 22), runway: Number(process.env.SETTLE_RUNWAY ?? 10) };
/**
 * Which view to photograph: the cockpit (default), or the chase or orbit camera
 * to prove nothing cockpit-only shows from outside. The camera key cycles
 * chase -> cockpit -> orbit, and the HUD's label is what is believed.
 */
const VIEW = (process.env.VIEW ?? "cockpit") as "cockpit" | "chase" | "orbit";
const WANTED_HUD = { cockpit: "COCKPIT", chase: "CHASE CAM", orbit: "ORBIT CAM" }[VIEW];
if (!WANTED_HUD) throw new Error(`VIEW=${process.env.VIEW} is not cockpit, chase or orbit`);
/** A lens to try instead of the shipped one, in degrees horizontal; null = the shipped lens. */
const LENS_REQUEST = process.env.LENS === undefined || process.env.LENS === "" ? null : Number(process.env.LENS);
if (LENS_REQUEST !== null && !(LENS_REQUEST > 20 && LENS_REQUEST < 150)) {
  throw new Error(`LENS=${process.env.LENS} is not a plausible horizontal field of view`);
}
/**
 * The lens every frame in this run must have: the one the renderer resolves for this window
 * (the constant up to 16:9), unless a lens was requested. A requested lens is only checked as
 * given, so LENS on a window wider than 16:9 fails loudly rather than being reinterpreted.
 */
const EXPECTED_LENS = LENS_REQUEST ?? cockpitHorizontalFieldOfViewForAspect(null, WIDTH / HEIGHT);
mkdirSync(outDir, { recursive: true });
console.log(
  `lens: COCKPIT_HORIZONTAL_FOV_DEGREES = ${COCKPIT_HORIZONTAL_FOV_DEGREES} (gameplay; the perf harness keeps`
  + ` ${PERF_COCKPIT_HORIZONTAL_FOV_DEGREES}); this run (${WIDTH} x ${HEIGHT}) expects ${EXPECTED_LENS.toFixed(3)}`
  + `${LENS_REQUEST === null ? "" : " (REQUESTED by LENS, served-source rewrite)"}`,
);
console.log("eye: catalogue cockpitEye {forward, up, right} per kind, asserted against the live camera");

// Which tree is answering? A dev server that cannot bind its port does not fail.
const identity = await fetch(new URL(`/@fs${expectTree}/package.json`, url).toString());
if (!identity.ok) {
  throw new Error(`${url} is NOT serving ${expectTree} (${identity.status}); nothing captured.`);
}
console.log(`serving: ${expectTree} (verified via /@fs)`);

// HEADED, as the other capture scripts are: headless only renders on demand.
const browser = await chromium.launch({
  ...chromiumStdioLaunchOptions(),
  channel: "chromium",
  headless: false,
  args: [
    "--disable-crashpad-for-testing", "--disable-crash-reporter",
    "--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU",
    `--window-size=${WIDTH},${HEIGHT + 120}`,
  ],
});
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}

interface SceneReading {
  readonly aircraftKind: string | null;
  readonly cameraFovDegrees: number;
  readonly cameraFovMode: number;
  readonly cameraMinZ: number;
  readonly cameraLayerMask: number;
  readonly cameraPosition: readonly [number, number, number];
  readonly rootPosition: readonly [number, number, number];
  /** Camera position minus root position, rotated into the aircraft's body frame (+X nose, +Y up, +Z starboard). */
  readonly eyeInBodyFrame: readonly [number, number, number];
  readonly rootQuaternion: readonly [number, number, number, number];
  readonly hud: string;
  /** `isVisible` of every cockpit-only mesh (`metadata.cockpitOnly`) present in the scene, by name. */
  readonly cockpitOnly: Readonly<Record<string, boolean>>;
}

async function readScene(page: import("playwright").Page): Promise<SceneReading> {
  return page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) throw new Error("no engineStore chunk in the page");
    const store = await import(/* @vite-ignore */ storeUrl) as Record<string, unknown>;
    const holder = Object.values(store).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    if (!holder) throw new Error("engineStore has no Instances");
    interface Vec { x: number; y: number; z: number }
    interface Quat extends Vec { w: number }
    interface SceneLike {
      activeCamera: { position: Vec; fov: number; fovMode: number; minZ: number; layerMask: number } | null;
      transformNodes: { name: string; position: Vec; rotationQuaternion: Quat | null; metadata: { aircraftVisual?: boolean; aircraftKind?: string } | null }[];
      meshes: { name: string; isVisible: boolean; metadata: { cockpitOnly?: boolean } | null }[];
    }
    const scenes = holder.Instances.flatMap((engine) => engine.scenes as SceneLike[]);
    const scene = scenes.find((s) => s.transformNodes.some((n) => n.metadata?.aircraftVisual));
    if (!scene) throw new Error("no scene holds an aircraft root");
    const root = scene.transformNodes.find((n) => n.metadata?.aircraftVisual)!;
    const camera = scene.activeCamera;
    if (!camera) throw new Error("scene has no active camera");
    const q = root.rotationQuaternion ?? { x: 0, y: 0, z: 0, w: 1 };
    // Rotate (camera - root) by the INVERSE of the root's orientation.
    const v = { x: camera.position.x - root.position.x, y: camera.position.y - root.position.y, z: camera.position.z - root.position.z };
    const c = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const tx = 2 * (c.y * v.z - c.z * v.y);
    const ty = 2 * (c.z * v.x - c.x * v.z);
    const tz = 2 * (c.x * v.y - c.y * v.x);
    const body = {
      x: v.x + c.w * tx + (c.y * tz - c.z * ty),
      y: v.y + c.w * ty + (c.z * tx - c.x * tz),
      z: v.z + c.w * tz + (c.x * ty - c.y * tx),
    };
    return {
      aircraftKind: root.metadata?.aircraftKind ?? null,
      cameraFovDegrees: (camera.fov * 180) / Math.PI,
      cameraFovMode: camera.fovMode,
      cameraMinZ: camera.minZ,
      cameraLayerMask: camera.layerMask,
      cameraPosition: [camera.position.x, camera.position.y, camera.position.z] as const,
      rootPosition: [root.position.x, root.position.y, root.position.z] as const,
      eyeInBodyFrame: [body.x, body.y, body.z] as const,
      rootQuaternion: [q.x, q.y, q.z, q.w] as const,
      hud: document.body.innerText.replace(/\s+/g, " ").slice(0, 160),
      cockpitOnly: Object.fromEntries(
        scene.meshes
          .filter((m) => m.metadata?.cockpitOnly === true)
          .map((m) => [m.name, m.isVisible]),
      ),
    };
  });
}

/** The view the HUD names. */
function hudView(hud: string): string {
  return /\b(CHASE CAM|COCKPIT|ORBIT CAM|FREE CAM)\b/.exec(hud)?.[1] ?? "unknown";
}

async function capture(kind: string, pose: "air" | "runway"): Promise<void> {
  const label = `${kind}-${pose}${VIEW === "cockpit" ? "" : `-${VIEW}`}${LENS_REQUEST === null ? "" : `-lens${LENS_REQUEST}`}`;
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  let lensRewrites = 0;
  try {
    if (LENS_REQUEST !== null) {
      // Serve the renderer's own constant with the requested value, so the
      // camera the page builds is the camera being judged.
      await context.route(/cameraPresentation\.ts/, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const pattern = /(export const COCKPIT_HORIZONTAL_FOV_DEGREES\s*=\s*)[0-9.]+/;
        if (!pattern.test(body)) {
          await route.fulfill({ response, body });
          return;
        }
        lensRewrites += 1;
        await route.fulfill({ response, body: body.replace(pattern, `$1${LENS_REQUEST}`) });
      });
    }
    const page = await context.newPage();
    // Passed as an ARGUMENT, never closed over: the function is serialised
    // and a captured variable arrives as undefined.
    await page.addInitScript((wanted: { kind: string }) => {
      localStorage.setItem("aerolith.settings.v3", JSON.stringify({
        aircraft: wanted.kind,
        flightMode: "scenic",
        showDiagnostics: false,
        weather: "clear",
        timeOfDay: "day",
        airborneStartAgl: 900,
      }));
    }, { kind });
    await page.goto(url!, { waitUntil: "domcontentloaded" });
    await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 180_000 });
    await page.waitForTimeout(2_500);
    if (pose === "runway") {
      await page.getByRole("button", { name: /Start on the runway/ }).click();
    } else {
      await page.getByRole("button", { name: /^Start flying/ }).click();
    }
    await page.waitForTimeout(SETTLE_SECONDS[pose] * 1_000);

    // The camera key CYCLES: press it until the HUD names the wanted view.
    let reading = await readScene(page);
    for (let press = 0; press < 4 && hudView(reading.hud) !== WANTED_HUD; press += 1) {
      await page.keyboard.press("KeyC");
      await page.waitForTimeout(1_400);
      reading = await readScene(page);
    }
    await page.waitForTimeout(2_000);
    reading = await readScene(page);

    // ASSERT before saving. Each of these has failed for real in this repo.
    if (hudView(reading.hud) !== WANTED_HUD) {
      throw new Error(`${label}: HUD says ${hudView(reading.hud)}, not ${WANTED_HUD} (${reading.hud})`);
    }
    if (reading.aircraftKind !== kind) {
      throw new Error(`${label}: the scene holds a "${reading.aircraftKind}", not the requested "${kind}"`);
    }
    // Cockpit-only parts (every airframe has them now; the F-16's is its HUD frame): drawn in
    // cockpit view, and in NO other. Read from the live scene, so a part that leaks into a
    // chase or orbit frame fails here instead of being noticed, or not, in the PNG.
    const cockpitOnlyNames = Object.keys(reading.cockpitOnly);
    // Trainer 15 since it kept three dials (19 with the second row); Global 7 on its P1 panel; 747 6 on its P1 panel
    // (4 until its framed, recessed screens brought the bezels' rims and the wells); the F-16 5, its HUD frame, its
    // housing, its combiner's panes and its MFDs' bezels and screens. The same counts as tests/render.cockpit-drawn-faces.
    const expectedCockpitOnly: Readonly<Record<string, number>> = { trainer: 15, bizjet: 7, airliner: 6, jet: 5 };
    const expectedCount = expectedCockpitOnly[kind];
    if (expectedCount !== undefined) {
      if (cockpitOnlyNames.length !== expectedCount) {
        throw new Error(`${label}: expected the ${kind}'s ${expectedCount} cockpit-only meshes in the scene, found ${cockpitOnlyNames.length}`);
      }
      const wrong = cockpitOnlyNames.filter((name) => reading.cockpitOnly[name] !== (VIEW === "cockpit"));
      if (wrong.length > 0) {
        throw new Error(`${label}: cockpit-only meshes with the wrong visibility for the ${VIEW} view: ${wrong.join(", ")}`);
      }
    }
    if (VIEW !== "cockpit") {
      const png = `${outDir}/${label}.png`;
      await page.screenshot({ path: png, type: "png" });
      writeFileSync(`${outDir}/${label}.json`, `${JSON.stringify({ label, kind, pose, view: VIEW, url, expectTree, ...reading }, null, 2)}\n`);
      console.log(`${label}: HUD ${hudView(reading.hud)}, scene kind ${reading.aircraftKind}, ${cockpitOnlyNames.length} cockpit-only meshes, all INVISIBLE here (asserted from the live scene) -> ${png}`);
      return;
    }
    if (LENS_REQUEST !== null && lensRewrites === 0) {
      throw new Error(`${label}: LENS=${LENS_REQUEST} was requested but the served cameraPresentation module was never rewritten; this frame is at the shipped lens`);
    }
    // The lens and the eye are asserted against the modules the renderer reads.
    // A horizontal-fixed camera reports its horizontal field of view directly.
    if (reading.cameraFovMode !== 1) {
      throw new Error(`${label}: camera fovMode ${reading.cameraFovMode}, not horizontal-fixed (1); every angle in this script assumes it`);
    }
    if (Math.abs(reading.cameraFovDegrees - EXPECTED_LENS) > 0.01) {
      throw new Error(`${label}: live lens ${reading.cameraFovDegrees.toFixed(3)} deg, expected ${EXPECTED_LENS}`);
    }
    const catalogueEye = aircraftSpec(kind as AircraftKind).cockpitEye;
    const expectedEye = [catalogueEye.forward, catalogueEye.up, catalogueEye.right] as const;
    const liveEye = reading.eyeInBodyFrame;
    for (const [axis, expected] of expectedEye.entries()) {
      if (Math.abs(liveEye[axis]! - expected) > 0.005) {
        throw new Error(
          `${label}: live eye (${liveEye.map((v) => v.toFixed(3)).join(", ")}) is not the catalogue's`
          + ` (${expectedEye.join(", ")}) on axis ${["forward", "up", "right"][axis]}`,
        );
      }
    }
    const png = `${outDir}/${label}.png`;
    await page.screenshot({ path: png, type: "png" });
    writeFileSync(`${outDir}/${label}.json`, `${JSON.stringify({
      label, kind, pose, url, expectTree,
      expected: { lensDegrees: EXPECTED_LENS, lensRequested: LENS_REQUEST, eyeForwardUpRight: expectedEye },
      lensRewrites,
      ...reading,
    }, null, 2)}\n`);
    const [bx, by, bz] = reading.eyeInBodyFrame;
    console.log(
      `${label}: HUD ${hudView(reading.hud)}, scene kind ${reading.aircraftKind}, eye in body frame `
      + `(${bx.toFixed(3)}, ${by.toFixed(3)}, ${bz.toFixed(3)}) == catalogue (${expectedEye.join(", ")}), `
      + `lens ${reading.cameraFovDegrees.toFixed(2)} deg == expected ${EXPECTED_LENS}${LENS_REQUEST === null ? "" : ` (${lensRewrites} module rewrite(s))`}, `
      + `fov `
      + `${reading.cameraFovMode === 1 ? "HORIZONTAL-fixed" : reading.cameraFovMode === 0 ? "vertical-fixed" : `mode ${reading.cameraFovMode}`}, `
      + `minZ ${reading.cameraMinZ}, layerMask ${(reading.cameraLayerMask >>> 0).toString(16)} -> ${png}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

for (const kind of KINDS) {
  for (const pose of POSES as ("air" | "runway")[]) {
    await capture(kind, pose);
  }
}
await browser.close();
console.log("frames written");
