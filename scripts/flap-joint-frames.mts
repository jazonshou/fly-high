/**
 * In-game chase frames of the Global's wing/flap joint, cropped by PROJECTION
 * rather than by eye.
 *
 * The acceptance question is whether a player sees ground or sky between the
 * wing's trailing edge and the flap's leading edge. That is a question about
 * the shipped page at the chase camera, not about a mesh harness, so this
 * drives the real game — and it locates the joint by projecting the fixed
 * wing's and the flap's own world bounding boxes through the live camera's
 * view-projection, so the crop cannot drift onto the wrong part of the wing
 * the way a hand-guessed rectangle does.
 *
 *   npx tsx scripts/flap-joint-frames.mts <outDir> <url> <expectTree> [kind]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kindRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree> [kind]");
const kind = kindRaw ?? "bizjet";

/**
 * Per-airframe mesh names and full-flap travel.
 *
 * The travel is stated here rather than inferred, so that a frame whose flaps
 * are not where its name says fails against a NUMBER instead of against
 * "something moved". These mirror `SURFACE_TRAVEL` in `animation.ts`; if that
 * table changes, this run fails loudly and says by how much.
 */
const FLEET: Record<string, { wing: string[]; flaps: string[]; hinge: string; fullFlapDegrees: number }> = {
  bizjet: {
    wing: ["inboard-wing"],
    flaps: ["inner-flap-surface", "outer-flap-surface"],
    hinge: "starboard-bizjet-inner-flap",
    fullFlapDegrees: 30,
  },
  jet: {
    wing: ["swept-main-wing", "swept-outer-wing"],
    flaps: ["jet-flaperon-surface"],
    hinge: "starboard-jet-flaperon",
    fullFlapDegrees: 20,
  },
  airliner: {
    wing: ["airliner-inboard-wing", "airliner-outboard-wing"],
    flaps: ["airliner-inner-flap-surface", "airliner-outer-flap-surface"],
    hinge: "starboard-airliner-inner-flap",
    fullFlapDegrees: 30,
  },
};
const recorded = FLEET[kind];
if (!recorded) throw new Error(`no mesh names recorded for "${kind}"`);
const fleet = recorded;
/** `bizjet` prefixes its wing panels with the kind; the others do not. */
const qualify = (part: string) => (kind === "bizjet" ? `bizjet-${part}` : part);
const WIDTH = 1920;
const HEIGHT = 1080;
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
// deviceScaleFactor 2 so the joint crop is made of REAL pixels rather than
// magnified ones: the canvas renders at 3840x2160 and a 400 px region comes
// back 800 px wide. `scripts/frame-crop.mts` was tried first and its PNG
// decoder returned scanline garbage on Playwright's output, so the crop is
// taken natively by the browser and never round-trips through a decoder.
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});
// `kind` is PASSED, not closed over. Playwright serialises this function and
// ships it to the browser, so a variable captured from Node's scope is simply
// undefined there — and the try/catch below swallowed the ReferenceError, so
// the run quietly flew the default aeroplane instead. The flap-angle guard is
// what caught it: it found the Cessna's hinge names in an F-16 capture.
await page.addInitScript((wantedKind: string) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: wantedKind,
      flightMode: "scenic",
      showDiagnostics: false,
      weather: "clear",
      timeOfDay: "day",
      airborneStartAgl: 600,
    }));
  } catch { /* first load has no settings yet */ }
}, kind);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);

