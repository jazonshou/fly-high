# Low tier under a 4× CPU throttle — baseline, 2026-09-29

**Question (Jason, via the PM):** with Chrome DevTools' 4× CPU throttle, is the
game playable at the lowest settings?

**Answer:** the frame rate is not the problem. Hitches and input latency are.

At 4× both airframes hold roughly **50 fps in cruise and 31-37 fps on the
take-off roll**, far above the bar. But almost every scenario fails the bar
on isolated long main-thread tasks (up to 0.9 s), and the 747's input latency
fails too. Two defects found on the way are real bugs at any speed:

- **Control pump.** The keyboard control ramps assume 120 pump ticks per
  second. At 4× only about 30 fire.
- **Hydrology generation.** River and lake generation runs on the main thread,
  through the client's fallback path.

**Evidence:**
- `docs/evidence/low-tier-throttle-baseline-2026-09-29.json`: a compact
  extract of all 13 reports.
- The full reports, V8 profiles and a Chrome trace are in the perf engineer's
  `scratch-backup/baseline-2026-09-29/`.

## Setup

- **Host:** M2 Pro. **Browser:** Playwright Chromium 1234, headed, WebGPU via
  ANGLE-Metal. **Display:** 120 Hz, so rAF is 120 Hz unthrottled.
- **Settings:** 1920×1080 viewport. Tier 0 = scenery **Low** + rendering
  **Performance**. Seed `phase1-perf-baseline`. Clear weather, day 171, 12:30
  solar time.
- **Server:** the dev server (`vinext dev`) on the perf worktree at `8a62aea`,
  with the listener cwd proved by lsof. The latency and take-off re-runs used
  `b642c7a` and `85d5aa0`; these commits changed only the probe.
- **Instrument:** `scripts/throttle-probe.mts`, which drives the real front
  door: localStorage settings, the Start / Runway start buttons, real key
  events. `scripts/trace-summary.mts` and `scripts/cpuprofile-summary.mts`
  attribute the time.
- **Throttle:** CDP `Emulation.setCPUThrottlingRate`, the call the DevTools
  Performance panel makes.
- **Host state:** the host was quiet. Firefox's GPU helper read 0.0% before
  every run, and no other session used the GPU (PM-granted slot).

**Windows:**
- 21:48:13-22:02:31: warm-up plus runs.
- 22:02:50-22:05:12: latency re-runs.
- 22:05:55-22:07:57: Cessna take-off re-run.

**Control pair:** the Cessna cruise at 4× was run first and last. It read
**51 / 55 fps** median (8% apart, inside the 10% void rule), with identical
draw counts (212) and the same single hitch (**359 / 368 ms**). The slot is
valid, and that hitch is reproducible.

### What the DevTools throttle does and does not slow (settled, not assumed)

- Chrome **refuses** `Emulation.setCPUThrottlingRate` on a worker target with
  *"Operation is only supported for pages, not workers"*.
- On a toy page, a fixed loop took 29 ms on the main thread, **117 ms** when
  throttled. The same loop in a worker took **29 ms** throttled or not.
- So the 4× bar slows **the main thread only**. The physics worker, the
  terrain/detail/material workers and the GPU process run at full speed. The
  physics clock held `sim/wall = 1.00` in every run.
- **Consequence:** only main-thread work matters for this bar. Moving work
  *off* the main thread is a full remedy here, not a partial one.

## Scorecard against the PM's bar (4×, tier 0, 1920×1080)

| Bar | Cessna 150 | 747-8 |
| --- | --- | --- |
| **(1) Cruise 3,000 ft:** median ≥ 30 fps | **51 / 55** ✅ | **49** ✅ |
| (1) interval p95 ≤ 50 ms | 26.4 ✅ | 26.4 ✅ |
| (1) no hitch > 250 ms after 10 s | **1 hitch, 359 / 368 ms** ❌ | **2 hitches, max 735 ms** ❌ |
| **(2) Runway + 60 s after lift-off:** median ≥ 24 fps | **37** ✅ | **31** ✅ |
| (2) p95 ≤ 66 ms | 41.8 ✅ | 41.9 ✅ |
| (2) no hitch > 400 ms | max 141 ms ✅ (re-run) | **3 hitches over 250 ms, max 482** ❌ |
| **(3) Key-down → first frame showing it** ≤ 100 ms | median **96**, p90 116, max 118 ⚠️❌ | median **110**, p90 165, max 485 ❌ |
| **(4) Load → start screen, live flight**, ≤ 20 s | **9.7 s** ✅ | **9.5 s** ✅ |

