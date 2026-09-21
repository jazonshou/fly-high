/**
 * The spoilers, retracted and deployed, in the shipped game.
 *
 * Retracted is the case that matters and the case a harness flatters: a panel
 * that lies in the wing is invisible, and a panel that hovers over it is only
 * obvious from a bearing that catches the daylight underneath. So this drives
 * the real page at several orbit bearings rather than one, and crops to the
 * spoilers' own projected pixels.
 *
 * THE ANGLE IS MEASURED, NOT ASKED FOR. Setting `rotation.z` and captioning the
 * frame with the number you set proves only that you can print a number: the
 * pose could be overwritten, the node could be the wrong one, the panel could
 * be parented somewhere that does not move. The deflection reported here is the
 * angle between the panel's own chord vector at rest and in the captured frame,
 * read off the vertex buffer in world space, and a frame whose measurement
 * disagrees with its caption by more than a degree fails the run.
 *
 *   npx tsx scripts/spoiler-frames.mts <outDir> <url> <expectTree> [degrees]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, degreesRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree> [degrees]");
const wantedDegrees = Number(degreesRaw ?? 39);
// 0 means RETRACTED ONLY, which is what a before-capture of an older tree can
// honestly give: the deflection reading below indexes this pass's own panel
// grid, so it would be measuring the wrong vertices of an older shape.
if (!(wantedDegrees >= 0 && wantedDegrees <= 60)) throw new RangeError("degrees must be in [0, 60]");
const WIDTH = 1920;
const HEIGHT = 1080;
const ORBIT_FRAMES = 4;
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
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});
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
      aircraft: "airliner",
      flightMode: "scenic",
      showDiagnostics: false,
      weather: "clear",
      timeOfDay: "day",
      airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
});
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(30_000);

/** Hold the panels at an angle for as long as the capture lasts. */
async function hold(radians: number): Promise<number> {
  return page.evaluate(async (angle: number) => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return -1;
    const g = globalThis as unknown as { __spoilerStore?: unknown; __spoilerHold?: unknown };
    if (!g.__spoilerStore) g.__spoilerStore = await import(/* @vite-ignore */ storeUrl);
    const store = Object.values(g.__spoilerStore as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      transformNodes: { name: string; rotation: { z: number } }[];
      onBeforeRenderObservable: { add: (fn: () => void) => unknown };
    } | undefined;
    if (!scene) return -1;
    // `-spoilers` is this pass's grouped node; `-spoiler` the older one a
    // before-capture runs against.
    const nodes = scene.transformNodes.filter((n) => /-spoilers?$/.test(n.name));
    if (nodes.length === 0) return -1;
    // Reinstated every frame, because the aeroplane's own pose writes this
    // field each tick and would put the panels back down before the shutter.
    if (!g.__spoilerHold) {
      g.__spoilerHold = { angle };
      scene.onBeforeRenderObservable.add(() => {
        const held = (g.__spoilerHold as { angle: number }).angle;
        for (const node of nodes) node.rotation.z = held;
      });
    } else {
      (g.__spoilerHold as { angle: number }).angle = angle;
    }
    return nodes.length;
  }, radians);
}

/**
 * The deflection AS DRAWN: the angle between a panel's chord vector now and
 * the same panel's chord vector at rest, both in world space, off the vertex
 * buffer. `rest` is the first call's reading.
 */