/** Screen-space rectangles of the named meshes, through the LIVE camera. */
interface Rect { x: number; y: number; w: number; h: number }
interface Projection {
  rects: Record<string, Rect>;
  flapDegrees: number;
  hingeName: string;
  nearby: string[];
}
async function projectMeshes(names: string[]): Promise<Projection> {
  return page.evaluate(async ({ wanted, hingeName }: { wanted: string[]; hingeName: string }) => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return { rects: {}, flapDegrees: NaN, hingeName, nearby: [] };
    const anyWindow = globalThis as unknown as { __jointStore?: unknown };
    if (!anyWindow.__jointStore) anyWindow.__jointStore = await import(/* @vite-ignore */ storeUrl);
    const mod = anyWindow.__jointStore as Record<string, unknown>;
    const store = Object.values(mod).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: { name: string; computeWorldMatrix: (f: boolean) => void;
        getBoundingInfo: () => { boundingBox: { vectorsWorld: { x: number; y: number; z: number }[] } } }[];
      getTransformMatrix: () => { m: number[] };
      transformNodes: { name: string; rotationQuaternion: { w: number } | null;
        rotation: { z: number } }[];
    } | undefined;
    if (!scene) return { rects: {}, flapDegrees: NaN, hingeName, nearby: [] };
    const m = scene.getTransformMatrix().m;
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const name of wanted) {
      const mesh = scene.meshes.find((x) => x.name === name);
      if (!mesh) continue;
      mesh.computeWorldMatrix(true);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        // Babylon stores row-major with a row-vector convention, so a world
        // point multiplies the matrix from the left.
        const cw = p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;
        if (cw <= 0) continue;
        const nx = (p.x * m[0]! + p.y * m[4]! + p.z * m[8]! + m[12]!) / cw;
        const ny = (p.x * m[1]! + p.y * m[5]! + p.z * m[9]! + m[13]!) / cw;
        const sx = (nx * 0.5 + 0.5) * window.innerWidth;
        const sy = (0.5 - ny * 0.5) * window.innerHeight;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (Number.isFinite(minX)) out[name] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    /*
     * What the flap is ACTUALLY doing in this frame, measured off the node.
     *
     * Not the key presses, and not the label: a frame captioned "full flap"
     * that was taken at 348 kt with the panels blown back would look exactly
     * like a frame of a clean wing, and I would have sent it. The hinge now
     * carries a rotationQuaternion rather than an Euler angle (it rotates
     * about the swept hinge line), so the deflection is the quaternion's own
     * magnitude, 2 acos(w).
     */
    const hinge = scene.transformNodes.find((n) => n.name === hingeName);
    const q = hinge?.rotationQuaternion;
    const flapDegrees = q
      ? (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI
      : ((hinge?.rotation.z ?? NaN) * 180) / Math.PI;
    const nearby = scene.transformNodes
      .filter((n) => /flap|flaperon/.test(n.name)).map((n) => n.name).slice(0, 8);
    return { rects: out, flapDegrees, hingeName, nearby };
  }, { wanted: names, hingeName: fleet.hinge });
}

async function setFlaps(detents: number): Promise<void> {
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press("KeyV"); await page.waitForTimeout(120); }
  for (let i = 0; i < detents; i += 1) { await page.keyboard.press("KeyF"); await page.waitForTimeout(160); }
  // The flaps ANIMATE; a frame taken as they run shows neither setting.
  await page.waitForTimeout(3_500);
}