Unthrottled on the same pages: 120 fps (display-bound), p95 ≈ 10 ms, no
hitches except one 78 ms task on the 747.

**Load time:**
- The start screen is up at 3.5 s unthrottled and 9.5-9.7 s throttled.
- These loads come from the **dev server**, so React is its *development*
  build. A production build would load faster.
- The probe's `firstFrameMs` (the first WebGPU `getCurrentTexture`) fires at
  ~1.1 s, before the game renderer exists. It most likely catches an engine
  clear, so the start-screen time is the number to use.

## Where the throttled frame goes

### By thread (10 s Chrome trace at 4×, cruise)

| Thread | Cessna | 747 |
| --- | ---: | ---: |
| Renderer main thread | **99.4%** busy | **99.4%** |
| GPU process main thread (not throttled) | 50.2% | 51.4% |
| Detail worker | 2.5% | – |
| Physics worker | 1.0% | 0.9% |

- The main thread is saturated, and the GPU process has half its time spare.
  The 4× frame is **main-thread-bound**, and there is no GPU wait to speak of.
- **Within the main thread (Cessna):** the rAF render loop takes 81%. Timers
  take 3.7%, worker messages 1.3%, and style/layout/paint about 3%.

### By whose code (8 s V8 profile at 4×, cruise; frames resolved through the dependency source maps)

| Origin | Cessna | 747 |
| --- | ---: | ---: |
| Ours (`src/`) | **35.3%** | **30.7%** |
| Babylon | **33.4%** | **35.2%** |
| Browser native `(program)` + builtins | 13.6% | 14.4% |
| React (development build: an upper bound) | 4.5% | 4.5% |
| Garbage collector | 0.8% | 1.1% |

### Top 10 self-time entries, Cessna cruise at 4× (excluding `(program)`)

| # | Self | Function | File |
| ---: | ---: | --- | --- |
| 1 | 5.9% | `selectTerrainNodes` | `terrain/TerrainQuadtree.ts` |
| 2 | 3.1% | `resolveTerrainResidentCornerMorphs` | `terrain/TerrainQuadtree.ts` |
| 3 | 2.9% | `_render` (shadow/RTT) | Babylon `renderTargetTexture` |
| 4 | 2.4% | `jsxDEV` | React dev runtime |
| 5 | 1.8% | (anonymous) | `terrain/TerrainQuadtree.ts` |
| 6 | 1.7% | `bindForSubMesh` | Babylon `pbrBaseMaterial` |
| 7 | 1.6% | `makeCandidate` | `terrain/TerrainQuadtree.ts` |
| 8 | 1.5% | `updatePresentation` | `render/FlightRenderer.ts` |
| 9 | 1.4% | `planSplit` | `terrain/TerrainQuadtree.ts` |
| 10 | 1.3% | `update` | `terrain/TerrainClipmapSystem.ts` |

The 747's top ten is the same set in a slightly different order.
`selectTerrainNodes` is first on both (4.3%).

**Inclusive (Cessna):**
- `FlightRenderer.render`: 72.6%. It splits into:
  - `updateWorldVisibility` 30.1%, of which the terrain clipmap `update` is
    **23.9%** and `selectTerrainNodes` 14.7%;
  - Babylon `scene.render` 33.8%, of which shadow-map RTT rendering is 13.5%
    and PBR `bindForSubMesh` 8.7%.
- React's `performWorkOnRoot`: 4.6%.

**The single biggest item we own is CDLOD terrain node selection, re-run from
scratch every frame, even in steady cruise (a quarter of the throttled main
thread).** `TerrainQuadtree.ts` alone is 19.4% self time on the Cessna.

### The adaptive governor at 4×

- The CPU governor is at **level 7 of 7 on both airframes**, with every
  CPU-ladder lever spent: terrain requests at 2, detail budget at 0.75 ms / 8,
  animals at 16.
- Draws are **212** (Cessna) and **~170** (747). The GPU ladder is at 0, and
  the render scale is the tier's 0.72.
