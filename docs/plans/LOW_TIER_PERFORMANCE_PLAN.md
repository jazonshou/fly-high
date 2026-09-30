# Low tier under a 4× CPU throttle — plan

**Goal (Jason, 2026-09-29):** with Chrome DevTools' 4× CPU throttle, the lowest
settings stay playable.

**Acceptance (set by the PM).** Every bar below is at 4×, on tier 0 (Low +
Performance), at 1920×1080 on this M2 Pro:

1. **Cruise at 3,000 ft:**
   - median ≥ 30 fps;
   - frame-interval p95 ≤ 50 ms;
   - no hitch > 250 ms after the first 10 s.
2. **Runway start and the first 60 s after lift-off:**
   - median ≥ 24 fps;
   - p95 ≤ 66 ms;
   - no hitch > 400 ms.
3. **Input:** key-down to the first visible response ≤ 100 ms.
4. **Load:** load to the first frame ≤ 20 s.

All four are measured on the Cessna 150 and on the 747.

**Instrument:** `scripts/throttle-probe.mts` (the scenarios `cruise`, `takeoff`,
`latency` and `coldstart`), with `scripts/trace-summary.mts` and
`scripts/cpuprofile-summary.mts` for attribution.

**Baseline:**
[`LOW_TIER_THROTTLE_BASELINE_2026_09_29.md`](../findings/LOW_TIER_THROTTLE_BASELINE_2026_09_29.md).

## What the baseline changed about the plan

- **The DevTools throttle slows only the main thread.** Chrome refuses the
  throttle on worker targets, so workers and the GPU process run at full
  speed. Moving work off the main thread therefore fully removes it from this
  bar.
- **Throughput already passes, with room to spare.** Cruise runs at about
  50 fps against a bar of 30, and take-off at 31-37 fps against a bar of 24.
- **The failures are elsewhere:**
  - single long main-thread tasks (hitches of 0.3-0.9 s);
  - input latency, where the 747 fails and the Cessna is borderline;
  - a control-pump defect that makes the keyboard itself 4× slower under
    load.
- **The adaptive governor is already exhausted at 4×** (CPU ladder at 7 of 7).
  None of its levers touches the named costs.

So the order below is **correctness first, then hitches, then latency, then
steady-state headroom.** Every step lands with a measurement on the same
probe and the same bar. Each step is proposed to the PM before any code
changes.

## Ranked levers

### P1 — Control pump integrates real elapsed time (bug; `src/game/controlPump.ts`)

- **What is wrong.** `startFlightControlPump` calls
  `input.getControls(CONTROL_PUMP_STEP_SECONDS)` (1/120 s) from a main-thread
  `setInterval(8.33 ms)`. At 4× only 29-31 ticks fire per second. So the
  keyboard throttle, pitch and roll ramps run about 4× slow in wall time, and
  controls reach the physics at 30 Hz.
- **Change.**
  - Pass the measured time since the last tick, clamped to [0, 50 ms]. The
    clamp stops a stalled tab from applying one huge step.
  - Post immediately on a key edge rather than waiting for the next tick.
    This takes the handler → pump wait out of the input chain.
- **Proof.**
  - A Node test with an injected clock: 30 ticks of 33 ms must equal 120
    ticks of 8.33 ms in the throttle/pitch reached.
  - The probe: time to full power, and the latency bar.
- **Risk.** Low. The pump's tests already inject ticks
  (`FlightControlPump.tick`).

### P2 — Hydrology generation off the main thread (hitch; `water/HydrologyGenerationClient.ts`, `HydrologySystem.ts`)

- **What is wrong.** Region generation runs on the main thread: 317 ms at 4×,
  ~80 ms at 1×. The hydrology worker is missing from the trace, although the
  renderer asks for it. Its script serves 200, so it is not a missing file.
- **Step 1, a diagnosis to finish.**
  - Expose `HydrologySystem.getStatistics().usingMainThreadFallback`,
    `lastGenerationUsedWorker` and `failedGenerationCount` to the probe.
  - Capture why the worker went away: its `error` event, or a worker-reported
    per-request error.
- **Step 2, a structural guard.** Make the main-thread path unable to produce
  a long task.
  - A worker failure should restart the worker (bounded retries) rather than
    permanently switch to main-thread generation.
  - If main-thread generation must run, it runs in slices under a per-frame
    budget, never a whole region in one task.
- **Proof.** Hydrology leaves the long-task list. The cruise-window hitch
  count is re-measured.
- **Ownership note.** This is water code. The water engineer is on the Global
  cockpit this wave, so the PM decides who takes it.

### P3 — Attribute every remaining hitch, then fix each (instrument first)