const rects: Record<string, unknown> = {};
async function capture(label: string, detents: number): Promise<void> {
  await setFlaps(detents);
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  const named = ["starboard", "port"].flatMap((side) => [
    ...fleet.wing.map((part) => `${side}-${qualify(part)}`),
    ...fleet.flaps.map((part) => `${side}-${part}`),
  ]);
  const { rects: found, flapDegrees, nearby } = await projectMeshes(named);
  rects[label] = { flapDegrees, ...found };
  const wanted = (detents * fleet.fullFlapDegrees) / 2;
  console.log(`${label}: flap measured ${flapDegrees.toFixed(1)} deg, asked ${wanted} deg`);
  if (!Number.isFinite(flapDegrees) || Math.abs(flapDegrees - wanted) > 2) {
    throw new Error(
      `${label}: flap is at ${flapDegrees.toFixed(1)} deg, not the ${wanted} deg this frame claims. `
      + `Looked for hinge "${fleet.hinge}"; scene has [${nearby.join(", ")}]. `
      + "Captured nothing usable; do not report a frame whose flap setting is not the one in its name.",
    );
  }
  // One crop a side, bounding the fixed wing and both flap panels together —
  // so the rectangle always contains the joint, whatever the camera did.
  for (const side of ["starboard", "port"] as const) {
    const parts = named.filter((n) => n.startsWith(side)).map((n) => found[n]).filter(Boolean);
    if (parts.length === 0) { console.log(`${label} ${side}: NOT PROJECTED`); continue; }
    const pad = 18;
    const x = Math.max(0, Math.min(...parts.map((r) => r!.x)) - pad);
    const y = Math.max(0, Math.min(...parts.map((r) => r!.y)) - pad);
    const right = Math.min(WIDTH, Math.max(...parts.map((r) => r!.x + r!.w)) + pad);
    const bottom = Math.min(HEIGHT, Math.max(...parts.map((r) => r!.y + r!.h)) + pad);
    await page.screenshot({
      path: `${outDir}/${label}-${side}.png`,
      type: "png",
      clip: { x, y, width: right - x, height: bottom - y },
    });
    console.log(`${label} ${side}: clip ${Math.round(x)},${Math.round(y)} ${Math.round(right - x)}x${Math.round(bottom - y)}`);
  }
}

// 1. Runway, take-off flaps.
await page.getByRole("button", { name: /Start on the runway/ }).click();
await page.waitForTimeout(6_000);
await capture("runway-takeoff-flap", 1);

// 2. In flight, full flap. Back to the menu, airborne start, let the spawn
//    phugoid settle before deploying — a frame taken mid-oscillation is a
//    frame of an aeroplane that is not flying level.
// Reload rather than Escape: Escape opens the pause dialog, it does not
// return to the menu, so the second start button was never on screen.
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(8_000);
/*
 * Slow down BEFORE deploying.
 *
 * The first attempt dropped full flap straight from the airborne spawn and
 * caught the aeroplane at 348 kt, 2.3 G and 9,400 ft/min in a zoom climb —
 * a frame of an aeroplane doing something violent, at a speed no flap on
 * this type would be extended at. Throttle to idle, let it bleed to
 * approach speed, then deploy.
 */
await page.keyboard.down("Control");
await page.waitForTimeout(4_000);
await page.keyboard.up("Control");
for (let attempt = 0; attempt < 120; attempt += 1) {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const ias = Number((text.match(/IAS ([\d,]+) KT/)?.[1] ?? "").replace(/,/g, ""));
  const vs = Number((text.match(/V\/S ([+-]?[\d,]+) FT/)?.[1] ?? "").replace(/,/g, ""));
  if (Number.isFinite(ias) && ias < 200 && Math.abs(vs) < 1_500) break;
  // Hold the nose where it is rather than letting idle thrust turn the
  // deceleration into a dive or a stall.
  const key = vs > 600 ? "w" : vs < -600 ? "s" : "";
  if (key) { await page.keyboard.down(key); await page.waitForTimeout(90); await page.keyboard.up(key); }
  await page.waitForTimeout(700);
}
/*
 * And capture it in a shallow DESCENT.
 *
 * The chase camera trails on the flight path, so in level flight it sits
 * barely above the wing plane and the deployed flap hides behind the wing's
 * own upper surface — the first in-flight crop showed a clean wing and
 * proved nothing, because the joint was not in view at all. Nose down and
 * the camera rises relative to the wing, which is the angle the question is
 * about: a sight line entering the slot from above and behind.
 */
await page.keyboard.down("w");
await page.waitForTimeout(1_100);
await page.keyboard.up("w");
await page.waitForTimeout(2_500);
await capture("inflight-full-flap", 2);

writeFileSync(`${outDir}/rects.json`, JSON.stringify(rects, null, 1));
await browser.close();
console.log("frames written");
