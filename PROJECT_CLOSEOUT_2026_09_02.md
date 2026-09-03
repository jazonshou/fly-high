# fly high — current project closeout (2026-09-02; reconciled 2026-09-03)

This is the current status authority for the continuation of the Phase 6 branch. The
older overview, execution plans, outcome, and handover remain valuable design and
measurement records; their intermediate “open”, “next”, commit-count, suite-count, and
shot-count statements are historical rather than current.

## Release state

The shipping **analytic-world** implementation and requested functionality are complete.
Phase 6's water, ecology, vegetation, terrain, and delivery work and Phase 7's
pre-exposure, night image chain, clustered/local lights, airfield lighting, aircraft
lights, PAPI, structures, and airfield identity are present behind the established
renderer boundaries. The final continuation also closes the handover's concrete engine
regressions and verification gaps:

- ocean spectrum generation stays finite through the finite-depth branch and has a
  real-adapter regression;
- ocean diffuse, horizon, foam, and wave-face subsurface radiance now follow physical
  sun/sky illuminance instead of retaining additive night emission;
- depth-only cascaded-shadow targets expose their real dimensions and array layout, so
  receivers can sample the shadow texture;
- the real-adapter light-point radiometry tests exercise rendered output rather than a
  skipped host surrogate;
- tree bark, crowns, and far impostors now share the canopy ambient/specular law, with a
  runtime material-response test;
- the cold analytic startup gate owns a complete, disjoint trace, removes duplicate
  foliage-atlas planning, and enforces a retained-sample-derived **2,300 ms**
  readable-GPU-complete time-to-ready deadline; and
- the GPU and capture projects own isolated optimizer caches, while a macOS Chromium
  launch shim prevents detached crashpad helpers from retaining Playwright's stderr pipe
  after an otherwise-green browser run; and
- architectural ownership no longer advertises the deliberately cut Phase 7
  light-volumetrics artifact.

Implementation completeness is not a claim that every release-acceptance step is closed.
The latest full candidate was contaminated by concurrent GPU work and must be repeated on
a genuinely idle reference machine; the two perceptual product verdicts follow that clean
run. Completion also does not silently pull the parked experiments back into the release.

## Verification and CI truth

Do not copy the handover's old test-file/pass count into a new status report. The current
tree and the command result are the authorities:

| Layer | Authority | What it proves |
| --- | --- | --- |
| Local deterministic checks | `npm run verify` | ESLint, strict TypeScript, Node/headless Vitest, and the Cloudflare production build |
| Static distribution | `npm run build:pages` | the separate GitHub Pages bundle |
| Real WebGPU | `npm run test:gpu` | shader compilation, adapter parity, finite-output, and GPU integration contracts |
| Cold startup | `npm run perf:cold-start` | fresh-browser analytic time through render, synchronous readback, GPU fence, and one error-delivery task, plus timeout/error/scene-completeness/trace gates |
| Visual and delivery capture | `npm run perf:capture` | the authoritative `PERF_CAPTURE_SHOTS` list, image/temporal/error gates, and reference-host delivery floors |

The commands above are intentionally separate. `npm run verify` does **not** include the
GitHub Pages build, real-WebGPU suite, cold-start gate, or hardware capture suite. Final
results recorded for this continuation are:

- `npm run verify`: **PASS** — lint, strict TypeScript, **1,857 tests passed plus 1
  intentional skip (1,858 total)**, and the Cloudflare production build.
- `npm run build:pages`: **PASS**.
- canonical cold-cache `npm run test:gpu`: **PASS — 58 files / 130 tests**, exiting in
  **134.83 s** after the complete Babylon dependency set was pinned for optimization with
  dependency discovery disabled; the shimmed browser and its helpers then exited normally.
- `npm run perf:cold-start`: **PASS at 1,809.0 ms ready** (1,529.5 ms create + 279.5 ms
  completed-frame delivery), with 12 terrain tiles and 1.81% lower-outer/foreground detail,
  against the 2,300 ms deadline.
- targeted capture after bounding ocean presentation to a 90 km radius: **PASS** under the
  explicit seam, faceting, and gap review.
- full candidate `2026-09-03T04-19-09.608Z`: **NOT APPROVABLE**. Its generic tier-1 gate
  passed — minimum wall throughput **71.84 FPS**, worst p95 **16.10 ms**, no more than
  **3** intervals over 16.67 ms in any shot, and zero intervals over 27.4 ms or hitches —
  but **63** per-shot ratchet assertions failed across **21 of 31** pinned shots. Two
  orphaned GPU suites were concurrently using the same integrated GPU, so the result is
  not valid regression-attribution evidence and cannot justify a floor update.

No delivery floor or visual baseline was promoted, re-pinned, or loosened.

The ordinary CI workflow runs lint, typecheck, deterministic tests, and both production
builds on pull requests and `main`. The separate macOS renderer workflow runs on pull
requests, `main`, a weekly schedule, and manual dispatch. It runs the real-adapter suite
and then a focused PR capture or full non-PR capture. Every canonical capture command
runs the cold-start process first. A hosted runner is intentionally unpinned for
machine-specific frame-delivery floors, but visual, structural, renderer-error,
settling, and baseline-integrity gates still fail there.

