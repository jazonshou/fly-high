/**
 * The 747's nose and flight-deck glass at a known distance and angle, with the
 * glazing's and the centre post's PROJECTED bounding boxes written beside the
 * PNG -- so a crop is placed from the geometry, never by searching the image.
 *
 *   npx tsx scripts/nose-glazing-frames.mts <outDir> <url> <expectTree> <distanceM> <label> [elevationDeg] [azimuthDeg]
 *
 * `azimuthDeg` turns the camera round the aeroplane in its own frame: 0 is
 * abeam to starboard, 90 dead astern, -90 dead ahead, -45 the three-quarter
 * front (the default). `elevationDeg` (default 10) lifts it above the wing
 * plane. The camera aims at the centre of the glazing's world box and is
 * re-parked every frame. Which checkout the dev server serves is proved from
 * the listening process's working directory before anything is captured.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, distanceRaw, label, elevationRaw, azimuthRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree || !distanceRaw || !label) {
  throw new Error("usage: <outDir> <url> <expectTree> <distanceM> <label> [elevationDeg] [azimuthDeg]");
}
const distance = Number(distanceRaw);
const elevation = Number(elevationRaw ?? 10);
const azimuth = Number(azimuthRaw ?? -45);
if (!(distance > 5 && distance < 400)) throw new RangeError("distance in (5, 400) m");
if (!Number.isFinite(elevation) || !Number.isFinite(azimuth)) throw new RangeError("angles must be numbers");
const WIDTH = 1280;
const HEIGHT = 1280;
mkdirSync(outDir, { recursive: true });

const port = new URL(url).port;
const listener = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0];
const cwd = execFileSync("lsof", ["-a", "-p", listener!, "-d", "cwd", "-Fn"], { encoding: "utf8" })
  .split("\n").find((line) => line.startsWith("n"))?.slice(1);
if (!cwd || realpathSync(cwd) !== realpathSync(expectTree)) {
  throw new Error(`${url} is served by pid ${listener} from ${cwd}, NOT ${expectTree}; nothing captured.`);
}
console.log(`serving: ${expectTree} (pid ${listener})`);

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

interface Vec { x: number; y: number; z: number; set(x: number, y: number, z: number): void; clone(): Vec }
interface MeshLike {
  name: string;
  computeWorldMatrix(force: boolean): void;
  getWorldMatrix(): { m: ArrayLike<number> };
  getBoundingInfo(): { boundingBox: { vectorsWorld: Vec[] } };
}
interface SceneLike {
  meshes: MeshLike[];
  activeCamera: { position: Vec; upVector: Vec; setTarget(target: Vec): void; getTransformationMatrix(): { m: ArrayLike<number> } } | null;
  onBeforeRenderObservable: { add(callback: () => void): void };
}
interface Held { __spStore?: Record<string, unknown>; __spScene?: SceneLike }
const TARGETS = /^airliner-(flight-deck-glazing|windscreen-center-post)$/;

const parked = await page.evaluate(async ({ d, el, az, pattern }: { d: number; el: number; az: number; pattern: string }) => {
  (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
  const held = globalThis as unknown as Held;
  const storeUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
  if (!storeUrl) return "no engine store";
  held.__spStore ??= await import(/* @vite-ignore */ storeUrl) as Record<string, unknown>;
  const store = Object.values(held.__spStore).find((v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances)) as
    { Instances: { scenes: SceneLike[] }[] } | undefined;
  const scene = store?.Instances[0]?.scenes[0];
  if (!scene) return "no scene";
  const matcher = new RegExp(pattern);
  const targets = scene.meshes.filter((m) => matcher.test(m.name));
  const shell = scene.meshes.find((m) => m.name === "airliner-fuselage-shell");
  if (targets.length !== 2 || !shell) return `expected the glazing, the post and the shell, found ${targets.length}`;
  held.__spScene = scene;
  scene.onBeforeRenderObservable.add(() => {
    shell.computeWorldMatrix(true);
    const m = shell.getWorldMatrix().m;
    const unit = (a: number, b: number, c: number) => { const l = Math.hypot(a, b, c) || 1; return [a / l, b / l, c / l] as const; };
    const forward = unit(m[0]!, m[1]!, m[2]!);
    const roof = unit(m[4]!, m[5]!, m[6]!);
    const wing = unit(m[8]!, m[9]!, m[10]!);
    // Aim: the centre of the glazing's and the post's world boxes.
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const mesh of targets) {
      mesh.computeWorldMatrix(true);
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) { sx += corner.x; sy += corner.y; sz += corner.z; n += 1; }
    }
    const aim = { x: sx / n, y: sy / n, z: sz / n };
    const cam = scene.activeCamera;
    if (!cam) return;
    const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
    const dir = [0, 1, 2].map((k) => Math.cos(e) * (Math.cos(a) * wing[k]! - Math.sin(a) * forward[k]!) + Math.sin(e) * roof[k]!);
    cam.position.set(aim.x + dir[0]! * d, aim.y + dir[1]! * d, aim.z + dir[2]! * d);
    cam.upVector.set(roof[0], roof[1], roof[2]);
    const target = cam.position.clone();
    target.set(aim.x, aim.y, aim.z);
    cam.setTarget(target);
  });
  return "parked";
}, { d: distance, el: elevation, az: azimuth, pattern: TARGETS.source });
if (parked !== "parked") throw new Error(`VOID: ${parked}`);
await page.waitForTimeout(4_000);
await page.evaluate(() => {
  for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    if (element.tagName === "CANVAS" || element.querySelector("canvas")) continue;
    element.style.visibility = "hidden";
  }
});
await page.waitForTimeout(500);
const stem = `${outDir}/${label}-nose-${distance}m-el${elevation}-az${azimuth}`;
await page.screenshot({ path: `${stem}.png`, type: "png" });

// The glazing's and the post's boxes, projected to PNG pixels.
const boxes = await page.evaluate(({ pattern, width, height }: { pattern: string; width: number; height: number }) => {
  const scene = (globalThis as unknown as Held).__spScene!;
  const VP = Array.from(scene.activeCamera!.getTransformationMatrix().m);
  const matcher = new RegExp(pattern);
  return scene.meshes.filter((m) => matcher.test(m.name)).map((mesh) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
      const cx = p.x * VP[0]! + p.y * VP[4]! + p.z * VP[8]! + VP[12]!;
      const cy = p.x * VP[1]! + p.y * VP[5]! + p.z * VP[9]! + VP[13]!;
      const cw = p.x * VP[3]! + p.y * VP[7]! + p.z * VP[11]! + VP[15]!;
      const px = ((cx / cw + 1) / 2) * width, py = ((1 - cy / cw) / 2) * height;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    return { name: mesh.name, x0, y0, x1, y1 };
  });
}, { pattern: TARGETS.source, width: WIDTH * 2, height: HEIGHT * 2 });

writeFileSync(`${stem}.json`, JSON.stringify({ label, distance, elevation, azimuth, png: `${stem}.png`, pageErrors, boxes }, null, 2));
console.log(`wrote ${stem}.png; boxes: ${boxes.map((b) => `${b.name} ${Math.round(b.x1 - b.x0)}x${Math.round(b.y1 - b.y0)}`).join(", ")}; page errors: ${pageErrors.length}`);
await browser.close();