- **What is unexplained.** The 747's 697/735 ms tasks, and the Cessna's
  reproducible 359/368 ms cruise hitch, fell outside the 10 s trace windows.
- **Instrument.** Add a `long-animation-frame` PerformanceObserver to the
  probe. It is Chrome's per-frame script attribution: invoker, source URL and
  function, and duration.
  - Log each long frame with the governor level, the terrain/detail pending
    counts and the hydrology statistics at that second.
  - This costs nothing measurable and covers every window.
- **Suspects** (pending evidence):
  - governor ladder transitions (the CPU ladder steps during the first
    throttled 30 s);
  - bursts of terrain page or detail cell publications;
  - `heights.slice()` copies in `publishTerrainConsumerPage`;
  - React state commits.

### P4 — Input latency: the rest of the chain

- **The chain, measured at 4×:**
  - key → handler: 1-18 ms;
  - → physics output: median 43-49 ms, max ~140 ms;
  - → display: +45-60 ms.
- **After P1:**
  - re-measure;
  - check the fixed 1/60 s presentation delay against the 60 Hz snapshot
    cadence when the renderer is CPU-bound. Any change here trades
    interpolation smoothness for latency, so it is measured, not assumed.

### P5 — Steady-state headroom: terrain node selection (`terrain/TerrainQuadtree.ts`, `TerrainClipmapSystem.ts`)

- **The cost.** CDLOD selection re-runs from scratch every frame:
  - 23.9% of the throttled main thread inclusive (Cessna);
  - `TerrainQuadtree.ts` alone is 19.4% self time.
- **Candidates**, each with a pixel-identity check on the capture rig:
  - Reuse the previous selection when the camera has moved less than a
    fraction of the finest resident node's split distance and rotated less
    than a threshold. The morph factors still update every frame.
  - Make selection incremental: re-plan only the subtrees whose split test
    changed.
  - At tier 0 only, run selection at half rate, with the morph continuous.
- **Why it matters.** This is the biggest single thing we own on the main
  thread. It widens the take-off margin (31 fps against 24) and weaker
  machines' margins.
- **Constraint.** The terrain draw count is pinned per shot in the rig. A
  selection that is not bit-identical moves pins, and those can only be
  re-measured by the rig on a quiet host.

### P6 — Shadow-map submission at tier 0 (visual trade-off; needs Jason)

- **The cost.** Shadow RTT rendering is 13.5% of the throttled main thread
  inclusive (2 cascades, 900 m).
- **Options:**
  - alternate the cascade updates across frames;
  - update the far cascade at half rate;
  - skip casters below a screen-size threshold.
- **Decision.** Each changes pixels, so Jason chooses. Pins move only through
  the rig.

### P7 — React HUD cadence (`src/game/FlightGame.tsx`, `src/ui/Hud.tsx`)

- **The cost.** `setVisualState` (about 13 Hz) and `setDiagnostics` (every
  500 ms) re-render the top-level `FlightGame`. That is 4.5% of the throttled
  main thread, but in React's *development* build.
- **Change.** Move HUD state into a small external store that only `Hud`
  subscribes to (`useSyncExternalStore`), so the game root stops re-rendering.
- **Before touching it.** Measure it first in a production build (see P8).

### P8 — A production-build measurement (load, React share)

- **Why.** Every baseline number comes from the dev server: unbundled modules
  and React's development build.
- **How.** One run each of `coldstart` and `cruise` against `vinext build` +
  `vinext start` sizes how much of the load time (9.5-9.7 s at 4×) and of
  React's 4.5% is dev-only.
- **Constraint.** The build is CPU-heavy, so it runs only in a PM-granted
  window.

## Not planned (and why)

- **More governor rungs on the existing CPU ladder.** The ladder is exhausted,
  and its levers are not the named costs.
- **Lowering tier 0's pixel or GPU budgets.** The throttle does not slow the
  GPU, and the GPU process is only half busy. A GPU lever cannot move this bar.
- **A WebGL renderer as a performance remedy.** WebGL2 submission costs *more*
  main-thread time per draw. See
  [`WEBGL_FALLBACK_PLAN.md`](WEBGL_FALLBACK_PLAN.md) §8.

## Rules this work follows

These are the wave rules, restated:

- One GPU owner at a time, on the PM's grant.
- Kill only my own processes, by PID.
- Never add a second WebGPU engine to a page or test file.
- A pinned rig number (baselines, draw ceilings, delivery floors) moves only
  by re-measurement on a quiet host, never by hand.
- No edits under `src/render/webgpu/aircraft/**`.
- The PM runs every merge into Fix-Cockpits.
