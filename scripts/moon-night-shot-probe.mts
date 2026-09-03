/**
 * Is the `night` shot's moon actually up, and does day 356 fix it?
 *
 * A moonlit shot whose moon is below the horizon is a shot that cannot fail --
 * the failure mode this phase has produced most often. The phase figure alone
 * does not settle it: `moonIlluminanceLux` returns 0 for a moon below the
 * horizon regardless of how full it is, so ALTITUDE is the load-bearing term
 * and it is the one that was not verified.
 *
 * Composes the renderer's OWN call chain -- `moonState`, `localSiderealTimeHours`,
 * `equatorialToWorldRows`, `equatorialUnitVector`, `equatorialToWorld`,
 * `moonIlluminanceLux` -- rather than re-deriving the astronomy, so this
 * measures the shipping model and not a transcription of it.
 */
import {
  moonState, moonIlluminanceLux, FULL_MOON_ILLUMINANCE_LUX,
} from "../src/render/webgpu/atmosphere/Ephemeris";
import {
  localSiderealTimeHours, equatorialToWorldRows, equatorialUnitVector, equatorialToWorld,
} from "../src/render/webgpu/atmosphere/StarCatalogue";
import { createWorld } from "../src/world";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const lat = world.latitudeDegrees;
console.log(`latitude ${lat.toFixed(3)}°, full-moon reference ${FULL_MOON_ILLUMINANCE_LUX} lx\n`);

function probe(dayOfYear: number, solarTimeHours: number) {
  const clock = { dayOfYear, solarTimeHours };
  const moon = moonState(clock);
  const rows = equatorialToWorldRows(localSiderealTimeHours(clock), lat);
  const w = equatorialToWorld(
    equatorialUnitVector(moon.rightAscensionHours, moon.declinationDegrees), rows);
  const altSin = w[1]!;
  const lux = moonIlluminanceLux(moon, Math.max(altSin, 0));
  return {
    dayOfYear, solarTimeHours,
    lit: moon.illuminatedFraction,
    altDeg: (Math.asin(Math.max(-1, Math.min(1, altSin))) * 180) / Math.PI,
    lux,
  };
}

const rows = [
  probe(171, 23.75),   // the shipped `night` shot
  probe(356, 23.75),   // the proposed moonlit replacement
];
console.log("day  solarT   litFrac   altitude    lux        vs full moon");
for (const r of rows) {
  const ratio = r.lux > 0 ? `${(FULL_MOON_ILLUMINANCE_LUX / r.lux).toFixed(0)}x dimmer` : "MOON DOWN";
  console.log(
    `${String(r.dayOfYear).padStart(3)}  ${r.solarTimeHours.toFixed(2)}   `
    + `${r.lit.toFixed(4)}    ${r.altDeg.toFixed(2).padStart(7)}°  `
    + `${r.lux.toExponential(3)}  ${ratio}`,
  );
}

// A day-356 moon that is also down would make the new shot fail the same way.
// Sweep the year at this solar time so the choice is made on evidence.
console.log("\nsweep of the year at solarTime 23.75 -- best moonlit days:");
const all = [];
for (let d = 0; d < 365; d += 1) all.push(probe(d, 23.75));
for (const r of all.sort((a, b) => b.lux - a.lux).slice(0, 6)) {
  console.log(`  day ${String(r.dayOfYear).padStart(3)}  lit ${r.lit.toFixed(3)}  `
    + `alt ${r.altDeg.toFixed(1).padStart(5)}°  ${r.lux.toExponential(3)} lx`);
}
const up = all.filter((r) => r.lux > 0).length;
console.log(`\nmoon above horizon on ${up}/365 days at this solar time`);

// Day 356 is WINTER at this latitude, and `dayOfYear` drives the snowline,
// land cover and ground-cover density -- so a day-356 shot differs from the
// day-171 `night` shot in TWO variables, not one. If the intent is to isolate
// moonlight, the season has to be held. Best moonlit day NEAR day 171:
console.log("\nbest moonlit days within +/-30 of day 171 (season held):");
for (const r of all.filter((x) => Math.abs(x.dayOfYear - 171) <= 30)
  .sort((a, b) => b.lux - a.lux).slice(0, 5)) {
  console.log(`  day ${String(r.dayOfYear).padStart(3)}  lit ${r.lit.toFixed(3)}  `
    + `alt ${r.altDeg.toFixed(1).padStart(5)}°  ${r.lux.toExponential(3)} lx  `
    + `(${(FULL_MOON_ILLUMINANCE_LUX / r.lux).toFixed(1)}x dimmer than full)`);
}
