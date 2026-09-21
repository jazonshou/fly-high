/**
 * The top of the fuselage, straight down, in raking light.
 *
 * A normal discontinuity along a loft's closing seam is a SHADING defect: the
 * geometry is continuous, so it cannot be seen in a wireframe, in a silhouette
 * or from any angle where the spine is edge-on. It shows as a line down the
 * middle of the top surface, and only when a light is low enough for the two
 * sides to return different amounts of it. So: camera directly overhead, nose
 * up the frame, `timeOfDay: golden`.
 *
 * The camera is parked every frame rather than once, because the game drives
 * its own camera each tick and would take it back before the shutter.
 *
 *   npx tsx scripts/spine-frames.mts <outDir> <url> <expectTree> <kind> [height]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kind, heightRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree || !kind) {
  throw new Error("usage: <outDir> <url> <expectTree> <kind> [height]");
}
// VALIDATED, not defaulted. A shell loop that loses its second argument hands
// this script `kind = "airliner 95"` and no height, and with a default height
// and an unchecked kind it would shoot every airframe at the wrong distance
// and say nothing. It has already done exactly that once.
const KINDS = ["trainer", "jet", "bizjet", "airliner"] as const;
if (!(KINDS as readonly string[]).includes(kind)) {
  throw new RangeError(`kind must be one of ${KINDS.join(", ")}, not "${kind}"`);
}
if (heightRaw === undefined) throw new RangeError("height is required; there is no sensible default across the fleet");
const height = Number(heightRaw);
if (!(height > 2 && height < 400)) throw new RangeError("height must be in (2, 400) metres");
const WIDTH = 1280;
const HEIGHT = 1280;
mkdirSync(outDir, { recursive: true });

const probe = await fetch(new URL(`/@fs${expectTree}/package.json`, url).toString());
if (!probe.ok) throw new Error(`${url} is NOT serving ${expectTree} (${probe.status}); nothing captured.`);
console.log(`serving: ${expectTree}`);

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
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}
await page.addInitScript((wantedKind: string) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: wantedKind,
      flightMode: "scenic",
      showDiagnostics: false,
      weather: "clear",
      // The whole point: a low sun. At `day` the light is near enough overhead
      // that both sides of the spine return the same amount of it and the seam
      // is invisible however wrong the normals are.
      timeOfDay: "golden",
      airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
}, kind);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(30_000);

/** Park the camera overhead, and keep parking it. */
const parked = await page.evaluate(async ({ above, airframe }: { above: number; airframe: string }) => {
  (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
  const storeUrl = performance.getEntriesByType("resource")
    .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
  if (!storeUrl) return "no engine store";
  const g = globalThis as unknown as { __spineStore?: unknown };
  if (!g.__spineStore) g.__spineStore = await import(/* @vite-ignore */ storeUrl);
  const store = Object.values(g.__spineStore as Record<string, unknown>).find(
    (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
  ) as { Instances: { scenes: unknown[] }[] } | undefined;
  const scene = store?.Instances[0]?.scenes[0] as {
    meshes: { name: string; getTotalVertices: () => number; computeWorldMatrix: (f: boolean) => void;
      getBoundingInfo: () => { boundingBox: { centerWorld: { x: number; y: number; z: number } } } }[];
    activeCamera: Record<string, unknown> | null;
    onBeforeRenderObservable: { add: (fn: () => void) => unknown };
  } | undefined;
  if (!scene) return "no scene";
  const body = scene.meshes.find((m) =>
    new RegExp(`${airframe}-fuselage|${airframe}-fuselage-shell|fuselage`).test(m.name)
    && m.getTotalVertices() > 0);
  if (!body) return "no fuselage mesh";
  const camera = scene.activeCamera;
  if (!camera) return "no active camera";
  scene.onBeforeRenderObservable.add(() => {
    body.computeWorldMatrix(true);
    const c = body.getBoundingInfo().boundingBox.centerWorld;
    // THE AEROPLANE'S OWN FRAME, not the world's. It is flying a heading, so
    // world +X is not the nose and world +Y is not its roof; parking the
    // camera on world axes photographs it from whatever angle it happens to
    // be pointing. Babylon stores the world matrix so that m[0..2] is the
    // image of local +X (the nose) and m[4..6] of local +Y (the roof).
    const m = (body as unknown as { getWorldMatrix: () => { m: number[] } }).getWorldMatrix().m;
    const noseLength = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    const roofLength = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
    const nose = [m[0]! / noseLength, m[1]! / noseLength, m[2]! / noseLength];
    const roof = [m[4]! / roofLength, m[5]! / roofLength, m[6]! / roofLength];
    const cam = scene.activeCamera as unknown as {
      position: { set: (x: number, y: number, z: number) => void; constructor: new (x: number, y: number, z: number) => unknown };
      upVector: { set: (x: number, y: number, z: number) => void };
      setTarget: (v: unknown) => void;
    } | null;
    if (!cam) return;
    cam.position.set(
      c.x + roof[0]! * above,
      c.y + roof[1]! * above,
      c.z + roof[2]! * above,
    );
    // Nose up the frame.
    cam.upVector.set(nose[0]!, nose[1]!, nose[2]!);
    const Point = cam.position.constructor as new (x: number, y: number, z: number) => unknown;
    cam.setTarget(new Point(c.x, c.y, c.z));
  });
  return "parked";
}, { above: height, airframe: kind });
if (parked !== "parked") throw new Error(`VOID: could not park the camera (${parked}); nothing captured`);
console.log(`camera parked ${height} m above the ${kind}`);
await page.waitForTimeout(4_000);
await page.screenshot({ path: `${outDir}/${kind}-spine.png`, type: "png" });
console.log(`wrote ${outDir}/${kind}-spine.png`);
await browser.close();
