/**
 * The 747's flank at a known distance, plus the PROJECTED pixel positions of
 * the things the evidence is about -- so nothing is found by searching the
 * image for a colour (sky passes a naive "blue-dominant" test; that is how the
 * first two edge measurements of the livery went wrong).
 *
 * Projected, through the live camera and the live fuselage-shell world matrix,
 * and written beside the PNG as JSON for `livery-measure.mts` and
 * `livery-band-height.mts`:
 *   - the shell's world matrix W and the camera's view-projection VP;
 *   - every starboard cabin pane centre, from the window mesh's own
 *     thin-instance matrices (both decks).
 *
 *   npx tsx scripts/livery-flank-frames.mts <outDir> <url> <expectTree> <distanceM> <bandTopY> <label> [elevationDeg]
 *
 * `url` is a running dev server; `expectTree` is the absolute path of the
 * checkout it must be serving, checked before anything is captured (two
 * worktrees on two ports look identical from the page). The camera is parked on
 * the STARBOARD flank in the aeroplane's own frame, `distanceM` out along the
 * wing axis and `elevationDeg` above the wing plane, re-parked every frame. The
 * HTML HUD is hidden before the screenshot so nothing painted by the page sits
 * on the flank being measured.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, distanceRaw, bandTopRaw, label, elevationRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree || !distanceRaw || !bandTopRaw || !label) {
  throw new Error("usage: <outDir> <url> <expectTree> <distanceM> <bandTopY> <label> [elevationDeg]");
}
// Camera elevation above the wing plane, degrees. 0 = level with the fuselage
// centre, which puts the dihedral wing across the sight line to the lower flank.
const elevation = Number(elevationRaw ?? 0);
const distance = Number(distanceRaw);
const bandTop = Number(bandTopRaw);
if (!(distance > 5 && distance < 400)) throw new RangeError("distance in (5, 400) m");
if (!Number.isFinite(bandTop)) throw new RangeError("bandTopY must be a number");
if (!Number.isFinite(elevation)) throw new RangeError("elevationDeg must be a number");
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
const pageErrors: string[] = [];
page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
page.on("pageerror", (error) => pageErrors.push(String(error)));
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}
await page.addInitScript(() => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: "airliner", flightMode: "scenic", showDiagnostics: false,
      weather: "clear", timeOfDay: "day", airborneStartAgl: 900,
    }));
  } catch { /* first load */ }
});
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(30_000);

/** The page-side shapes this script reads, and nothing more. */
interface Vec { x: number; y: number; z: number; set(x: number, y: number, z: number): void; clone(): Vec }
interface MeshLike {
  name: string;
  computeWorldMatrix(force: boolean): void;
  getWorldMatrix(): { m: ArrayLike<number> };
  getBoundingInfo(): { boundingBox: { centerWorld: Vec } };
  _thinInstanceDataStorage?: { matrixData?: Float32Array };
}
interface SceneLike {
  meshes: MeshLike[];
  activeCamera: {
    position: Vec;
    upVector: Vec;
    setTarget(target: Vec): void;
    getTransformationMatrix(): { m: ArrayLike<number> };
  } | null;
  onBeforeRenderObservable: { add(callback: () => void): void };
  getEngine(): { getRenderWidth(): number };
}
interface Held { __lvStore?: Record<string, unknown>; __lvScene?: SceneLike; __lvShell?: MeshLike }