The retained strengthened cold-start trials measured ready totals of **1,817.7 / 1,815.4 /
1,821.3 ms**. Those complete readiness values, not the create-only measurements, are the
acceptance evidence. Median ready plus 25% headroom, rounded up to 50 ms, yields the
2,300 ms deadline. All three frames reported 12 terrain tiles and 1.81% lower-outer detail;
the final 1,809.0 ms confirmation above passed the same semantic checks.

The committed performance table and baseline directory contain the thirty images from
the two named promotions documented in [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
That is not a claim that the live capture list has thirty entries: the append-only list
also contains diagnostic/probe shots whose `comparesToBaseline` value is false.
`PERF_CAPTURE_SHOTS`, never prose or the PNG count, owns the current list and order. Those
promotions predate the fix that made the fp16 ocean presentation finite: their green
results did not prove ocean pixels, and the thirty images remain historical comparison
assets rather than current rendered-ocean acceptance evidence.

## Remaining acceptance

First, repeat the full candidate on a genuinely idle reference machine and require every
visual, temporal, renderer-error, generic delivery, and per-shot ratchet gate to pass. Do
not infer a regression or modify a floor from the contaminated run.

After that clean run, two user-only product judgements remain. They are not missing
implementations and must not be represented as automated passes:

- **N-1 — full night circuit:** depart, fly the pattern, reacquire the field, verify the
  approach-light/PAPI handoff, and judge the runway and aircraft lighting in motion.
- **N-3 — daylight walk-around:** inspect hangars, tower, windsock, signage, apron and
  building-to-ground contact at walking height and again on short final.

The Phase 7 plan deliberately withholds a Phase 7 visual baseline promotion until those
two verdicts exist. A green test or capture run establishes technical stability; it does
not manufacture either judgement. N-3 is also the proper final arbiter for the handover's
close-range hangar/ground-cover observations, which are not equivalent to a reproduced
player-visible defect in an automated frame.

## Explicitly parked, deferred, or cut

- **Compass product choice — held.** The body-axis correction is complete, but the
  mirrored sky convention means a pilot-right turn currently decreases displayed
  heading. Flipping only the heading makes turns intuitive while putting sunrise at
  compass-west; de-mirroring the sky moves every visual baseline. This needs a product
  choice, not a silent sign change.
- **Richer rivers and the eroded world — parked.** The analytic world remains the shipping
  default. Its tracer is live, but a valid seed/region may contain lakes and no accepted
  river; the canonical capture seed currently does. The richer channel-graph path and its
  erosion producers remain recoverable behind `?world=eroded`. Zero visible rivers in the
  shipping seed is therefore the recorded state, not a new regression.
- **Slope-moment terrain material stability — deferred with a bounded design.** The
  current splat classifier loses fine-scale slope statistics as terrain LOD coarsens.
  [`TERRAIN_LOD_MATERIAL_STABILITY_PROPOSAL.md`](TERRAIN_LOD_MATERIAL_STABILITY_PROPOSAL.md)
  records why threshold retuning, direct full-band analytic sampling, and a naive
  one-byte-per-texel channel are not acceptable. The smallest viable continuation is a
  funded, world-anchored slope-moment pyramid/clipmap; its 33 m diagnostic is a CPU
  counterfactual, not a rendered fix or a user sign-off.
- **Phase 7 light volumetrics and hangar interiors — cut.** Light volumetrics had no
  cone-shaped source to render; hangar interiors were below the phase cut line. Neither is
  a planned owner stub or a hidden release dependency.
- **Steep-gate terrain experiment — held.** Branch `s7/steep-gate-held` remains an
  intentionally unmerged visual alternative. It is not the slope-moment fix and must not
  be merged without a user preference verdict.

Phase 7 §10a's L-1, L-3, and L-4 entries remain explicitly *latent* observations: they
were not tied to the reported bright-far-tree symptom, and L-4 was not reproduced in its
stated condition. L-2, the objectively derivable bark/canopy radiometric mismatch, is the
one member corrected in this continuation. The other rows do not authorize speculative
retuning at closeout.

## Reading order from here

1. This closeout for current scope and acceptance state.
2. [`README.md`](README.md) and [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for operation,
   commands, CI, and the measured delivery contract.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) for normative ownership and decisions.
4. [`PHASE_6_EXECUTION_PLAN.md`](PHASE_6_EXECUTION_PLAN.md),
   [`PHASE_6_OUTCOME.md`](PHASE_6_OUTCOME.md),
   [`PHASE_7_EXECUTION_PLAN.md`](PHASE_7_EXECUTION_PLAN.md), and
   [`HANDOVER_2026_09_02.md`](HANDOVER_2026_09_02.md) for historical reasoning,
   measurements, deviations, and provenance.
