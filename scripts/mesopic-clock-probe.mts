/**
 * Where does `rodFraction` actually land strictly between 0 and 1?
 *
 * `7-4a` applies its highlight term at partial weight through
 * `mix(scene, rodImage, rod)`, so the regime that exercises the blend is
 * `rodFraction in (0,1)` -- not full night and not day. This picks the clock by
 * COMPUTING it from the shipping model rather than by choosing a plausible
 * hour, because the night set already shipped with an effectively moonless
 * clock precisely because nobody checked (see `moon-night-shot-probe.mts`).
 *
 * Composes the real chain, not a re-derivation:
 *   resolveEnvironmentState -> adaptedLuminanceCdM2 -> rodFractionForAdaptedLuminance
 *
 * It also reports where every SHIPPING shot's clock lands, so "no shot covers
 * this" is measured rather than asserted.
 */
import { resolveEnvironmentState, adaptedLuminanceCdM2 } from
  "../src/render/webgpu/nature/EnvironmentDirector";
import {
  rodFractionForAdaptedLuminance, shouldRunScotopicPass,
  SCOTOPIC_THRESHOLD_CD_M2, PHOTOPIC_THRESHOLD_CD_M2,
} from "../src/render/webgpu/atmosphere/ScotopicVision";
import { moonState, moonIlluminanceLux } from "../src/render/webgpu/atmosphere/Ephemeris";
import { localSiderealTimeHours, equatorialToWorldRows, equatorialUnitVector, equatorialToWorld }
  from "../src/render/webgpu/atmosphere/StarCatalogue";
import { PERF_CAPTURE_SHOTS, PERF_CAPTURE_DEFAULT_CLOCK } from "./perf-capture.mts";
import { createWorld } from "../src/world";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const LAT = world.latitudeDegrees;

function moonLuxAt(dayOfYear: number, solarTimeHours: number): number {
  const clock = { dayOfYear, solarTimeHours };
  const moon = moonState(clock);
  const rows = equatorialToWorldRows(localSiderealTimeHours(clock), LAT);
  const w = equatorialToWorld(
    equatorialUnitVector(moon.rightAscensionHours, moon.declinationDegrees), rows);
  return moonIlluminanceLux(moon, Math.max(w[1]!, 0));
}

function probe(dayOfYear: number, solarTimeHours: number) {
  const clock = { dayOfYear, solarTimeHours };
  const state = resolveEnvironmentState({ clock, latitudeDegrees: LAT, weather: "clear" });
  const lux = moonLuxAt(dayOfYear, solarTimeHours);
  const adapted = adaptedLuminanceCdM2(state, lux);
  return { adapted, rod: rodFractionForAdaptedLuminance(adapted),
           sunY: state.sun.direction[1] };
}

console.log(`latitude ${LAT.toFixed(2)}, mesopic band = adapted in `
  + `(${SCOTOPIC_THRESHOLD_CD_M2}, ${PHOTOPIC_THRESHOLD_CD_M2}) cd/m2\n`);

// --- 1. Where do the SHIPPING shots land? -------------------------------
console.log("shot clocks already in the set:");
const seen = new Map<string, { rod: number; n: number }>();
for (const shot of PERF_CAPTURE_SHOTS) {
  const c = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  const key = `${c.dayOfYear}@${c.solarTimeHours}`;
  const r = probe(c.dayOfYear, c.solarTimeHours);
  const prev = seen.get(key);
  seen.set(key, { rod: r.rod, n: (prev?.n ?? 0) + 1 });
}
let anyMesopic = false;
for (const [key, v] of [...seen.entries()].sort((a, b) => a[1].rod - b[1].rod)) {
  const partial = v.rod > 1e-6 && v.rod < 1 - 1e-6;
  if (partial) anyMesopic = true;
  console.log(`  ${key.padEnd(14)} rod ${v.rod.toFixed(6)}  ${v.n} shot(s)`
    + `${partial ? "   <-- PARTIAL" : ""}`);
}
console.log(`\nany shipping shot with rodFraction strictly in (0,1)? ${anyMesopic ? "YES" : "NO"}\n`);