// Park on the STARBOARD flank, `distance` metres out along the aeroplane's own
// wing axis, roof up the frame -- re-parked every frame so the game's camera
// cannot take it back.
const parked = await page.evaluate(async ({ d, elevationDeg }: { d: number; elevationDeg: number }) => {
  (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
  const held = globalThis as unknown as Held;
  const storeUrl = performance.getEntriesByType("resource").map((r) => r.name)
    .find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
  if (!storeUrl) return "no engine store";
  held.__lvStore ??= await import(/* @vite-ignore */ storeUrl) as Record<string, unknown>;
  const store = Object.values(held.__lvStore)
    .find((v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances)) as
    { Instances: { scenes: SceneLike[] }[] } | undefined;
  const scene = store?.Instances[0]?.scenes[0];
  if (!scene) return "no scene";
  const shell = scene.meshes.find((m) => m.name === "airliner-fuselage-shell");
  if (!shell) return "no airliner-fuselage-shell (is the airliner flying?)";
  held.__lvShell = shell;
  held.__lvScene = scene;
  scene.onBeforeRenderObservable.add(() => {
    shell.computeWorldMatrix(true);
    const m = shell.getWorldMatrix().m;
    const unit = (a: number, b: number, c: number) => {
      const l = Math.hypot(a, b, c) || 1;
      return [a / l, b / l, c / l] as const;
    };
    const roof = unit(m[4]!, m[5]!, m[6]!);
    const wing = unit(m[8]!, m[9]!, m[10]!);
    const c = shell.getBoundingInfo().boundingBox.centerWorld;
    const cam = scene.activeCamera;
    if (!cam) return;
    const e = (elevationDeg * Math.PI) / 180;
    const ce = Math.cos(e);
    const se = Math.sin(e);
    const dir = [0, 1, 2].map((k) => wing[k]! * ce + roof[k]! * se);
    cam.position.set(c.x + dir[0]! * d, c.y + dir[1]! * d, c.z + dir[2]! * d);
    cam.upVector.set(roof[0], roof[1], roof[2]);
    const target = cam.position.clone();
    target.set(c.x, c.y, c.z);
    cam.setTarget(target);
  });
  return "parked";
}, { d: distance, elevationDeg: elevation });
if (parked !== "parked") throw new Error(`VOID: ${parked}`);
await page.waitForTimeout(4_000);
// The canvas and every element that CONTAINS it stay visible; everything else
// is visibility:hidden, which keeps layout, so the canvas is not resized.
const hidden = await page.evaluate(() => {
  let count = 0;
  for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    if (element.tagName === "CANVAS" || element.querySelector("canvas")) continue;
    element.style.visibility = "hidden";
    count += 1;
  }
  return count;
});
await page.waitForTimeout(500);
const stem = `${outDir}/${label}-side-${distance}m${elevation ? `-el${elevation}` : ""}`;
const png = `${stem}.png`;
await page.screenshot({ path: png, type: "png" });

// Read from the SAME relative geometry: the camera is parked in the aeroplane's
// own frame every frame, so the relative projection is frame-stable.
const projected = await page.evaluate(() => {
  const held = globalThis as unknown as Held;
  const scene = held.__lvScene!;
  const shell = held.__lvShell!;
  const cam = scene.activeCamera!;
  const W = Array.from(shell.getWorldMatrix().m);
  const VP = Array.from(cam.getTransformationMatrix().m);
  const ndc = (w: readonly number[]) => {
    const cx = w[0]! * VP[0]! + w[1]! * VP[4]! + w[2]! * VP[8]! + VP[12]!;
    const cy = w[0]! * VP[1]! + w[1]! * VP[5]! + w[2]! * VP[9]! + VP[13]!;
    const cw = w[0]! * VP[3]! + w[1]! * VP[7]! + w[2]! * VP[11]! + VP[15]!;
    return [cx / cw, cy / cw];
  };
  // Pane centres, from the window mesh's thin-instance matrices (body frame).
  const win = scene.meshes.find((m) => m.name === "airliner-cabin-window-line");
  const panes: { deck: string; body: number[]; ndc: number[] }[] = [];
  const data = win?._thinInstanceDataStorage?.matrixData;
  if (win && data) {
    win.computeWorldMatrix(true);
    const WW = Array.from(win.getWorldMatrix().m);
    for (let i = 0; i < data.length / 16; i += 1) {
      const lx = data[i * 16 + 12]!;
      const ly = data[i * 16 + 13]!;
      const lz = data[i * 16 + 14]!;
      if (lz <= 0) continue; // starboard only: the flank facing the camera
      const world = [0, 1, 2].map((k) => lx * WW[k]! + ly * WW[4 + k]! + lz * WW[8 + k]! + WW[12 + k]!);
      panes.push({ deck: ly > 1.5 ? "upper" : "main", body: [lx, ly, lz], ndc: ndc(world) });
    }
  }
  return { W, VP, panes, renderWidth: scene.getEngine().getRenderWidth() };
});

writeFileSync(`${stem}.json`, JSON.stringify({
  label, distance, elevation, bandTop, png, pageErrors, hudElementsHidden: hidden, ...projected,
}, null, 2));
console.log(`wrote ${png} + projection json: ${projected.panes.length} starboard panes; page errors: ${pageErrors.length}`);
await browser.close();
