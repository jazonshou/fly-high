# Archive

Plans, findings, status notes, evidence dumps and one-off scripts from finished work were removed on 2026-11-14. Their conclusions live in the code, the tests and the living docs. Comments in the code still cite some of them by name; this page is where those citations resolve.

Every file below is in git history. To read one, use the commit it was last present in:

```bash
git show afa81e6:docs/plans/RENDERING_PLAN.md
git show afa81e6:scripts/cockpit-view-probe.mts
```

To list everything that was removed: `git ls-tree -r --name-only afa81e6 -- docs scripts`.

## Plans (`docs/plans/`)

The August to September 2026 rendering programme, phase by phase.

| File | What it covered |
| --- | --- |
| `RENDERING_PLAN.md` | The rendering overhaul: owners (§1.4), the physics/render invariant (§1.3), tier design (§5.3) |
| `PHASE_0_ARCHITECTURE_SHIFT.md` | Phase 0: the architectural shift to single owners |
| `PHASE_1_EXECUTION_PLAN.md` | Phase 1: foundation, correctness and the atmosphere |
| `PHASE_2_EXECUTION_PLAN.md` | Phase 2: sky, sea surface and living ground |
| `PHASE_3_EXECUTION_PLAN.md` | Phase 3: terrain surface and the runway |
| `PRE_PHASE_4_REALIGNMENT.md` | Binding amendments before Phase 4 |
| `PHASE_4_EXECUTION_PLAN.md` | Phase 4: the terrain GPU spine |
| `PHASE_4_5_EXECUTION_PLAN.md` | Phase 4.5: run-the-app defects |
| `PHASE_5_EXECUTION_PLAN.md` | Phase 5: landscape evolution (erosion) |
| `PHASE_6_PREPLANNING.md`, `PHASE_6_EXECUTION_PLAN.md` | Phase 6: water in motion, ecology, final tiers |
| `PHASE_7_EXECUTION_PLAN.md` | Phase 7: night operations, lighting engine, airfield identity |
| `RESOLUTION_PLAN.md` | Repairing the WebGPU build |
| `CDLOD_SELECTION_DESIGN_NOTE.md` | Per-frame CDLOD node selection |
| `LOW_TIER_PERFORMANCE_PLAN.md` | Low tier under a 4x CPU throttle |
| `TERRAIN_LOD_MATERIAL_STABILITY_PROPOSAL.md` | Keeping land cover stable across a LOD change |
| `VEGETATION_OVERHAUL_PLAN.md` | Skeletal trees and living ground |
| `VISUAL_FIXPACK_PLAN.md` | Foliage, terrain, water and F-22 fixes |
| `WEBGL_FALLBACK_PLAN.md` | A WebGL2 fallback (never built) |

## Findings (`docs/findings/`)

Investigation write-ups, mostly September 2026.