- None of the CPU levers touches the cost this profile names: terrain
  selection or render submission.

## The failures, attributed

### Hitches

- **Confirmed: hydrology region generation on the main thread.**
  - The Cessna trace holds one **317 ms** main-thread task: a `TimerFire` in
    `HydrologyGenerationClient.ts`. That file's only timer is its fallback
    scheduler, so this is `generateHydrology` running on the main thread. It
    is ~80 ms at 1×; the 747's one unthrottled long task was 78 ms.
  - **The hydrology worker is absent from the trace.** Only the detail,
    material-synthesis and simulation workers exist, although the renderer
    passes `workerWorldSeed`.
  - `/src/workers/hydrology.worker.ts?worker_file&type=module` serves 200, so
    the worker script is not missing. The client reached its main-thread path
    either through `activateFallback()` (worker `error`/`messageerror`) or
    through the per-request retry after a worker-reported error. **Which one
    is not yet known.** `HydrologySystem.getStatistics().usingMainThreadFallback`
    answers it, but it is not in `RenderDiagnostics`.
  - Regions are 14.4 km wide with 7.2 km spacing, so a swap comes about every
    2.4 min at Cessna cruise speed and about every minute in the 747.
- **Not yet attributed:**
  - the other hitches (the 747's 735 ms and 697 ms tasks are bigger than a
    hydrology generation);
  - the Cessna's reproducible 359/368 ms hitch in the fps window, which fell
    outside the 10 s trace window.

  The next slot adds the `long-animation-frame` observer to the probe, which
  attributes every long frame to its script at negligible cost.

### Input latency

The chain has three stages:

1. **Key → page handler: 1-18 ms.** The event waits for the busy main thread.
2. **→ physics output moves the surface: median 43-49 ms, max ~140 ms.**
3. **→ first displayed frame: roughly another 45-60 ms.** This covers the
   60 Hz snapshot, the fixed 1/60 s presentation delay and a ~20 ms throttled
   frame.

**Bug found (stage 2): the control pump integrates a fixed 1/120 s per
tick.**
- `startFlightControlPump` calls `input.getControls(1/120)` from a
  main-thread `setInterval(8.33 ms)`.
- At 4× the trace counts **30.6 ticks/s (Cessna) and 28.7 ticks/s (747)**,
  not 120.
- So under load:
  - the keyboard throttle (0.6/s) and the pitch/roll slews advance about **4×
    slower in wall time**;
  - control updates reach the worker at 30 Hz.
- The first Cessna take-off never reached full power. Shift was held 4 s; the
  aircraft rotated at 56 s instead of 20 s and crashed after lift-off.
- The same defect hits any player whose main thread is slow, throttled or
  not.

## Instrument corrections, disclosed

1. **The first latency detector was void.** It also read the aircraft's
   attitude, which drifts every frame, so each trial "responded" 0-17 ms after
   the key: before the handler ran and before the physics moved anything. The
   fix reads the surface digest only, against a per-trial noise floor, and
   rejects any render change earlier than the physics snapshot's. The numbers
   above come from the re-run (`b642c7a`); 38 of 40 trials were causal.
2. **The first Cessna take-off crashed** because of the pump bug. The re-run
   holds Shift 10 s and rotates for 0.8 s (`85d5aa0`).
3. A `--remote-debugging-port` beside Playwright's pipe hangs this machine's
   Chromium launch. This cost the first 4 minutes of the slot; no data was
   taken then.
4. Trace windows are 10 s and do not overlap the fps windows. Hitch
   attribution therefore needs the per-frame observer, not a longer trace.

## What this says about the work

- **The bar fails on long single tasks and on latency, not on throughput.**
  Throughput has ~1.7× headroom at 4× (≈ 50 fps against 30).
- The most valuable fixes are therefore:
  - taking the few big main-thread tasks off the main thread (hydrology first);
  - fixing the control pump.
- The **steady-state lever with the most headroom is the per-frame terrain
  node selection** (~24% of the throttled main thread). It matters for weaker
  machines, and for the take-off case where the margin is smallest (31 fps
  against 24).
- The ranked plan is in
  [`LOW_TIER_PERFORMANCE_PLAN.md`](../plans/LOW_TIER_PERFORMANCE_PLAN.md).
