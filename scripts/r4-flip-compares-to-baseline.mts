/**
 * R4 promotion step 2: flip the five NEW shots to `comparesToBaseline: true`.
 *
 * This must land in the SAME commit that promotes their baselines. A shot with
 * a baseline and `comparesToBaseline: false` passes forever while showing
 * nothing -- the set stays fatal-free and blind, which is the instrument
 * failure this phase produced most often.
 *
 * Written ahead of the promotion and deliberately NOT applied yet: flipping
 * before the baselines exist would make the next capture compare against a
 * file that is not there. Run it immediately after the baselines are copied.
 *
 * Refuses if a named shot has no baseline PNG, so it cannot half-apply.
 *
 *   npx tsx scripts/r4-flip-compares-to-baseline.mts [--apply]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** The six added during Phase 6. */
const NEW_SHOTS = [
  "veg-seam-1600ft-oblique",
  "veg-seam-near-500ft",
  "terrain-material-1600ft-down",
  "horizon-shadow-far-annulus",
  "canopy-backlit-lowsun",
  "night-moonlit",
  // Added since: the roster drifted and this script's own partition assertion
  // is what caught it, naming all four rather than silently promoting three.
  "dusk-mesopic",
  "golden-hour",
  "blue-hour",
  "night-beacon-offset",
] as const;

/**
 * The shots that are pre-existing and stay `false` — a separate decision, not
 * R4's to make silently.
 *
 * These two lists are ASSERTED to partition the `false` set, so this stops
 * being a hand-written roster. A seventh new shot that nobody adds to
 * `NEW_SHOTS` would otherwise promote a baseline and stay blind forever, which
 * is the exact failure this script exists to prevent — and a roster a member
 * can fail to appear in is how the winding guard missed the blade ribbon and
 * how `mossCushion` went unwatched twice. Fail loudly instead.
 */
const PRE_EXISTING_FALSE = [
  "motion-banked-turn",
  "page-thrash-turn",
  "cdlod-transition",
] as const;

const SOURCE = "scripts/perf-capture.mts";
const apply = process.argv.includes("--apply");
let text = readFileSync(SOURCE, "utf8");

const missing = NEW_SHOTS.filter((s) => !existsSync(`tests/perf/baseline/${s}.png`));
if (missing.length > 0) {
  console.error(`refusing: no baseline PNG for ${missing.join(", ")}`);
  console.error("promote the baselines first, then run this.");
  process.exit(1);
}

let flipped = 0;
for (const shot of NEW_SHOTS) {
  // Anchor on the shot's own `name:` and take the FIRST following field, so a
  // `comparesToBaseline` mentioned in a neighbouring docblock cannot be hit --
  // there is one at line ~1170 and a naive replace would edit the comment.
  const start = text.indexOf(`    name: "${shot}",`);
  if (start < 0) throw new Error(`shot ${shot} not found in ${SOURCE}`);
  const end = text.indexOf('\n  },', start);
  const block = text.slice(start, end);
  const next = block.replace(
    /^(\s*)comparesToBaseline: false,$/m,
    "$1comparesToBaseline: true,",
  );
  if (next === block) {
    console.log(`  ${shot}: already true (or field absent) — skipped`);
    continue;
  }
  text = text.slice(0, start) + next + text.slice(end);
  flipped += 1;
  console.log(`  ${shot}: false -> true`);
}

// Every shot still carrying `comparesToBaseline: false` must be accounted for
// by one of the two lists above. Anything else is a shot nobody decided about.
const stillFalse: string[] = [];
for (const m of text.matchAll(/^ {4}name: "([^"]+)",$/gm)) {
  const start = m.index!;
  const end = text.indexOf("\n  },", start);
  if (/^\s*comparesToBaseline: false,$/m.test(text.slice(start, end))) {
    stillFalse.push(m[1]!);
  }
}
const unaccounted = stillFalse.filter(
  (n) => !(PRE_EXISTING_FALSE as readonly string[]).includes(n),
);
if (unaccounted.length > 0) {
  console.error(
    `\nrefusing: ${unaccounted.join(", ")} still compare-blind and are in `
    + "neither NEW_SHOTS nor PRE_EXISTING_FALSE. Add each to the right list — a "
    + "shot with a baseline and comparesToBaseline:false passes forever while "
    + "showing nothing.",
  );
  process.exit(1);
}

if (!apply) {
  console.log(`\n${flipped} shot(s) would flip. Re-run with --apply to write.`);
} else {
  writeFileSync(SOURCE, text);
  console.log(`\nwrote ${SOURCE} — ${flipped} shot(s) flipped.`);
}