let restChords: number[][] | null = null;
async function measureDegrees(): Promise<number | null> {
  const chords = await page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const g = globalThis as unknown as { __spoilerStore?: unknown };
    const store = Object.values((g.__spoilerStore ?? {}) as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: {
        name: string;
        getTotalVertices: () => number;
        getVerticesData: (k: string) => Float32Array | null;
        computeWorldMatrix: (f: boolean) => void;
        getWorldMatrix: () => { m: number[] };
      }[];
    } | undefined;
    if (!scene) return null;
    const out: number[][] = [];
    for (const mesh of scene.meshes.filter((m) => /-spoilers?-surface$/.test(m.name))) {
      const pos = mesh.getVerticesData("position");
      if (!pos) continue;
      mesh.computeWorldMatrix(true);
      const w = mesh.getWorldMatrix().m;
      const at = (i: number) => {
        const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
        return [
          w[0]! * x + w[4]! * y + w[8]! * z + w[12]!,
          w[1]! * x + w[5]! * y + w[9]! * z + w[13]!,
          w[2]! * x + w[6]! * y + w[10]! * z + w[14]!,
        ];
      };
      // Vertex 0 is a patch's forward (hinge) corner, 4 its trailing one and
      // 10 the far end of the same forward edge — so 0->10 IS the hinge axis.
      // Both are returned, because the chord vector alone cannot give the
      // deflection: the hinge is swept, the chord runs across it at about 66
      // degrees, and a vector that far off the axis turns by less than the
      // rotation does. Measured that way a 39 degree deployment reads 35.5.
      const a = at(0); const b = at(4); const c = at(10);
      out.push([
        b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!,
        c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!,
      ]);
    }
    return out;
  });
  if (!chords || chords.length === 0) return null;
  if (!restChords) { restChords = chords; return 0; }
  let worst = 0;
  for (let i = 0; i < chords.length && i < restChords.length; i += 1) {
    const rest = restChords[i]!; const now = chords[i]!;
    // The hinge axis, from the rest frame: the forward edge does not move, so
    // it is the same axis in both.
    const axis = [rest[3]!, rest[4]!, rest[5]!];
    const axisLength = Math.hypot(...axis);
    if (axisLength === 0) continue;
    const unit = axis.map((v) => v / axisLength);
    // The chord with its along-axis part removed. THAT is what sweeps through
    // the rotation angle, and the angle between the two is the deflection.
    const perpendicular = (v: number[]): number[] => {
      const along = v[0]! * unit[0]! + v[1]! * unit[1]! + v[2]! * unit[2]!;
      return [v[0]! - along * unit[0]!, v[1]! - along * unit[1]!, v[2]! - along * unit[2]!];
    };
    const u = perpendicular([rest[0]!, rest[1]!, rest[2]!]);
    const v = perpendicular([now[0]!, now[1]!, now[2]!]);
    const lengths = Math.hypot(...u) * Math.hypot(...v);
    if (lengths === 0) continue;
    const dot = u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, dot / lengths))) * 180) / Math.PI);
  }
  return worst;
}

/** The spoilers' own projected pixels, so the crop lands on the panels. */
async function spoilerRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const g = globalThis as unknown as { __spoilerStore?: unknown };
    const store = Object.values((g.__spoilerStore ?? {}) as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: {
        name: string;
        computeWorldMatrix: (f: boolean) => void;
        getBoundingInfo: () => { boundingBox: { vectorsWorld: { x: number; y: number; z: number }[] } };
      }[];
      getTransformMatrix: () => { m: number[] };
    } | undefined;
    if (!scene) return null;
    const m = scene.getTransformMatrix().m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const mesh of scene.meshes.filter((mesh) => /-spoilers?-surface$/.test(mesh.name))) {
      mesh.computeWorldMatrix(true);
      for (const p of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        const cw = p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;
        if (cw <= 0) continue;
        const sx = (((p.x * m[0]! + p.y * m[4]! + p.z * m[8]! + m[12]!) / cw) * 0.5 + 0.5) * window.innerWidth;
        const sy = (0.5 - ((p.x * m[1]! + p.y * m[5]! + p.z * m[9]! + m[13]!) / cw) * 0.5) * window.innerHeight;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  });
}

async function shoot(label: string, captionDegrees: number): Promise<void> {
  const measured = await measureDegrees();
  if (measured === null) throw new Error(`${label}: VOID, no spoiler panels found to measure`);
  if (Math.abs(measured - captionDegrees) > 1) {
    throw new Error(
      `${label}: caption says ${captionDegrees.toFixed(1)} deg but the panels are drawn at `
      + `${measured.toFixed(2)} deg; the frame does not show what it claims.`,
    );
  }
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  const rect = await spoilerRect();
  if (rect && rect.w > 8 && rect.h > 8) {
    const pad = Math.max(40, rect.w * 0.25);
    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    await page.screenshot({
      path: `${outDir}/${label}-close.png`,
      type: "png",
      clip: {
        x, y,
        width: Math.min(WIDTH - x, rect.w + pad * 2),
        height: Math.min(HEIGHT - y, rect.h + pad * 2),
      },
    });
  }
  console.log(`${label}: panels drawn at ${measured.toFixed(2)} deg`
    + `${rect ? `, spoilers ${Math.round(rect.w)}x${Math.round(rect.h)} px` : ", NOT PROJECTED"}`);
}

const held = await hold(0);
if (held <= 0) throw new Error("VOID: no spoiler nodes found in the live scene; nothing was captured");
console.log(`holding ${held} spoiler groups`);
await page.waitForTimeout(1_000);
await measureDegrees();                                  // the rest reading

for (let frame = 0; frame < ORBIT_FRAMES; frame += 1) {
  await hold(0);
  await page.waitForTimeout(frame === 0 ? 1_000 : 7_000);
  await shoot(`orbit-${String(frame).padStart(2, "0")}-retracted`, 0);
  if (wantedDegrees > 0) {
    await hold(-(wantedDegrees * Math.PI) / 180);
    await page.waitForTimeout(1_200);
    await shoot(`orbit-${String(frame).padStart(2, "0")}-deployed`, wantedDegrees);
  }
}
await browser.close();
console.log(`captured ${ORBIT_FRAMES * (wantedDegrees > 0 ? 2 : 1)} frames into ${outDir}`);