| File | What it covered |
| --- | --- |
| `AIRCRAFT_ACCURACY_2026_10_12.md` | Aircraft accuracy audit |
| `AIRCRAFT_FRAMING_2026_09_19.md` | Off-centre, tilted chase framing; the propeller thrust follow-up |
| `AIRLINER_747_SHAPE_2026_09_20.md` | The 747-8's shape |
| `AIRLINER_LIVERY_GENERATOR_SPEC.md`, `AIRLINER_LIVERY_UV.md` | The airliner livery image and its UV contract |
| `AIRLINER_NOSE_GLAZING.md`, `AIRLINER_NOSE_POLISH_2026_09_23.md` | The 747 flight-deck glazing re-loft and nose polish |
| `ATTRACT_ALTITUDE_2026_09_20.md` | The menu flight climbing to 32,000 ft |
| `AUTOLAND_2026_10_24.md` | Autoland |
| `BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md` | Babylon reading pass timestamps before the pass runs |
| `BREACH_PIT_ADMISSION_2026_09_22.md` | The breach pit carve and the compute budget |
| `CESSNA_COCKPIT_2026_09_29.md` | The Cessna cockpit |
| `COCKPIT_HUD_LAYOUT_2026_09_23.md` | Keeping the 2D HUD off the instruments |
| `COCKPIT_VIEW_2026_09_20.md` | Cockpit view lens, eye point and hidden skin |
| `DOCBLOCK_TRUTH_SWEEP.md` | Docblock accuracy sweep of `src/render/webgpu/` |
| `FAR_SWARD_SOFT_GATE_2026_09_30.md` | The far-sward gate at shores |
| `GLOBAL_LIVERY.md`, `GLOBAL_WINDOW_SEATING_2026_09_20.md`, `GLOBAL_WING_2026_09_20.md` | The Global 8000's livery, windows and flaps |
| `GROUND_HANDLING_2026_10_25.md` | Ground steering, braking and autoland touchdown |
| `GROUND_NEAR_FIELD_D.md`, `GROUND_TEXTURE_W1.md` | Ground detail up close and from the air |
| `GROUND_SPOILERS_2026_09_23.md`, `SPOILER_DIFFERENTIAL_2026_09_20.md` | Spoilers on the ground and in roll |
| `HANDOFF_TRIM_2026_09_20.md`, `SCENIC_HEIGHT_HOLD_2026_09_20.md` | Trim at Start; height hold in Scenic |
| `INSTRUMENT_FAILURES_2026_09_01.md`, `INSTRUMENT_FAILURES_2026_09_02.md` | Diagnostics that answered instead of failing |
| `JET_AIRBRAKE_2026_09_20.md`, `RAKED_RUDDERS_2026_09_20.md`, `LOFT_SPINE_SEAM_2026_09_20.md` | F-16 speed brakes, rudder hinge lines, lofted-body seams |
| `LOW_TIER_THROTTLE_BASELINE_2026_09_29.md` | Low tier under a 4x CPU throttle, measured |
| `MOONLIT_NIGHT_SHOT.md`, `PHASE_7_NIGHT_TIER_FINDING.md` | The moonlit shot; the night tier ladder |
| `MOUNTAINS_M1.md`, `TERRAIN_AUDIT.md`, `TERRAIN_MATERIAL_ANISOTROPY_FINDING.md`, `TERRAIN_MICROSLOPE_FINDING.md` | Terrain realism, mountains and material artifacts |
| `OCEAN_CASCADE_PIN_2026_09_22.md`, `WILDLIFE_CAPTURE_PIN_2026_09_22.md` | Pinning the ocean and wildlife at each perf shot |
| `R4_REVIEW_BRIEF.md`, `TEMPORAL_FLOORS_2026_09_21.md` | The R4 rebaseline and temporal floors |
| `SPLAT_BAKE_SEASON_RACE_2026_09_22.md` | A dropped splat bake after a season change |
| `TRAINER_SKIN_RESOLUTION_2026_09_23.md` | The trainer's blurry skin |
| `WATER_AGL_2026_09_20.md`, `WATER_COLOUR_2026_09_17.md`, `WATER_SUN_GLITTER_2026_09_19.md` | AGL over water, water colour, sun glitter |

## Status (`docs/status/`)

Snapshots from early September 2026, superseded by [OVERVIEW.md](OVERVIEW.md): `PROJECT_OVERVIEW.md`, `PROJECT_CLOSEOUT_2026_09_02.md`, `HANDOVER_2026_09_02.md`, `WHAT_CHANGED_2026_09_01.md`, `PHASE_6_OUTCOME.md`.

## Evidence (`docs/evidence/`)

Raw capture dumps cited by the plans and findings above: `phase-4-5-*.json` (three, 2026-08-20) and `low-tier-throttle-*.json` (four, 2026-09-29 and 30).

## Scripts (`scripts/`)

57 one-off probes, frame dumpers and benchmarks that nothing ran: ab-shape, airbrake-frames, aircraft-framing-inflight, aircraft-framing-probe, airliner-eye-grid, airliner-glazing-table, attract-hold-probe, blade-luminance-move, bodyaxes-probe, camo-slope-confirm, cdlod-lookup-benchmark, channel-extract-benchmark, closure-distribution, cockpit-crease-survey, cockpit-frames, cockpit-instrument-frames, cockpit-shell-clearance, cockpit-view-probe, crown-radius-distribution, docblock-truth-sweep, erosion-benchmark, erosion-seam-audit, flap-joint-frames, frame-bbox, glazing-frames, handsoff-probe, horizon-vantage-search, horizon-vantage-vegetation, l4-framing-check, l4-predicate-check, lit-diff, livery-band-height, livery-flank-frames, livery-frames, livery-measure, lowlevel-streaming-probe, mesopic-clock-probe, moon-night-shot-probe, night-look-metrics, night-shadow-trade-probe, nose-glazing-frames, perf-arm-compare, r4-flip-compares-to-baseline, r4-repin-floors, rudder-frames, seam-normal-model, seam-residual-decompose, sim-basis-probe, spine-frames, spoiler-frames, spoiler-stowed-frames, spoiler-turn-frames, tier-sweep and tier-sweep-analyse, twi-stats, wildlife-shot-birds, worst-tile-locate.