// --- 2. Find the CONTIGUOUS windows, at the set's own day --------------
// Contiguous, because rod is partial at BOTH twilights and a first-to-last
// span would report the daylight gap between them as if it were one window.
const DAY = PERF_CAPTURE_DEFAULT_CLOCK.dayOfYear;
const STEP = 1 / 600;
const samples: Array<{ t: number; rod: number; adapted: number }> = [];
for (let t = 0; t < 24; t += STEP) {
  const r = probe(DAY, t);
  samples.push({ t, rod: r.rod, adapted: r.adapted });
}
const partial = (r: number) => r > 1e-4 && r < 1 - 1e-4;
const windows: Array<typeof samples> = [];
let run: typeof samples = [];
for (const s of samples) {
  if (partial(s.rod)) run.push(s);
  else { if (run.length) windows.push(run); run = []; }
}
if (run.length) windows.push(run);

console.log(`contiguous mesopic windows at day ${DAY}: ${windows.length}`);
for (const w of windows) {
  console.log(`  ${w[0]!.t.toFixed(3)} h -> ${w[w.length - 1]!.t.toFixed(3)} h`
    + `  (${((w[w.length - 1]!.t - w[0]!.t) * 60).toFixed(1)} min)`);
}

// Pick the FLATTEST point with rod mid-range. A pinned clock is deterministic
// either way, but a shot sitting on a steep d(rod)/dt is fragile to any change
// in the exposure or atmosphere model: a small model shift would swing rod far
// and churn the baseline for a reason unrelated to what the shot tests.
const evening = windows[windows.length - 1]!;
let best = evening[0]!;
let bestSlope = Infinity;
for (let i = 1; i < evening.length - 1; i += 1) {
  const s = evening[i]!;
  if (s.rod < 0.35 || s.rod > 0.65) continue;   // must genuinely blend
  const slope = Math.abs((evening[i + 1]!.rod - evening[i - 1]!.rod) / (2 * STEP));
  if (slope < bestSlope) { bestSlope = slope; best = s; }
}
console.log(`\nevening window ${evening[0]!.t.toFixed(3)} -> `
  + `${evening[evening.length - 1]!.t.toFixed(3)} h`);
console.log(`flattest mid-range point: solarTimeHours ${best.t.toFixed(3)}  `
  + `rod ${best.rod.toFixed(4)}  adapted ${best.adapted.toExponential(3)} cd/m2`);
console.log(`  d(rod)/dt there = ${bestSlope.toFixed(2)} per hour`);

console.log(`\nstability of that choice (+/- 3 min):`);
for (const dm of [-3, -2, -1, 0, 1, 2, 3]) {
  const r = probe(DAY, best.t + dm / 60);
  console.log(`  ${(dm >= 0 ? "+" : "")}${dm} min  rod ${r.rod.toFixed(4)}  `
    + `scotopicPass=${shouldRunScotopicPass(r.rod)}`);
}

console.log(`\nevening curve, 1-min steps (rod, and d(rod)/dt per hour):`);
for (let t = evening[0]!.t - 1 / 60; t <= evening[evening.length - 1]!.t + 1 / 60; t += 1 / 60) {
  const a = probe(DAY, t - STEP).rod;
  const b = probe(DAY, t).rod;
  const c = probe(DAY, t + STEP).rod;
  const slope = Math.abs((c - a) / (2 * STEP));
  const bar = "#".repeat(Math.round(b * 40));
  console.log(`  ${t.toFixed(3)} h  rod ${b.toFixed(4)}  slope ${slope.toFixed(2).padStart(7)}  ${bar}`);
}

console.log(`\nCANDIDATES on the plateau (+/- 3 min stability):`);
for (const t of [20.41, 20.42, 20.45]) {
  const r = probe(DAY, t);
  const lo = probe(DAY, t - 3 / 60).rod;
  const hi = probe(DAY, t + 3 / 60).rod;
  console.log(`  ${t.toFixed(2)} h  rod ${r.rod.toFixed(4)}  adapted ${r.adapted.toExponential(3)}`
    + `  +/-3min -> [${lo.toFixed(4)}, ${hi.toFixed(4)}]  swing ${(hi - lo).toFixed(4)}`
    + `  scotopicPass=${shouldRunScotopicPass(r.rod)}`);
}
