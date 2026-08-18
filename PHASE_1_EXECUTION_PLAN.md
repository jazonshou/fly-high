# Phase 1 Execution Plan — Foundation, Correctness and the Atmosphere Spine

**Status:** execution reference for Phase 1 of `RENDERING_PLAN.md`. It does not restate that plan; it decides everything that plan leaves to implementation time.
**Runs after:** `PHASE_0_ARCHITECTURE_SHIFT.md` (16.8 d, ~3.7 weeks). **Phase 0's exit criteria are this plan's preconditions.**
**Basis:** `TERRAIN_AUDIT.md` (root causes, treated as established fact) and `RENDERING_PLAN.md` §2 Phase 1 (gates 1A/1B/1C).
**Verified against:** working tree at `58d5d15`, plus the contracts Phase 0 lands.
**Effort:** **43.0 days**, ~9.6 calendar weeks at 4.5 productive days/week. (48.6 in `RENDERING_PLAN.md`; −5.6 after Phase 0 absorbs five items and shrinks four more, +0.0 net amendment cost — see §3.)
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

---

## 0. What this document adds

`RENDERING_PLAN.md` says *what* Phase 1 does and *why*, in one table per gate. This document decides *how*, in the order the work is actually done:

1. **An engineering standard keyed to code lifetime** (§2) — the direct answer to "foundations over quick fixes". Not every Phase 1 file deserves the same care, and the ones that do are not the obvious ones.
2. **Seven amendments to the plan** (§3), each with a rationale and a cost. Five of them move work *earlier* — now mostly into Phase 0 — because doing it later costs more; one flags a stale number in the source plan.
3. **The interfaces Phase 1 establishes** (§4), with real signatures, and what it inherits from Phase 0.
4. **A serial work order with a critical path and a week-by-week ledger** (§5). Phase 1 is executed by one person; ordering is the only schedule lever.
5. **Item-by-item execution detail** (§6–§8): intent, lifetime class, files, design, verified gotchas, tests, done-when.
6. **The verification apparatus** (§9): what runs in Node CI, what needs a GPU, what the screenshot baseline is, and when it is allowed to churn.
7. **A Phase-1-specific risk register with triggers** (§10) and an exit checklist (§11).

Read §2, §3 and §5 before writing any code. The rest is reference material consumed one item at a time.

### 0.1 What changed when Phase 0 was inserted

| Item | Was | Now |
|---|---|---|
| `1A-4` cloud bug (0.8 d) | Phase 1, day 1 | **Executed during Phase 0, day 1.** Still a Phase 1 item by ownership; its days are counted in Phase 0's elapsed calendar, not here. |
| `1A-6a` pixel cap (0.5 d) | Phase 1, day 1 | **Executed during Phase 0, day 1.** Same. |
| `1A-3` WebGPU test harness (1.0 d) | Phase 1 | **Moved to Phase 0 `0-8`.** The decision is architecture and it gates every Phase 4 parity test. |
| `1A-7` plugin + `ShadowDepthWrapper` spike (1.0 d) | Phase 1 | **Moved to Phase 0 `0-9`, run first.** It validates an architectural premise; if it fails, the architecture changes. |
| A1 24-bit hash (0.25 d) | Phase 1 amendment | **Moved to Phase 0 `0-4`.** |
| `1B-1` normals | 1.5 d | **1.25 d** — the halo addressing convention is anchored by Phase 0 `0-2`. |
| `1B-2` band-limiting | 3.0 d | **2.0 d** — Phase 0 `0-4` threads `filterWidthMeters`, lands the domain wrap and clamps `pow` bases. What remains here is the behaviour change alone. |
| `1C-1` env-director | 2.5 d | **2.25 d** — `EnvironmentClock` and `latitudeDegrees` exist. |
| `1C-9` clock + UI | 1.75 d | **1.0 d** — the settings schema and migration are done. |
| `1C-4` aerial-include | 5.0 d | **4.5 d** — `SharedReceiverRegistry` exists. |
| `1C-6` IBL | 3.0 d | **2.75 d** — same. |
| **Phase 1 total** | **49.6 d** | **43.0 d** |

Nothing was cut. Everything either moved to Phase 0 or got cheaper because Phase 0 landed its foundation.

---

## 1. Preconditions

**Phase 0's exit criteria are this plan's preconditions.** In particular, do not start Phase 1 unless:

- `0-9` is resolved. If the `ShadowDepthWrapper` premise failed, Phases 3 and 4 are re-planned *before* Phase 1 begins.
- `npm run test:gpu` acquires an adapter (`0-8`), or the manual fallback is documented.
- The kernel is signature-complete: `filterWidthMeters` is a required parameter at all four entry points and a behavioural no-op (`0-4`).
- All physics terrain queries route through `src/sim/terrainGrid.ts`, and the four §1.3 invariant tests pass (`0-5`).
- No screenshot baseline has been committed yet. `1A-1` commits the first one.

Plus four standing conditions:

| # | Precondition | Action | Why |
|---|---|---|---|
| P1 | Babylon pinned exactly | `@babylonjs/core` is `"9.21.2"` — confirm no caret is introduced | Half of Phase 1's mechanics depend on verified 9.21.2 internals: `ShadowDepthWrapper`, plugin regex injection, WGSL `yFactor`, `CascadedShadowGenerator` texture-format selection. A silent minor bump is a silent renderer break. |
| P2 | Branch per gate, not per phase | `phase1/gate-1a`, `-1b`, `-1c` | A gate is a shippable state. Merging at gate boundaries keeps `main` always flyable and rebases screenshot baselines at three known points instead of thirty. |
| P3 | `npm run verify` green on a clean tree | `npm run verify` | It runs lint, typecheck, test and build. Phase 1 adds assertions to `test`; establish the baseline before adding to it. |
| P4 | Record the pre-Phase-1 numbers | Fly the fixed profile once and note fps, settled `renderScale`, `drawCalls`, `residentTerrainPages` | The real harness lands on day ~5; capture the "before" state first. Note the pixel cap already landed in Phase 0, so this is a post-cap baseline. |

**Working agreement.** One item per commit where the item is ≤1 day; one commit per coherent sub-step where it is longer. Every commit leaves `npm run verify` green. Every commit that changes what is on screen names the audit root cause it closes or the plan item ID in the subject line.

---

## 2. The engineering standard: invest by lifetime

The instruction is to prioritise proper, reliable foundational code over quick fixes. Applied indiscriminately that produces a *worse* outcome here, because a non-trivial fraction of Phase 1 exists specifically to be deleted in Phase 4. Polishing code that `4-4` and `4-5` remove is not foundation work; it is waste wearing foundation's clothes.

So every Phase 1 item is classified by how long its code lives, and the standard is set per class. Phase 0 made the same split and its `0-3` is the sharpest case: the `world/` modules it adopts are Class P, the adapter it writes into the clipmap is Class T.

### Class P — Permanent (lives past Phase 7)

`PerformanceBudget.ts`, `AdaptiveGovernor.ts`, `RenderDiagnostics` and the HUD panel, `EnvironmentDirector`, `AtmosphereLuts`, `AerialPerspective`, `SkyEnvironmentProbe`, `CloudReprojection`, the screenshot harness.

**Standard.** Full design: named module, explicit exported interface, no Babylon import in anything that can avoid one, pure functions over arrays and numbers wherever the logic is arithmetic. Unit tests against the interface, in `environment: "node"`, no GPU. A doc comment at the top of each file stating the invariant it owns. These are the renderer's API surface.

### Class K — Kernel (lives to Phase 5, then becomes the uplift field)

`src/world/terrain.ts`, `geology.ts`, `noise.ts`, `seed.ts`.

**Standard.** Class P plus two obligations: it must be **portable to WGSL by transliteration**, and it is the **physics authority** until `5-2`. Phase 0 `0-4` already made it portable and `0-5` already named and tested the authority; Phase 1 touches it exactly once, at `1B-2`, and that touch is a behaviour change with a golden-value test.

### Class T — Transitional (deleted in Phase 4)

`src/world/tile.ts` generation loop, `TerrainClipmapSystem`'s page/mesh path and its `world/` adapter, `TerrainGenerationClient`, `terrain.worker.ts`, the resolution ladder.

**Standard.** Correct, tested at the boundary, and **deliberately un-generalised**. No new abstractions, no new options, no new buffer channels, no refactors for elegance. If a change here does not close an audit root cause or unblock a later item, it does not happen. `1B-3` is the archetype: a profile field and an interface field, nothing more.

### Class D — Disposable (deleted inside Phase 1)

The budget-probe sweep's temporary UI, any false-colour debug view.

**Standard.** Write it, use it, delete it in the same commit or the next. Do not leave dead-but-compiling code — `RENDERING_PLAN.md` §3.5 identifies exactly that habit as the origin of the orphaned `payload.ts` that Phase 0 `0-3` had to resurrect.

### Applying the standard — three concrete calls

- **`1B-1` is a Class K/T split.** The halo-aware grid generation in `tile.ts` is Class T and gets the minimum viable implementation. The *coordinate convention* is Class P — and Phase 0 `0-2` already owns and tests it, so `1B-1` imports `coreToStoredIndex` rather than re-deriving it. That is the 0.25 d saving.
- **Do not widen the CPU tile `colors` buffer to RGBA**, even though `RENDERING_PLAN.md` §3.2 and audit §2.2 want an alpha channel for baked sky visibility. That buffer is `Uint8Array(vertexCount * 3)` at `tile.ts:115-118` and the whole path is deleted at `4-4`. The alpha channel belongs to the Phase 4 channel atlas. **Explicitly out of scope.**
- **`1B-2` is now a behaviour change only**, and that is the whole reason Phase 0 exists in the form it does. Changing the physics authority's arithmetic is a two-function diff with an invariance test already in place, not a twenty-call-site refactor that also changes what the ground is shaped like.

---

## 3. Amendments to `RENDERING_PLAN.md` Phase 1

Seven. Each states what changes, why, and the cost.

### A1 — 24-bit hash truncation → **Phase 0 `0-4`**

`seed.ts:52-58` returns `(hash >>> 0) * (1/2³²)` in f64; `f32` cannot reproduce that above 2²⁴, so a 32-bit conversion can never be bit-identical between the CPU kernel and its WGSL port. Replace with `(hash >>> 8) * (1/16777216)`.

`RENDERING_PLAN.md` R10 lists this as one of three items that churn every seed's world and asks that seed-churning items land together so baselines rebase once. In Phase 4 that costs a rebase. **Before any baseline exists, it costs nothing** — which is now Phase 0, an even better place than Phase 1 day 1. **Delivered by `0-4`.**

### A2 — The domain wrap → **Phase 0 `0-4`**; the octave cutoff stays at `1B-2`

`RENDERING_PLAN.md` §1.3 requires a per-octave lattice-period domain wrap for CPU/GPU parity, and defers it to `4-1`. It belongs earlier, for one mechanical and one structural reason.

*Mechanical:* the wrap and the band-limit cutoff touch the same twelve lines. Editing them twice means two reviews, two rounds of golden-value churn, and two chances to diverge the physics path from the render path.

*Structural, and this is the sharper point:* Phase 0 separates them by **kind**. `0-4` changes the *interface and numerics substrate* — hash precision, coordinate wrapping, `pow` legality, and `filterWidthMeters` threaded as a no-op through ~20 call sites — with behaviour bit-identical. `1B-2` then changes *behaviour* in two functions, against a parameter that is already threaded and an invariance test that already exists. A refactor that simultaneously changes a signature everywhere and changes what the ground is shaped like is a bad thing to debug when the code in question is the flight model.

**Cost:** `1B-2` drops 3.0 → 2.0 d; `4-1` drops ~0.5–1.0 d and loses risk R8 from its critical path.

### A3 — `1A-6` splits; `1A-6a` executes in Phase 0

`RENDERING_PLAN.md` lists `1A-6` as 2.0 d depending on `1A-2`, while its own "first week, in order" list puts the pixel cap second, ahead of `1A-2`'s two days, because *"nothing else can be judged visually until the renderer stops silently trading resolution for nothing."* Both cannot be true.

- **`1A-6a` — pixel cap + DPR ceiling (0.5 d), no dependencies.** A clamp and two profile fields, and a ~4× reduction in every per-pixel cost. **Executed on day 1 of Phase 0** so the renderer stops degrading itself before three and a half weeks of infrastructure work.
- **`1A-6b` — the two-governor rewrite (1.5 d).** Governor B *consumes* `FrameGraph.passTimings`, which `1A-1` surfaces, so it genuinely cannot precede it. Stays in Phase 1.

### A4 — Order `1B-3` after `1B-1` and `1B-4`

`RENDERING_PLAN.md` lists `1B-3` with no dependencies. It sets a constant resolution of 65 across all levels at tiers 1–2; today tier 2 runs 65 at levels 0–2 and 33 above, measured at 67 + 105 pages and 765,184 triangles. Promoting all 172 to res 65 is ~1.41 M triangles (1.84×) and quadruples generation work for 105 of them.

Landing that before `1B-1` cuts per-page cost 40.6 ms → ~8 ms, and before `1B-4` widens the generator from one worker to six, produces a visible streaming regression inside the gate. Sequenced after both, a full resident set is ~0.23 s of wall clock against the ~3.9 s measured today.

### A5 — `1B-3`'s ladder is a measured decision with a recorded fallback

Implement the ladder as a datum on `WebGpuQualityProfile`, not a table inside `TerrainClipmapSystem`. Default to constant 65 at tiers 1–2 and 33 at tier 0, exactly as the plan says — then **measure**, and switch tiers 1–2 to constant 33 if the terrain-raster row exceeds budget.

Both ladders are strictly 2:1 in ground sample distance and both eliminate the 4:1 T-junction, which is the entire point of the item. They differ only in near-field density: 8 m vs 16 m at L0. The audit measured the finest wavelength anywhere in the kernel at **43 m**, so 16 m is still below Nyquist for content that exists — and the audit's own corollary says the near rings currently render "a smooth 43 m swell at 5 samples per wavelength". Making it a profile datum costs nothing and converts a guess into a measurement. **Build a two-entry table, not a resolution policy** — `4-5` deletes it either way.

### A6 — Gate 1C's stated total in the source plan is stale

Not a change — a correction to avoid a false schedule. `RENDERING_PLAN.md` heads Gate 1C "(18.0 d)", but its ten items sum to **21.5 d**. 18.0 is the pre-season figure; the phase total of 48.6 d (= 10.3 + 16.8 + 21.5) already includes the season additions and is correct.

### A7 — `1A-3` and `1A-7` → **Phase 0 `0-8` and `0-9`**

Both are architecture, not implementation.

`1A-7` validates a **premise of `RENDERING_PLAN.md` §1.1's "after" column** — height read in the vertex shader through a material plugin, with shadows following. If it fails, terrain becomes a dedicated `ShaderMaterial` and Phases 3 and 4 are written differently. An architectural premise must be tested before the architecture is recorded, so it runs on **day 1 of Phase 0**.

`1A-3` decides the environment in which every WGSL contract is enforced, and `RENDERING_PLAN.md` says to decide it before any Phase 4 work. Deciding it in the phase whose product *is* enforcement is strictly better.

---

## 4. Interfaces

### 4.1 Inherited from Phase 0

Phase 1 consumes these and must not re-derive them. The boundary test from `0-1` will fail if it tries.

| Artefact | From | Used by |
|---|---|---|
| `WORLD_PAGE_GUTTER` / `HEIGHT_CORE` / `CHANNEL_CORE` / `BASE_EXTENT`, and `coreToStoredIndex` | `0-2` | `1B-1`'s tile halo |
| `WorldPageAddress`, `createWorldPageKey`, `worldPageBounds`, `WorldPageLifecycle`, `rankWorldPageStreamingCandidates` | `0-3` | `1B-3`, `1B-4` |
| `filterWidthMeters` on all four kernel entry points | `0-4` | `1B-2` |
| `src/sim/terrainGrid.ts`, `TerrainCollisionMirror.ts`, `collisionSamplesServedByFallback` | `0-5` | `1B-2`'s invariance argument |
| `EnvironmentClock`, `WorldDefinition.latitudeDegrees`, settings persistence + migration | `0-6` | `1C-1`, `1C-9` |
| `SharedReceiverRegistry` | `0-7` | `1C-4`, `1C-6` |
| `vitest.gpu.config.ts`, `npm run test:gpu` | `0-8` | `1C-4`'s shader compile assertions |
| The `ShadowDepthWrapper` incantation, recorded verbatim | `0-9` | Phase 2 `2-12`, Phase 3 `3-2`, Phase 4 `4-4` |

**Phase 0 outcomes (2026-08-17) that amend this table:**

- **`SharedReceiverRegistry` shipped with three type parameters** — `SharedReceiverRegistry<TProjection, TBinding, TPlugin>` — because the extracted cloud pattern resolves the projection into one floating-origin-local *binding* per update and exposes it (`currentBinding`). §4.3's `AerialPerspectiveRegistry` sketch is corrected below; `1C-4`/`1C-6` supply their own binding types.
- **`0-9`'s validated incantation carries an ordering constraint:** the wrapper must be created and assigned *before the material's first effect compiles* (it observes `onEffectCreatedObservable`; attached later it silently falls back to the undisplaced depth pass), and no `remappedVariables` are needed for `PBRMaterial`+plugins in WGSL. See `ARCHITECTURE.md` and `tests/gpu/shadow-depth-wrapper.test.ts`.
- **`TerrainGenerationClient.request` rejection contract changed (review fix):** a request the bounded queue rejects is signalled by the `-1` return **alone** — `onError` is no longer invoked re-entrantly for the request being submitted. `onError` still fires (synchronously) for a previously-queued request evicted in favour of a better newcomer. `1B-4`'s slot-map widening must preserve this; `tests/render.webgpu-terrain-clipmap.test.ts`'s real-client saturation test is the guard.
- **`0-6` also exports `TIME_OF_DAY_PRESET_CLOCKS`** (label → `{dayOfYear, solarTimeHours}`) from `src/settings` — `1C-9`'s preset buttons write these exact pairs.
- **`0-1`'s boundary test grandfathers three `profile.tier` readers** (`TerrainClipmapSystem`, `PlanarWaterReflectionSystem`, `SpectralOceanSystem`); the items that touch them (`1B-3`, Phase 2 water work) must shrink that list, not extend it.

### 4.2 New files created by Phase 1

| File | Class | Owns | By |
|---|---|---|---|
| `core/PerformanceBudget.ts` | P | Per-tier frame and memory budgets; `assertWithinBudget()` | `1A-2` |
| `core/AdaptiveGovernor.ts` | P | The two governors, as pure functions | `1A-6b` |
| `core/RenderInvariants.ts` | P | Startup assertions and capability probes | `1A-2`, extended by `1C-4` |
| `nature/EnvironmentDirector.ts` | P | The single source of lighting truth; NOAA solar position | `1C-1` |
| `atmosphere/AtmosphereLuts.ts` | P | Transmittance + multiple-scattering LUTs and their TS mirror | `1C-3` |
| `atmosphere/AerialPerspective.ts` | P | The shared WGSL include, TS mirror, and its receiver registry | `1C-4` |
| `atmosphere/SkyEnvironmentProbe.ts` | P | Sky cube → SH irradiance + specular probe → `environmentTexture` | `1C-6` |
| `clouds/CloudReprojection.ts` | P | Camera-relative ray basis reprojection, round-trip tested | `1B-12` |
| `workers/detail.worker.ts` | P | Off-main-thread detail cell generation | `1B-10` |
| `scripts/perf-capture.mts` | P | Fixed-seed screenshot and numeric capture | `1A-1` |

### 4.3 Decided here

**Tile halo — the convention comes from Phase 0; the option is local.**

```ts
// src/world/tile.ts  (Class T body, Class P convention imported from world/pageGeometry.ts)
export interface TerrainTileOptions {
  /**
   * Rows/columns generated outside each edge of the core grid. Central
   * differencing needs 1; the Phase 4 page atlas uses 4. Addressing follows
   * coreToStoredIndex() from world/pageGeometry.ts — do not re-derive it.
   */
  readonly halo?: number;
}
```

**Aerial perspective — one include, many consumers, built on the Phase 0 registry.**

```ts
export const AERIAL_PERSPECTIVE_WGSL: string;          // fn aerialPerspective(...)
export declare function packAerialPerspectiveUniforms(
  state: EnvironmentState, cameraAltitudeMeters: number,
): Float32Array;
/** TS mirror; used by exposure, the IBL SH bake and CI agreement tests. */
export declare function evaluateAerialPerspective(
  state: EnvironmentState, fromAltitude: number, toAltitude: number,
  distanceMeters: number, viewDotSun: number,
): { transmittance: [number, number, number]; inScatter: [number, number, number] };
// Phase 0 outcome: the shipped base class is three-generic —
// SharedReceiverRegistry<TProjection, TBinding, TPlugin> — with abstract
// pluginName/isEligibleMaterial/createPlugin/resolveBinding/applyProjection/
// clearPlugin hooks. 1C-4 defines the projection and binding shapes.
export declare class AerialPerspectiveRegistry extends SharedReceiverRegistry<
  AerialPerspectiveProjection,
  AerialPerspectiveBinding,
  AerialPerspectivePlugin
> {}
```

**Environment director — the clock type already exists.**

```ts
export declare function resolveEnvironmentState(
  input: { clock: EnvironmentClock; latitudeDegrees: number; weather: WeatherPreset },
): EnvironmentState;   // the previously-dead type in nature/EnvironmentState.ts
```

`presetFor()` (`AtmosphereSystem.ts:93-125`) is deleted in the same commit this lands. `TimeOfDayPreset` survives in `src/settings` as a *label*; nothing in `src/render/` branches on it afterwards.

### 4.4 Deleted by Phase 1

`presetFor()` · `worstFrameTimingPercentile95` and its call site · village/building generation and its types · the cluster-lattice scatter.
(`renderTargetUv` and `qualityPixelRatio` were deleted in Phase 0 with `1A-4` and `1A-6a`.)

---

## 5. Work order

### 5.1 Dependency graph

```
1A-2 ─→ 1A-6b ─→ (HUD panel)
1A-1 ─┘
1A-5 ─→ 1B-11

1B-1 ─→ 1B-2 ─→ (Phase 4: 4-1)
1B-4 ─┬→ 1B-3
      └→ 1B-10
1B-5 ─→ 1B-6 ─→ 1B-7 ─→ 1B-8 ─→ 1B-9 ─→ 1B-10
1B-12 (needs 1A-4, done in Phase 0) · 1B-13 (independent)

1C-1 ─┬→ 1C-2 ─┐
      ├→ 1C-3 ─┴→ 1C-4 ─→ 1C-5 ─→ 1C-6
      └→ 1C-9 ───────────┬→ 1C-10
                1C-4 ────┼→ 1C-7
                         └→ 1C-8
```

### 5.2 Critical path

**`1A-2` → `1A-1` → `1A-6b` → `1B-1` → `1B-2` → `1C-1` → `1C-2` → `1C-3` → `1C-4` → `1C-5` → `1C-6`** ≈ **24.75 of the 43.0 days**. Everything else has slack. Gate 1C is 80% critical path and cannot be compressed by reordering — only by cutting `1C-10` (§10 R-P4).

**The longest item is `1C-4 aerial-include` at 4.5 days.** It is also the largest visible payoff in the phase and every later atmosphere consumer depends on it. Do not start it on a Friday.

### 5.3 Week ledger (4.5 d/week)

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `1A-2` budget contract (2.0) · `1A-1` perf harness (2.5 of 3.0) | 4.50 |
| 2 | 4.5 → 9.0 | `1A-1` finish (0.5) · `1A-6b` governors (1.5) · `1A-5` csm-memory (0.5) → **Gate 1A closes, d7.0** · `1B-1` normals (1.25) · `1B-4` worker pool (0.5) | 8.75 |
| 3 | 9.0 → 13.5 | `1B-2` band-limit behaviour (2.0) · `1B-3` ladder (0.5) · `1B-5` remove-buildings (0.5) · `1B-6` exclusion mask (0.75) · `1B-7` start | 13.50 |
| 4 | 13.5 → 18.0 | `1B-7` density field finish · `1B-8` grid regression test (0.5) · `1B-9` blue-noise scatter (2.0) · `1B-10` start | 18.00 |
| 5 | 18.0 → 22.5 | `1B-10` detail worker offload finish · `1B-13` fp16 FFT (1.0) · `1B-11` MSAA + FOV (1.5) · `1B-12` start | 22.50 |
| 6 | 22.5 → 27.0 | `1B-12` basis reprojection finish → **Gate 1B closes, d23.0** · `1C-1` env-director (2.25) · `1C-9` clock UI (1.0) | 26.25 |
| 7 | 27.0 → 31.5 | `1C-2` single-exposure (1.5) · `1C-3` atmosphere LUTs (2.0) · `1C-4` start | 31.50 |
| 8 | 31.5 → 36.0 | `1C-4` aerial-include finish (d34.25) · `1C-5` physical-sky (2.0) | 36.25 |
| 9 | 36.0 → 40.5 | `1C-6` IBL (2.75) · `1C-7` water AP + curvature (1.0) · `1C-8` start | 40.50 |
| 10 | 40.5 → 43.0 | `1C-8` cloud radiometry finish · `1C-10` night-sky-basic (1.5) → **Phase 1 closes, d43.0** | 43.00 |

Two deliberate scheduling choices: `1B-13` and `1B-11` sit in week 5 as slack absorbers, because both are self-contained and can slip a week without blocking anything; and `1B-12` opens the week-5/6 boundary so that if it overruns it eats into `1C-1` rather than into the `1C-4` block.

---

## 6. Gate 1A — Truth and guardrails (7.0 d)

**Gate intent.** Nothing after this gate can be evaluated honestly without it. The renderer measures its own pass timings and throws them away (`FrameGraph.ts:127-134`), has no memory or frame budget, and — until `1A-6b` — walks resolution toward a floor in response to CPU-bound frames. Gate 1A makes the renderer *legible*.

**Already shipped in Phase 0:** `1A-4` (clouds no longer counter-rotate; edges translucent) and `1A-6a` (default target ≤ 1.5 Mpx, was 5.94 Mpx).

**Exit criteria.** `npm test` fails on a budget overspend. `npm run perf:capture` produces three committed baselines. The HUD reports `activeGovernor`, `gpuP95Ms`, `cpuP95Ms`, `renderPixels`.

---

### `1A-2` — `PerformanceBudget.ts` (2.0 d) · Class P · week 1

**Intent.** Make overspend fail a test instead of being discovered by the user. This is R5's fallback: *"none. Build it first."*

```ts
export interface SubsystemBudgetMs { readonly terrainRaster: number; /* one row per §5.4 */ }
export const FRAME_BUDGET_MS: Readonly<Record<Tier, SubsystemBudgetMs>>;
export const MEMORY_CEILING_MIB: Readonly<Record<Tier, number>>;
export function estimateGpuMemoryMiB(profile: WebGpuQualityProfile, viewport: Viewport): number;
export function assertWithinBudget(profile: WebGpuQualityProfile, viewport: Viewport): void;
```

`estimateGpuMemoryMiB` sums every allocation **from first principles** — shadow maps from `mapSize`/`numCascades`/format, ocean FFT working set from `oceanResolution`/`oceanCascades`, cloud history from `cloudResolutionScale` and the pixel cap, framebuffers from `maxRenderPixels`. Calibrate once against `scene.textures` byte totals plus `engine._bufferManager`, and pin a fudge factor with a comment recording the calibration date and machine.

**Class P obligations.** No Babylon import. Pure functions over the profile and a viewport. Tested in Node at three viewport sizes. Wire it into `npm test` as a per-tier × per-viewport assertion — **this is what makes every later phase's budget claim falsifiable.**

Also create `RenderInvariants.ts` here with its first two startup assertions (`1C-4` adds the rest): the engine's `enableGPUTimingMeasurements` state, and the capability set actually granted versus requested.

---

### `1A-1` — `perf-harness` (3.0 d) · Class P · weeks 1–2

**Intent.** Per-pass attribution and a screenshot baseline. The audit's closing paragraph identifies missing measurement as *the reason the regressions went unnoticed*.

**(a) Surface what exists (0.5 d).** `WebGpuFrameGraph.passTimings` is computed at `FrameGraph.ts:127-134` and never read. Ring-buffer it and expose p50/p95 per pass through `RenderDiagnostics`. Zero new measurement code.

**(b) Budget probe mode (1.0 d).** Babylon exposes only whole-frame GPU time. Rather than fork its timestamp plumbing, exploit `FrameGraphPass.enabled?: () => boolean` (`FrameGraph.ts:30`, already honoured at `:112`): cycle each pass off for 120 frames, record the `gpuP95` delta, attribute it. One sweep of 6–10 passes takes ~15 s and produces an honest per-pass GPU table. HUD-triggered, never during normal play.

**(c) `npm run perf:capture` (1.5 d).** Fixed seed, camera, weather and clock; DPR 1; 1280×720. Three shots — **500 ft AGL on approach**, **10 km slant range**, **10,000 ft looking down** — plus a numeric report (tile-wise mean/variance, small SSIM against the baseline, fps, frame time, draw calls, page-generation ms, estimated memory) as an artifact.

**Baseline discipline — decided now.** The baseline is committed **once, at the end of `1A-1`**. Phase 0's seed churn is already behind it. It is allowed to change at exactly four points in Phase 1, each of which must say so in its commit message: `1B-2`, `1B-3`, `1B-9`, and `1C-4`/`1C-5`/`1C-6` landing as one atmosphere rebaseline. **Any other baseline change is a regression until proven otherwise.**

**Counters to add now**, because they cost nothing at creation and are painful to retrofit: dispatches/frame, bytes uploaded/frame, workers busy, pages resident/pending, estimated vs actual GPU memory. The collision-fallback counter already exists from `0-5`.

---

### `1A-6b` — The two governors (1.5 d) · Class P · week 2

**Intent.** Kill the one-way ratchet. `worstFrameTimingPercentile95` (`QualityProfile.ts:164-175`) takes the **worst** p95 across frame-interval, CPU and GPU streams and feeds it to `nextDynamicRenderScale` (`:111-126`), which lowers `renderScale` — but `applyRenderScale` changes only the raster resolution, and every dominant cost is CPU-side. Resolution walks to the floor, the image gets soft, the frame rate does not recover. That is, mechanically, "the graphics have not improved and performance has taken a hit", in one function. **Delete it and its call site at `FlightRenderer.ts:910-937`.**

**Create `AdaptiveGovernor.ts`** — pure functions over sample arrays, no Babylon, fully unit-testable without a GPU.

- **Signals**, 120-frame windows: `gpuP95` from `engine.getGPUFrameTimeCounter()` requiring `timestamp-query` and ≥8 fresh samples (reuse `freshFrameTiming`, `QualityProfile.ts:139-149`, which is correct and stays); `cpuP95` from the existing `performance.now()` bracket; `intervalP95` present-to-present. When GPU timing is unavailable, synthesise `gpuProxy = max(0, intervalP95 − cpuP95)`; if `gpuProxy < 2 ms`, classify CPU-bound and **explicitly do not touch resolution** — today this case silently lowers it.
- **Arbiter.** `gpuBound` when `gpuP95 > cpuP95 × 1.15`; `cpuBound` when the reverse; else `balanced`. Exactly one governor actuates per window.
- **Governor A (resolution, GPU-bound only).** Target 13.7 ms. Down 0.05 above 1.10× target, up 0.025 below 0.80×. Asymmetric cooldown: 90 frames down, 240 up. **Floor raised 0.62 → 0.75.** **Anti-ratchet:** record `gpuP95` immediately before and after every downward step; if two consecutive downward steps each yield <4% improvement, restore the pre-step scale, latch `resolutionInsensitive`, hand control to Governor B, re-arm after 30 s or a profile change.
- **Governor B (CPU work, CPU-bound only).** Consumes `FrameGraph.passTimings` from `1A-1` so it knows which pass to cut. Ordered ladder, cheapest-looking damage first, one step per window, two-window hysteresis, recovers one step after 4 consecutive windows below 6 ms: terrain page requests 8→4→2 · detail cell budget 2.0→1.25→0.75 ms and cap 24→16→8 · planar reflection cadence 3→5→8 · cloud shadow cadence 2→3→4 · animal budget 128→48→16 · shadow caster distance 2.5→1.8→1.2 km · vegetation distance −25%. **It never touches resolution.**

**HUD** (`src/game/types.ts:68-99`, `src/ui/Hud.tsx`). Add `activeGovernor: 'gpu-resolution' | 'cpu-work' | 'balanced' | 'holding' | 'no-gpu-timing'`, `gpuP95Ms`, `cpuP95Ms`, `cpuWorkLevel` (index plus which lever moved last), `resolutionInsensitive`, `renderPixels`, `topPassesByCpuMs`. **The user must be able to see why the picture changed.** Update `tests/hud.ui.test.ts`.

**CI test (Node, no GPU).** A CPU-bound trace (`cpuP95` 22 ms, `gpuP95` 6 ms) leaves `renderScale` unchanged over 50 windows and moves `cpuWorkLevel`; a GPU-bound trace lowers resolution and stops after two ineffective steps. **This is the permanent guard against the ratchet returning.**

**Phase 0 outcome (2026-08-17).** `1A-6a` placed the absolute pixel cap inside `applyRenderScale`, which now **returns whether the effective hardware scaling level changed** and gates `invalidateHistory` on it. Use that signal here: when the cap is the binding constraint, `renderScale` steps are no-ops on the effective scale — feed the `resolutionInsensitive` latch from the return value instead of waiting for two ineffective-step p95 measurements. Current per-tier values (three-tier mapping): `maxRenderPixels` 1.0/1.5/2.4 Mpx, `maxDevicePixelRatio` 1/1.5/2; this item introduces the four-tier table with Ultra's 4.0 Mpx.

---

### `1A-5` — Depth-only shadow RTT (0.5 d) · Class T→P · week 2

**The number**, verified: `AtmosphereSystem.ts:196-201` constructs `new CascadedShadowGenerator(profile.shadowMapSize, this.sun, true, camera)` — the fifth parameter `useRedTextureType` is **not passed**, so Babylon selects an RGBA format; and `float32-filterable` is absent because `FlightRenderer.ts:319-320` requests only `timestamp-query` with `enableAllFeatures: false`, so it falls through to half-float. Net **RGBA16F**: 4096² × 4 cascades × 8 B = **512 MiB colour** plus 256 MiB depth = **768 MiB**. And `filter = ShadowGenerator.FILTER_PCF` (`:209`) binds **only the depth texture** — the 512 MiB colour attachment is allocated, cleared and written every frame and never sampled.

Depth-only RTT; also pass `usefullFloatFirst = false`.

**Explicitly not in scope:** the shadow *distance*. Shortening it to a near-field CSM is `4-8`, gated on the baked horizon maps from `4-7`. Doing it now leaves distant mountains unshadowed for months.

---

## 7. Gate 1B — Cheap correctness on the existing architecture (16.0 d)

**Gate intent.** Close audit root causes #3 (normals), #4 (band-limiting) and #10 (CPU serialisation), and fix the vegetation lattice and the villages.

**Exit criteria.** Page generation ≤ 9 ms at res 65. Band-limit RMS error vs a 12×12 box average < 0.25 × spacing at 32/64/128/256/512 m (today 3.05/7.11/16.10/35.44/60.23 m). Scatter spectrum test passes. Zero building prototypes over a 100 km² scan. Main-thread detail generation ≤ 0.3 ms/frame.

---

### `1B-1` — `normals-from-grid` (1.25 d) · Class K + T · week 2

**Intent.** The highest-leverage single change in the audit. `TERRAIN_NORMAL_SAMPLE_DISTANCE = 2` (`terrain.ts:18`) and `sampleTerrainNormal` (`:127-145`) use a 2 m central difference unconditionally, at every LOD, with no spacing parameter — and those normals are uploaded verbatim. Measured error: 7.3° mean at 8 m spacing, 20.8° at 32 m, **24–35° mean at 128 m with p90 above 56° and 3.4% of vertices exceeding 90°** — the normal points *into* the surface. No light rig can fix that, which is why every hour spent on sun angles has been spent lighting a surface that is not on screen.

1. **Halo generation.** Add `halo` to `TerrainTileOptions`; generate `(resolution + 2·halo)²`. **Import `coreToStoredIndex` and `storedEdge` from `world/pageGeometry.ts`** — Phase 0 `0-2` owns and tests the convention, including for negative tile indices, which `terrainTileVertexCoordinate` (`tile.ts:55-73`) already handles with careful exact-edge logic that must not break.
2. **Central-difference the grid** at the tile's own spacing; stop calling `sampleTerrainNormal` from the tile path.
3. **Recompute `slope` from the same normal.** `terrain.ts:299` computes `saturate(1 - target.normal.y)` from the 2 m normal, and `classifyBiome` branches on `slope > 0.48` and `> 0.28` (`:221-224`) — so rock and scree colour at 40 km is currently assigned by 4 m microslope. A genuine second bug fixed by the same change.
4. **Keep the analytic path for collision only** (`terrain.ts:178`), with a comment saying it must not be reintroduced into any render path. It now sits behind `src/sim/terrainGrid.ts` from `0-5`.
5. **`includeClimate: false`** at `TerrainClipmapSystem.ts:495` — no clipmap path reads `moisture` or `biomes`. Do *not* also disable colours; vertex colour is the only surface appearance terrain has until `3-2`.

**Result.** Page generation 40.6 ms → ~8 ms (the four extra full-kernel evaluations per vertex are 79% of generation cost), normals consistent with the rendered triangle at every LOD, band-limited to the tile's Nyquist for free.

**Test.** The angle between each vertex normal and its adjacent triangle's geometric normal, below a threshold that scales with spacing — the audit's own measurement, turned into a permanent assertion.

---

### `1B-4` — Terrain worker slot map (0.5 d) · Class T · week 2

`TerrainGenerationClient.ts:48` documents itself as *"One-worker, one-in-flight terrain scheduler"* and `:125` enforces it: `if (this.disposed || this.activeRequestId !== null) return;`. `generateTerrainTile` is a pure function of `(seed, tileX, tileZ, size, resolution)` with no shared state — embarrassingly parallel, and nothing exploits it.

Widen `activeRequestId: number | null` to `Map<workerIndex, requestId>`, hold `clamp(2, navigator.hardwareConcurrency - 4, 6)` workers (6 on the reference machine, leaving 4 for the main thread, the simulation worker, the hydrology worker and the browser), and keep the existing `BoundedTerrainQueue` as the dispatcher. Preserve the fallback path — it is the only thing keeping the sim alive when worker construction fails.

**No LRU cache.** The plan cuts it: the Phase 4 page atlas *is* the cache and `4-4` deletes this whole client. A 75 MB JS cache here is 3.5 days on code with a known deletion date.

**Note.** Page requests now flow through `WorldPageLifecycle` epochs from `0-3`, so the hand-rolled staleness check is already gone. The slot map only widens concurrency.

**Phase 0 outcome (2026-08-17).** The `request()` rejection contract changed during `0-3`'s review: rejection of the submitted request is signalled by `-1` alone (no re-entrant `onError`), while synchronous `onError` for an *evicted older* queued request remains. Keep both behaviours through the slot-map widening — `tests/render.webgpu-terrain-clipmap.test.ts`'s "real-client queue saturation" test locks the integration and must stay green unmodified.

---

### `1B-2` — Band-limiting, behaviour only (2.0 d) · Class K · week 3

**Intent.** Close audit root cause #4. Today `tile.ts:151` point-samples the full kernel identically for an 8 m grid and a 2048 m grid. The kernel carries real amplitude far below the coarse Nyquist, so **the coarse mesh is not a blurred version of the fine one — it sits on an arbitrary phase of the 43–160 m noise and is a genuinely different landscape**, re-rolled whenever a ring re-anchors. That is the horizon crawl, and it blocks geomorphing forever: `mix(fine, coarse, morph)` is meaningless until the two levels agree what the terrain is.

**Phase 0 `0-4` already threaded `filterWidthMeters` through all four entry points and every call site, landed the domain wrap, and clamped the `pow` bases. What remains is the behaviour.**

1. **In `fbm2D` and `ridgedFbm2D` (`noise.ts:46-92`)**, terminate the octave loop when `wavelength < 2 × filterWidth`, fading the last octave with `smoothstep(2·fw, 3.2·fw, wavelength)` so the cutoff is C1-continuous in spacing. A hard cutoff pops when a page changes level.
2. **The normalisation trap, which silently changes world scale.** Both functions divide by an `amplitudeSum` accumulated *in-loop* (`noise.ts:57, 67, 80, 91`). Terminate early and the sum is smaller and the result scales *up* — coarse terrain becomes systematically taller. **Divide by the untruncated sum**, computed from the full octave count.
3. **Apply the same fade to the single-octave calls** — `groundNoise` 105 m (`geology.ts:21`), `soilUndulation` 43 m (`:30-34`), `fractureVariation` 155/240 m (`:49-53`), `fine` 310 m (`terrain.ts:49`), the 18 km warp (`:36-38`) — each keyed on its own wavelength.
4. **Pass real spacing from the tile path.** `tile.ts` supplies `spacing` as the filter width; collision keeps `0`.

**Counter-intuitive and worth stating: this makes coarse pages cheaper.** A 512 m-spacing page drops from 34 noise evaluations per height to roughly 14.

**Physics safety.** The finest wavelength anywhere in the kernel is 43 m. L0 has 8 m spacing and L1 16 m, so the cutoff is a **no-op at L0 and L1**; divergence begins only at L2. Physics only matters within metres of the ground, always inside L0. `0-5`'s authority-agreement test already asserts this and now tightens to the 1 mm L0 bound.

**Tests.** Invariance `|h(x,z,0) − h(x,z,8)| < 1 mm` over 4,096 points. Band-limit acceptance: RMS vs a 12×12 box average < 0.25 × spacing at 32/64/128/256/512 m — bounds of 8/16/32/64/128 m against today's 3.05/7.11/16.10/35.44/60.23; generous, and still a several-fold improvement, because the goal is *phase agreement*, not zero error. No systematic bias: mean height over 100 km² at `filterWidth = 512` within 2 m of the same mean at `0` — the direct guard on the `amplitudeSum` trap.

**Baseline churn:** yes, by design.

---

### `1B-3` — LOD ladder and observer altitude (0.5 d) · Class T + P · week 3

**Class P — altitude.** `TerrainObserver` (`TerrainClipmapSystem.ts:66-71`) has `x`, `z` and velocity and **no altitude at all**, which is why 28.4% of triangles sit under the fuselage. Add `y`, populate it from `FlightRenderer.ts:815-820` (which already has `state.position.y`), and use 3D distance in page priority. **Note:** after `0-3`, priority flows through `WorldPageStreamingObserver` in `world/streamingPriority.ts` — extend that interface, which is the single owner, rather than adding a parallel altitude path. `4-5`'s CDLOD needs exactly this.

**Class T — the ladder.** Replace `tileResolution(profile, level)` (`:231-235`) with a `terrainTileResolution` field on `WebGpuQualityProfile`: 33 at tier 0, 65 at tiers 1–2, at every level. This kills the 4:1 T-junction at L2/L3, where the audit measured 28.1 m RMS / 192.4 m max skirt gaps against a 24 m skirt depth, and 8.4 → 41.0 m RMS chord-error jolts on every boundary crossing. Per A5, measure and consider constant 33.

**Do not** touch `TERRAIN_SKIRT_DEPTH_METERS`, `buildTerrainIndicesWithSkirt`, or `backFaceCulling` — the skirt perimeter loop emits one winding, so flipping culling makes half the walls disappear. That whole sequence is `4-5`.

**Phase 0 outcome (2026-08-17).** `TerrainClipmapSystem` is one of three grandfathered `profile.tier` readers in `0-1`'s boundary test, solely because of `tileResolution()`. Replacing it with the `terrainTileResolution` profile field is exactly what removes the file from that allowlist — do so in this item's commit, shrinking the grandfather list in `tests/architecture.boundaries.test.ts`.

---

### `1B-5` → `1B-6` — Remove buildings · detail exclusion mask (1.25 d) · week 3

**`1B-5` (0.5 d, Class D).** Delete outright, do not flag; `git` restores it, and dead-but-compiling code is what produced the orphaned `payload.ts`. Verified scope: `villageSuitability` (`detail/generation.ts:194`), the village/building generator (`:210-270`), the three village-exclusion checks (`:348`, `:494`, `:548`), `BuildingStyle`/`DetailBuildingPlacement`/`DetailVillage` in `detail/types.ts`, prototype construction in `WorldDetailRuntime.ts`, `detail/index.ts` re-exports, and two tests.

**`AirportSystem.ts` is untouched** — the hangars stay and are expanded in Phase 7. They are the only scale reference on final approach.

**`1B-6` (0.75 d, Class P) fixes a live bug:** nothing in `detail/` reads `airportInfluence`, so trees grow across the graded apron. Multiplicative, not boolean: airport influence × water proximity × clearance. And get the semantics right — **airfields are mown grass**. Suppress trees and rocks, cap grass height at ~0.15 m, and do *not* suppress grass; a bare dirt polygon around the runway is a different wrong answer.

---

### `1B-7` → `1B-9` — Density field · regression test · blue-noise scatter (5.0 d) · weeks 3–4

**`1B-7` (2.5 d).** One continuous density function, never a switch: lapse-rate elevation, moisture as a smoothstep, slope as a soil-retention proxy falling to zero by ~38° (the angle of repose), **aspect** (`dot(normalize(n.xz), sunwardXZ)`) giving conifers on cool north faces and open grass on warm south faces at ±25% density plus a species shift, a ragged treeline `base + aspect·120 + shelter·80 + fbm(p/2400)·90` with tree *height* scaled by the same factor so trees become 2 m krummholz before disappearing, and multiplicative glade and disturbance fields.

**Clumping expressed as a field has no centre and no radius, therefore nothing circular to see.** That is the precise answer to "no artificial clusters of trees" — and today's code has the opposite structure, with explicit cluster centres of radius 58–132 m on a 176 m lattice (`generation.ts:283-330`).

**Single owner:** `densityField.ts`, owned by vegetation, listed in Phase 0's manifest. Terrain-material *reads* it in Phase 6; it never reimplements it, and `0-1`'s boundary test enforces that.

**`1B-8` (0.5 d) lands before `1B-9`, not after.** A scatter test written after the scatter tests the scatter you wrote; written before, it tests the property you want. Assertions: no spectral peak outside DC and the intended 220/380 m ecological bands above 1.15× the local radial mean; a 16-bin phase histogram within [0.92, 1.08] of uniform for any candidate period 3–200 m; stems/ha in [300, 800] in closed forest. **Today's code measures 0.83–1.17 and must fail this test when it is first written** — if it passes, the test is wrong.

**`1B-9` (2.0 d).** A jitter grid whose cell size is a continuous function of local density, `clamp(sqrt(1/density), 3, 90)` m, plus a domain warp `p += 0.6·cell·vec2(noise(p/37), noise(p/37+91))` and O(n) rank-order thinning replacing the O(n²) all-pairs filter (~73k pair tests per cell today). Because the period varies continuously with a continuous field, **no constant period exists anywhere in the image**. 176 m is ~20× a crown diameter, hence glaring; a 3–8 m period in closed forest is under 1× a crown diameter, hence physically hidden. Placement stays a pure function of world position, so page boundaries can never be visible and the origin rebase at `FlightRenderer.ts:869-870` can never make anything slide.

Baseline churn: yes.

---

### `1B-10` — `detail-worker-offload` (1.5 d) · Class P · weeks 4–5

Detail-cell generation runs inline in `update()` at a measured **3.09 ms per 512 m cell against a 2 ms budget** (`WorldDetailRuntime.ts:324-356`) — the single largest contributor to the CPU p95 that drove the ratchet. It is pure and deterministic. Move it to `src/workers/detail.worker.ts`, reusing the request/response and bounded-priority shape of `TerrainGenerationClient` rather than inventing a third scheduler.

**Done when.** Main-thread detail generation ≤ 0.3 ms/frame in the numeric report, and Governor B's lever 2 has something real to move.

---

### `1B-13` — `ocean-fft-halfprecision` (1.0 d) · Class P · week 5

rgba32float → rgba16float ping-pong in `SpectralOceanSystem`. **Split the normalisation per axis** — fold `1/N` into the last stage of each axis. Moving the full `1/(N·N)` to the first pass makes intermediates 1.5e-6 … 1.5e-4, straddling fp16's smallest normal (6.1e-5), and **you silently lose the small waves and get banding on cascade 0**. Test both bounds on the largest cascade: upper < 60000 **and** lower > 1e-3.

---

### `1B-11` — MSAA and the FOV fix (1.5 d) · Class P · week 5

**MSAA.** `antialias: false` at `FlightRenderer.ts:323` and the post chain is hand-built at `:446-466`, not `DefaultRenderingPipeline`. Set `antialias: true` and request MSAA on the first post-process (`toneMap.samples`) because that chain forces an offscreen target; the multisample colour and depth attachment sample counts must agree, and the scene depth buffer is created by the first post-process's RTT. Keep FXAA only when `msaaSamples === 1`. 4× MSAA is genuinely cheap on Apple TBDR.

**Widen the check** to cover the ocean/hydrology `ShaderMaterial` passes now rasterising into a 4× target, and the cloud composite's pinned `z = w × 1e-7` under reversed-Z GEQUAL (`useReverseDepthBuffer = true` at `:341`). **Fallback:** `DefaultRenderingPipeline` with `samples = 4`.

Note honestly: alpha-to-coverage is off, so alpha-tested foliage gets **no** MSAA benefit. MSAA fixes ridge lines, runway edges and wing silhouettes, not tree canopies.

**FOV.** `camera.fov = 64 * π/180` at `:351` is *vertical* under Babylon's default `FOVMODE_VERTICAL_FIXED` — ≈96° horizontal at 16:9. Set `FOVMODE_HORIZONTAL_FIXED` at ~62°, and **change all three sites**: `:351`, `chaseCameraProfile` (`:139`), and the cockpit fallback (`:765-771`, currently **72°**). Cockpit must be **narrower** than chase; today it is wider, which is backwards. This also tightens the shadow cascades for free.

**Also here** (both absent repo-wide, both nearly free): `enableSpecularAntiAliasing = true` and `anisotropicFilteringLevel = 16` on the terrain material.

---

### `1B-12` — `basis-reprojection` (1.5 d) · Class P · weeks 5–6

Reproject the cloud temporal pass in camera-relative space using the previous frame's ray basis instead of a cached view-projection matrix, removing the stale-matrix class of bug by construction rather than by patch. `1A-4`'s `getViewMatrix(true)` fix, shipped in Phase 0, is the patch; this is the removal.

**The correction that must be spelled out or it will be implemented wrong:** the delta camera must be computed from **absolute world positions** across the floating-origin rebase, not from `camera.position`, which is local and jumps by up to `FLOATING_ORIGIN_GRID = 2048` m at `FlightRenderer.ts:869-870` — exactly the frames this item is meant to survive. The hook exists: `updateFloatingOrigin` sets `cameraCut` and calls `graph.invalidateHistory` at `:883-884`.

Pure-TS round-trip test in `CloudReprojection.ts` (ray → reproject → same uv), including across a synthetic 2048 m origin shift.

---

## 8. Gate 1C — The atmosphere spine (20.0 d)

**Gate intent.** Close audit root causes #5 (no aerial perspective) and #6 (no indirect light), and make time of day and season continuous rendering inputs. This gate is 80% critical path.

**Exit criteria.** `scene.environmentTexture` non-null and `REFLECTION` defined on the terrain effect. Startup assertions pass: `applyByPostProcess === true` and `scene.fogMode === FOGMODE_NONE`. No shader source in `src/` contains an exposure multiply. `camera.maxZ = 45_000`; `terrainRings` reduced by one per tier. Aerial-perspective opacity ≥ 95% at the outermost ring.

---

### `1C-1` — `env-director` (2.25 d) · Class P · week 6

`nature/EnvironmentState.ts` already defines the right structure — Rayleigh (5.802/13.558/33.1 e-6), Mie, ozone absorption, 120,000 lux, 0.004675 rad sun angular radius, planet radius, wind layers — and is **dead code referenced only by `tests/render.webgpu-nature.test.ts`**. Make it live.

**Solar position from the NOAA formula**, taking `dayOfYear` and `latitudeDegrees`. Both already exist from `0-6`, which is the 0.25 d saving. Declination swings ±23.44°, changing maximum sun elevation, day length, sunrise/sunset azimuth, and the length and direction of every shadow — seasonal sun path falls out of the formula's own signature.

**Delete `presetFor()`** (`AtmosphereSystem.ts:93-125`) in this commit. `setPreset(time, weather)` becomes `applyEnvironment(state)`.

**Careful with `sun.intensity`.** Today `setPreset` dims the sun via `preset.intensity * overcastDimming` (`:246`) while the sky shader applies its own `exposure` (`:73`) — two different curves. `1C-2` unifies them; `1C-1` must not fix it halfway or the two items will fight.

---

### `1C-9` — The clock UI (1.0 d) · Class P · week 6

Two continuous sliders plus named preset buttons that write them. `SettingsPanel.tsx:407-422` already has the Time-of-day and Weather selects; the time select becomes preset buttons over sliders. Weather stays a three-value select driving coverage, turbidity and wind; precipitation is explicitly not in scope.

**The schema, validation and `localStorage` migration are already done in `0-6`** — that is the 0.75 d saving. What remains is the UI and its wiring.

**Phase 0 outcome (2026-08-17).** `0-6` also shipped `TIME_OF_DAY_PRESET_CLOCKS` from `src/settings` — the exact `(dayOfYear, solarTimeHours)` pair per legacy label (all three on midsummer day 171 at the default 45°N). The preset buttons write these pairs verbatim; do not invent new ones.

`TimeOfDayPreset` survives as a **label**, not a rendering input. Nothing under `src/render/` may reference it afterwards; `0-1`'s boundary test enforces it.

---

### `1C-2` · `1C-3` — Single exposure · atmosphere LUTs (3.5 d) · week 7

**Exposure is currently applied on three or four independent curves:** `AtmosphereSystem.ts:73` (`color *= uniforms.exposure`), `FlightRenderer.ts:443` (`imageProcessingConfiguration.exposure = 1.08`), the ocean/hydrology shaders, and the cloud system's `/5.2` normaliser. The sky gets its own 0.82–1.02 *and* the camera's 1.08; terrain gets only 1.08 and is dimmed via `sun.intensity` instead — so at dawn, sky and ground sit on two different curves.

One relative-EV100: `exposure = 1.08 × 2^(EV100_ref − EV100)` so today's day+clear look is preserved **exactly**. That matters — it means this refactor is not supposed to change the baseline, which makes any change it does cause a detected bug. Replace `/5.2` with a named `sunIlluminanceNormalized`.

**LUTs:** Bruneton/Hillaire transmittance 256×64 and multiple-scattering 32×32, rgba16f, on environment change only. 138 KiB total. **Plus a TypeScript mirror `evaluateTransmittance()` with a 1% agreement test** — not redundant: the CPU path is needed by exposure and by the IBL spherical-harmonics bake, and it is the only thing that makes atmosphere correctness testable in Node.

**CI assertion (permanent):** no shader source under `src/` contains an exposure multiply.

---

### `1C-4` — **`aerial-include`** (4.5 d) · Class P · weeks 7–8

**The single biggest change in Phase 1**, and the one that most directly closes the "no sense of scale" complaint.

**Today.** The entire atmospheric term is three lines (`AtmosphereSystem.ts:265-267`): `FOGMODE_EXP2`, one density, one `Color3`, evaluated as `exp(-(d·ρ)²)` on eye distance only. Three defects follow. **No height falloff** — at 30,000 ft the ground 10 km below is 16% washed out by a sea-level-density haze that physically is not there, and looking down is the view you spend most of a flight in. **No view-direction dependence** — one `Color3`, so at dawn distant terrain fades to orange even looking 180° away from the sun, where the sky behind it is the dark blue zenith; terrain and sky fade to *different colours* at the horizon. And it is **5× weaker than the pre-migration build**, which used linear fog saturating at 11.8 km. Water and clouds receive **none** of it, because Babylon's `ShaderMaterial` has no fog path at all — the ocean draws to 120 km fully saturated with sun glitter while terrain at 120 km is 100% fog colour, with a hard tear at every coastline past ~10 km.

**Analytic, not a froxel volume.** Three reasons specific to this renderer: a froxel volume is built from one camera's frustum and this renderer needs haze on three cameras — main, planar reflection, six IBL faces; 32 depth slices over 45 km are 1.4 km thick, unusable near the camera without depth linearisation against a reversed-Z buffer this codebase does not expose; and Apple Silicon has abundant ALU and constrained bandwidth, so ~60 ALU + 2 LUT fetches is the cheaper resource.

**The integral, in closed form.** For a ray of length `d` from camera altitude `h₀` to fragment altitude `h₁`, optical depth per exponential species is exactly `τ = σ·H/sinθ · (exp(−h₀/H) − exp(−h₁/H))`, with the `sinθ → 0` limit `d·exp(−h₀/H)`; `H` = 8000 m (Rayleigh), 1200 m (Mie); ozone via the standard tent, integrated in closed form. In-scatter uses the **same** Rayleigh `3/(16π)(1+μ²)` and Henyey-Greenstein phase functions the sky shader already contains at `AtmosphereSystem.ts:50-68` — **so haze and sky agree by construction, not by tuning.**

**Two guards, both load-bearing, both asserted at startup in `RenderInvariants.ts`.** The hook is `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`, immediately after `pbrBlockImageProcessing`, which under `IMAGEPROCESSINGPOSTPROCESS` is only a clamp — so `finalColor` is linear HDR there. That depends on `applyByPostProcess === true`. And `#include<fogFragment>` runs just before, so `scene.fogMode` must be `FOGMODE_NONE` or fog and aerial perspective both apply. Set `mesh.applyFog = false` on terrain once the plugin owns it.

**Every consumer, in this item.** Terrain via the plugin hook; ocean at `SpectralOceanSystem.ts:421`; rivers and lakes at `HydrologySystem.ts:539` and `:258`; vegetation, wildlife, aircraft and airport via `AerialPerspectiveRegistry` **built on `SharedReceiverRegistry` from `0-7`** (the 0.5 d saving, and the reason there is one plumbing pattern in the renderer rather than three); the cloud composite via `applyAerialPerspectiveAtDistance`. **Nobody re-derives it** — `0-1`'s single-definition-site test enforces that.

**Then reduce the view distance, and the cost is negative.** `camera.maxZ` 120,000 → 45,000 (`FlightRenderer.ts:350`) and `terrainRings` down one per tier (currently 6/7/8). Beyond 45 km analytic transmittance is under 5%, and levels 5–7 are ~16% of all terrain triangles for zero visible contribution. **Reconcile the ocean radius to 40 km in the same commit** — a 120 km disk inside a 45 km far plane is clipped and the horizon vanishes.

**Tests.** TS/WGSL agreement to 1% over a grid of (altitude, distance, view-sun angle); transmittance monotonic in distance; the two startup assertions; terrain-ring coverage vs `camera.maxZ` and AP opacity ≥ 95% at the outermost ring — which also pins `README.md`'s currently-false coverage claims. Shader compile assertion via `npm run test:gpu` from `0-8`.

**Baseline churn:** yes, large. Land `1C-4`, `1C-5` and `1C-6` and rebaseline **once**, after `1C-6`.

---

### `1C-5` — `physical-sky` (2.0 d) · Class P · week 8

Replace the sky fragment shader's three-colour `mix()` (`AtmosphereSystem.ts:66`) with `skyRadiance()` from the same include, plus a real sun disc with limb darkening at the true 0.004675 rad angular radius `EnvironmentState.ts` already carries. Terrain haze and sky then agree because they are literally the same integral.

Also fixes a documentation lie: `README.md:60` and `docs/PERFORMANCE.md:41` claim "Rayleigh/Mie-style scattering" for what is currently a three-colour `mix`. After this the claim is true; `6-12` pins it with a test.

---

### `1C-6` — `ibl` (2.75 d) · Class P · week 9

**Today.** `scene.environmentTexture` is never set — zero grep hits for `environmentTexture|HDRCubeTexture|CubeTexture|createDefaultEnvironment|reflectionTexture` across `src/`. Babylon's `_getReflectionTexture()` falls back to null → `REFLECTION = false`, and both `finalIrradiance` and `finalRadianceScaled` are compiled out, so `environmentIntensity = 0.64` (`TerrainClipmapSystem.ts:278`), `0.7` (`WorldDetailRuntime.ts:1105`) and `0.62` (`AirportSystem.ts:111`) are **dead uniforms**. The entire indirect budget is one unshadowed `HemisphericLight` contributing 0.203 against direct 4.657 — **4.4% of the light budget**, where clear-midday diffuse-horizontal irradiance is 10–15%. And it is not shadowed by the CSM, so on a shadowed or north-facing slope it is the *only* light.

**Diffuse.** A TypeScript mirror of `skyRadiance()` evaluated over a 16×16×6 cube of directions → `CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial`. A pure array API — microseconds, testable in Node, no GPU readback.

**Specular.** A 128 px `isCube` RTT, `TEXTURETYPE_HALF_FLOAT`, `gammaSpace = false`, mipped, `CUBIC_MODE`, one face per frame. Assign **before** `scene.whenReadyAsync()` (`FlightRenderer.ts:468-473`) so the `REFLECTION` variant compiles during startup rather than stalling frame one.

**Three things in the same commit or the result looks like a regression:**
1. Raise `specularIntensity` 0.22 → 1.0 and `environmentIntensity` → 1.0 in **all three files together**. The 0.22 was compensating for missing IBL and will look wrong once IBL exists.
2. Retire the `HemisphericLight` (`AtmosphereSystem.ts:192-194`), or drop it to ~0.05 as a ground-bounce term, so skylight is not double-counted.
3. Validate SH irradiance against the analytic reference: a uniform sky of radiance L must give irradiance πL.

Consumes `SharedReceiverRegistry` from `0-7`.

**Sequencing the audit is emphatic about: IBL before AO.** Multiplying a 4.4% ambient term by an occlusion factor is invisible. GTAO added first would produce no perceptible change, and you would reasonably conclude AO doesn't matter — exactly the pattern that has already caused frustration. AO is `4-7`.

---

### `1C-7` · `1C-8` · `1C-10` — Water · clouds · placeholder night (4.0 d) · weeks 9–10

**`1C-7` (1.0 d).** Ocean and inland water consume the include. Add curvature: `displaced.y -= dot(localXZ, localXZ) / (2 × 6371000)` before the world transform — without it the flat disk's vanishing line sits at eye level and the sea looks like a plate. Ocean presentation radius 120 km → 40 km, already reconciled with `camera.maxZ` in `1C-4`.

**`1C-8` (1.5 d).** Clouds consume the include via `applyAerialPerspectiveAtDistance` and lose their private exposure normaliser to `1C-2`'s single curve. Cloud shadow strength is multiplied by the fragment's aerial-perspective transmittance so distant terrain is not double-darkened by shadows it should be too hazy to show.

**`1C-10` (1.5 d) is deliberately minimal**, and the plan says so twice. Sun below the horizon handled without breaking, a twilight-through-night exposure range, a placeholder moon disc and star dome. It exists **only** so that scrubbing the clock past dusk during Phases 1–6 looks *unfinished* rather than *broken*. **Do not gold-plate it** — Phase 7 (`7-1`, `7-2`, `7-3`) replaces the moon and stars outright with ephemeris positioning, phase, moonlight as a second directional light, scotopic vision and the Yale Bright Star catalogue. **This is the phase's designated cut item** (§10 R-P4).

---

## 9. Verification

### 9.1 The three test surfaces

| Surface | Runs where | Runs when | Contents |
|---|---|---|---|
| **Node unit** (`npm test`) | `environment: "node"`, no GPU | Every commit, in `npm run verify` | Budget arithmetic · governor state machines · band-limit RMS · height invariance under filter width · scatter spectrum · SH irradiance = πL · reprojection round-trip · transmittance mirror · grep assertions — plus everything Phase 0 added |
| **GPU** (`npm run test:gpu`) | Headless Chromium, from `0-8` | Explicitly, and at every gate boundary | WGSL compile assertions for every registered include · adapter capability probes · (Phase 4) CPU/GPU kernel parity |
| **Screenshot** (`npm run perf:capture`) | Local, real GPU | Gate boundaries, and before any baseline-churning merge | Three fixed shots + a numeric report: fps, frame time, draw calls, page-generation ms, estimated memory |

### 9.2 Phase 1 CI assertions, in creation order

Phase 0 contributed 18 assertions already — the ownership boundaries, page addressing, kernel portability, and the four physics invariants. Phase 1 adds:

| # | Assertion | By | Guards against |
|---|---|---|---|
| 19 | `estimateGpuMemoryMiB(tier) ≤ MEMORY_CEILING_MIB[tier]` at 3 viewports | `1A-2` | Memory overshoot |
| 20 | `Σ` per-subsystem ms `≤ FRAME_BUDGET_MS[tier]` | `1A-2` | Frame overshoot |
| 21 | Governor state machine on synthetic CPU- and GPU-bound traces | `1A-6b` | **The ratchet returning** |
| 22 | Vertex normal vs adjacent-triangle geometric normal, per spacing | `1B-1` | The 24–35° shading error returning |
| 23 | `\|h(x,z,0) − h(x,z,8)\| < 1 mm` over 4,096 points | `1B-2` | **Physics/render divergence** (tightens `0-5`'s agreement test) |
| 24 | Band-limit RMS vs a 12×12 box average at 32…512 m | `1B-2` | Horizon crawl |
| 25 | Mean height invariant under filter width | `1B-2` | The `amplitudeSum` normalisation trap |
| 26 | Zero building prototypes over a 100 km² scan | `1B-5` | Villages returning |
| 27 | Scatter spectrum + phase histogram + stems/ha | `1B-8` | **The tree lattice returning** |
| 28 | fp16 FFT intermediates: upper < 60000 **and** lower > 1e-3 | `1B-13` | Silent underflow banding |
| 29 | No `src/` shader source contains an exposure multiply | `1C-2` | Triple exposure returning |
| 30 | Nothing under `src/render/` references `TimeOfDayPreset` | `1C-9` | Two sources of environmental truth |
| 31 | TS/WGSL aerial-perspective agreement within 1% | `1C-4` | Sky and haze drifting apart |
| 32 | `applyByPostProcess === true` and `fogMode === FOGMODE_NONE` at startup | `1C-4` | Haze on a non-linear buffer, or double haze |
| 33 | Ring coverage vs `camera.maxZ`; AP opacity ≥ 95% at the outer ring | `1C-4` | `README.md`'s false coverage claims |
| 34 | SH irradiance for a uniform sky of radiance L equals πL | `1C-6` | A silently wrong IBL |

### 9.3 Baseline churn policy

The screenshot baseline is committed once, at the end of `1A-1`. Phase 0's seed churn is already behind it. It may change at exactly four points in Phase 1, each naming the reason in the commit subject:

1. `1B-2` — band-limiting changes coarse terrain by design.
2. `1B-3` — the ladder changes far-field geometry.
3. `1B-9` — scatter changes every tree position.
4. `1C-6` — the atmosphere spine (`1C-4` + `1C-5` + `1C-6`) rebaselines **once**, after IBL, not three times.

**Any other baseline change is a regression until proven otherwise.** Backend choice is not a quality lever; a screenshot is.

---

## 10. Phase 1 risk register

Two risks from the previous edition — the plugin spike and the test harness — now resolve in Phase 0 (R-0A, and `0-8`) and are gone from this list. Phase 1 no longer starts with an unvalidated architectural premise.

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-P2** | **`1C-4` overruns.** Largest estimate in the phase, four consumer integrations. | End of week 8 with the terrain consumer not correct. | Ship terrain + ocean first as a gate-internal commit; rivers, vegetation and the cloud composite follow within the week. **Do not ship a version where the ocean lacks haze** — that reintroduces the coastline tear, which is more visible than no change at all. |
| **R-P3** | **MSAA mechanics through the hand-built post chain.** Multisample colour and depth sample counts must agree; the scene depth buffer is created by the first post-process's RTT. | Validation errors or a black frame when `toneMap.samples` is set. | `DefaultRenderingPipeline` with `samples = 4`. Budget half a day; do not spend two fighting the hand-built chain. |
| **R-P4** | **Phase 1 overruns 9.6 weeks.** | End of week 8 behind by more than 3 days. | Cut `1C-10` (1.5 d) — placeholder work Phase 7 deletes, whose only function is cosmetic during Phases 2–6. Second cut: `1B-13` (1.0 d), a memory optimisation with no visual payoff and no Phase 1 dependants. **Do not cut `1A-1`, `1A-2` or `1A-6b`** — the whole phase's evaluability rests on them. |
| **R-P5** | **`1B-2` breaks `sim.flight.test.ts`.** It changes the physics authority's arithmetic. | An envelope assertion fails or becomes marginal. | Much smaller than before Phase 0: the signature churn and hash change already landed at `0-4` and were validated separately, so a failure here isolates cleanly to the octave cutoff. Treat as information about the test's tolerance, not a reason to revert. **Never** re-baseline `sim.flight.test.ts` in the same commit as a rendering change. |
| **R-P6** | **`1B-3`'s constant-65 ladder blows the raster budget.** | Terrain raster above its budget row in the numeric report. | Switch tiers 1–2 to constant 33 per A5. Audit §2.3's corollary says the visual cost is near zero because there is no geometric content below 43 m. Record the measurement. |
| **R-P8** | **Governor B has weak levers** until `1B-10` lands. | Weeks 2–5. | Accept it. The governor reports honestly and acts weakly, which is strictly better than today's behaviour of acting confidently and wrongly. Surface it in the HUD with the lever index. |
| **R-P9** | **Phase 0's `world/` adoption destabilises terrain streaming**, and it surfaces during Phase 1 rather than Phase 0. | Pages arriving late or in the wrong order during `1B-3`/`1B-4`. | The streaming-priority options are data (`DEFAULT_WORLD_PAGE_STREAMING_PRIORITY_OPTIONS`) and were tuned in `0-3` with the measurement recorded. Re-tune against the `1A-1` numeric report rather than reverting to distance-plus-level ordering. |

---

## 11. Exit checklist

**Gate 1A**
- [x] `npm test` fails on a synthetic budget overspend.
- [x] `npm run perf:capture` produces three committed baselines and a numeric report.
- [x] HUD reports `activeGovernor`, `gpuP95Ms`, `cpuP95Ms`, `cpuWorkLevel`, `renderPixels`, `resolutionInsensitive`.
- [x] A synthetic CPU-bound trace leaves `renderScale` unchanged over 50 windows.
- [x] Shadow RTT is depth-only; estimated GPU memory at tier 2 drops ~500 MiB.

**Gate 1B**
- [x] Page generation ≤ 9 ms at resolution 65 (was 40.6 ms).
- [x] Vertex-normal angular error test passes at every spacing.
- [x] `|h(x,z,0) − h(x,z,8)| < 1 mm` over 4,096 points.
- [x] Band-limit RMS < 0.25 × spacing at 32/64/128/256/512 m.
- [x] Terrain generation runs on ≥ 2 workers with more than one request in flight.
- [x] No 4:1 ground-sample-distance step between adjacent levels; the observer carries altitude and priority uses 3D distance.
- [x] Zero building prototypes over a 100 km² scan; hangars still present.
- [x] No trees or rocks on the graded apron; grass present and capped at ~0.15 m.
- [x] Scatter spectrum, phase histogram and stems/ha assertions pass.
- [x] Main-thread detail generation ≤ 0.3 ms/frame.
- [x] MSAA active; FOV horizontal-fixed at ~62°; cockpit narrower than chase.
- [x] fp16 FFT bounds test passes on the largest cascade.
- [x] Cloud reprojection survives a synthetic 2048 m origin shift.

**Gate 1C**
- [x] `presetFor()` deleted; nothing under `src/render/` references `TimeOfDayPreset`.
- [x] Two continuous sliders scrub time of day and day of year; the sun moves correctly for both.
- [x] No shader source under `src/` contains an exposure multiply.
- [x] TS/WGSL aerial-perspective agreement within 1%.
- [x] Terrain, ocean, rivers, vegetation, wildlife, aircraft, airport and the cloud composite all consume the same include, through the one registry. Nothing re-derives haze.
- [x] `camera.maxZ = 45_000`; ocean radius 40 km; terrain rings 6/7/7/7 (see §13 D-3 — one-per-tier would end terrain inside the far plane); AP luminance opacity ≥ 95% at the far plane, pinned per tier.
- [x] Startup assertions pass: `applyByPostProcess` true, `fogMode` NONE.
- [x] `scene.environmentTexture` non-null; `REFLECTION` defined on the terrain effect; `HemisphericLight` retired; `specularIntensity` 1.0 in all three files.
- [x] SH irradiance for a uniform sky of radiance L equals πL.
- [x] Scrubbing past dusk does not break the image.

**Phase**
- [x] Audit root causes **#3, #4, #5, #6, #10, #11, #12** are closed. (#1, #2, #7, #8, #9 remain, by design — Phases 3, 5, 4, 5, 5.)
- [x] `npm run verify` green; `npm run test:gpu` green; baseline churned at the sanctioned points plus the verified `1B-11` FOV reframing (§13 D-8).
- [x] The decision log has an entry for every amendment and every measured choice.
- [x] Phase 0's boundary test still passes — no Phase 1 item introduced a second definition of an owned artefact.

---

## 12. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| 2026-08-17 | `1B-3` | Ladder: constant 65 at tiers 1–3, 33 at tier 0. | Terrain page generation p95 7.2–7.5 ms vs the 9 ms budget (M-series, `perf:capture` report.json). Constant per-tier resolution keeps every adjacent-level GSD ratio exactly 2:1. |
| 2026-08-17 | `1B-11` | MSAA via `toneMap.samples`. | The first post-process already owns the offscreen beauty target; tier 2 runs 2× because assertion 19 measured 734 MiB > 700 MiB with 4× alongside the full-distance 4096² CSM. |
| 2026-08-17 | `1C-2` | `REFERENCE_EV100 = 15.27` (E_ref at the old day preset's sun height, sin 0.82). | Day+clear exposure ratio is exactly 1, so the look is preserved; k = 0.12, clamp [0.3, 2.6]. |
| 2026-08-17 | `1C-4` | `mieTurbidityMultiplier = 1 + humidity·26` (clear 12.7×). | Physical constants give ~44% transmittance at 45 km; the ≥95%-opacity exit criterion requires turbid Mie. Measured: luminance T(45 km) ≈ 4.6%, T(10 km) ≥ 40%. |
| 2026-08-17 | `1C-4` | `terrainRings` 6/7/7/7 (see §13 deviation D-3). | Guaranteed coverage is 512·2^rings m; only level 7 sits wholly beyond the 45 km far plane. |
| 2026-08-17 | `1C-6` | Probe re-renders per environment change, not one face per frame (§13 D-6). | Six 128 px draws of a ~100-ALU shader per scrub step beat a six-frame-stale probe. |

*(Phase 0's decision log carries the `0-9` spike outcome, the `0-8` harness choice, the `0-3` streaming-priority tuning, and the `0-6` settings migration mapping. The full measured-choice log, including `1A-5`, `1B-9`, `1B-13`, `1C-3` and `1C-8`, lives in ARCHITECTURE.md's decision log — the normative copy.)*

---

## 13. Deviations from this plan, as implemented

Recorded per the working agreement: follow the intent, log every departure.

- **D-1 (`1A-5`)** — The item's premise was stale: Babylon 9.21.2's CSM already defaults `useRedTextureType = true`. True depth-only shipped instead via a `noColorAttachment` RTT override (`DepthOnlyCascadedShadowGenerator`), proven on-adapter.
- **D-2 (`1B-7`/`1B-9`)** — The ecological density field is unrenderable as raw instances (~39 M triangles). The field stays authored and tested; the renderer applies selection-keyed rendered-share thinning. The scatter's domain warp was deleted outright — its own lattice re-introduced a 37 m spectral line — replaced by bilinear density interpolation over stratified full-cell jitter.
- **D-3 (`1C-4`)** — `terrainRings` went 6/7/8/8 → 6/7/7/7, not one-per-tier: worst-case guaranteed coverage is `512·2^rings` m, so the plan's cut would end terrain *inside* the 45 km far plane on the lower tiers (its ~16% triangle estimate was computed against the 120 km baseline with an average-case coverage model). Only level 7 is wholly beyond the new far plane.
- **D-4 (`1C-4`)** — "~60 ALU + 2 LUT fetches" became ~60 ALU + 0 fetches: sun transmittance rides as a per-frame uniform evaluated at camera altitude by the shared CPU model. The LUTs still exist (CPU-side truth for exposure, IBL and tests); no consumer binds a sampler for haze.
- **D-5 (`1C-4`)** — Turbidity: the plan's "physical constants" claim fails its own ≥95%-opacity criterion (textbook coefficients leave ~44% transmittance at 45 km). `mieTurbidityMultiplier = 1 + humidity·26` expresses the required turbidity once, tested, instead of smuggling it into the coefficients.
- **D-6 (`1C-6`)** — The specular probe re-renders all six faces once per environment change (or >500 m altitude drift) instead of one face per frame; the sun is static between scrubs. Diffuse SH additionally applies a below-horizon ground-bounce attenuation (floor 0.25): the sky field's lower hemisphere is the bright clamped horizon haze, and an unattenuated bake lights undersides more than tops.
- **D-7 (`1C-8`)** — The `strength × transmittance` term is unnecessary: every consumer applies aerial perspective multiplicatively *after* shadowing, so shadows fade with the fragment's transmittance structurally. Recorded here so nobody adds the term twice.
- **D-8 (§9.3)** — The sanctioned atmosphere rebaseline was taken once after `1C-8`/`1C-10` rather than literally after `1C-6`: the plan schedules pixel-visible water/cloud work after its own rebaseline point, and "once" is the load-bearing word. One additional unsanctioned-point rebaseline occurred at `1B-11`: the FOV reframe (64° vertical → 62° horizontal) legitimately changes every pixel; SSIM 0.56 was verified as reframing, not regression, before rebaselining.
- **D-10 (`1A-1`, found at phase close)** — Two determinism bugs in the capture pipeline surfaced once the aerial perspective raised scene contrast: accumulated `simulationTime` crossed run-dependent streaming loops (wave/cloud phase varied per run), and the propeller phase accumulated per rendered frame (the cockpit down-shot flickered blades in and out at SSIM 0.970 vs 0.985+, bimodally). Fixed by pinning the settle's simulation time per shot and anchoring propeller rotation to `state.simulationTime` (visually identical at blur speeds); three consecutive captures now reproduce the baseline. The accompanying rebaseline is part of D-8's single sanctioned point.
- **D-9 (`1C-1`/`1C-5`)** — `applyEnvironment` dropped its `WeatherPreset` parameter (weather is read from the state's continuous fields), and the old palette-mix sky uniforms were deleted with the shader; the palette persists only for the light rig and the snapshot until Phases 3/7 retire it.

---

## Appendix A — File manifest

**New (10):** `core/PerformanceBudget.ts` · `core/AdaptiveGovernor.ts` · `core/RenderInvariants.ts` · `nature/EnvironmentDirector.ts` · `atmosphere/AtmosphereLuts.ts` · `atmosphere/AerialPerspective.ts` · `atmosphere/SkyEnvironmentProbe.ts` · `clouds/CloudReprojection.ts` · `workers/detail.worker.ts` · `scripts/perf-capture.mts`.

**Substantially modified (13):** `FlightRenderer.ts` (governors, FOV, MSAA, `maxZ`, observer altitude) · `core/QualityProfile.ts` (`terrainTileResolution`; `worstFrameTimingPercentile95` deleted) · `core/FrameGraph.ts` (timings surfaced) · `atmosphere/AtmosphereSystem.ts` (`presetFor` deleted, sky rewritten, CSM depth-only, `HemisphericLight` retired) · `clouds/VolumetricCloudSystem.ts` (reprojection, radiometry) · `terrain/TerrainClipmapSystem.ts` (resolution field, `includeClimate`, `specularIntensity`, AP consumer) · `terrain/TerrainMaterialPlugin.ts` (AP hook) · `water/SpectralOceanSystem.ts` (fp16, AP, curvature, radius) · `water/HydrologySystem.ts` (AP) · `detail/WorldDetailRuntime.ts` · `detail/generation.ts` · `src/world/{terrain,geology,noise,tile,types}.ts` · `src/ui/{Hud,SettingsPanel}.tsx` · `src/game/types.ts`.

**Deleted:** village/building generation and its types · `presetFor()` · `worstFrameTimingPercentile95` · the cluster-lattice scatter.

**Explicitly untouched in Phase 1:** `AirportSystem.ts` geometry (Phase 7) · `TERRAIN_SKIRT_DEPTH_METERS` and the index builder (`4-5`) · `backFaceCulling` on terrain (`4-5`) · shadow *distance* (`4-8`) · the CPU tile `colors` buffer width (§2) · everything Phase 0 owns.

## Appendix B — Audit root causes and where they close

| # | Root cause | Closes in | Item |
|---|---|---|---|
| 1 | No surface material system | Phase 3 | — |
| 2 | Pointwise analytic height → erosion impossible | Phase 5 | — |
| 3 | Fixed 2 m shading normals at every LOD | **Phase 1** | `1B-1` |
| 4 | No band-limiting | **Phase 1** | `1B-2` (with `0-4`) |
| 5 | No aerial perspective | **Phase 1** | `1C-4`, `1C-7`, `1C-8` |
| 6 | No indirect light | **Phase 1** | `1C-6` |
| 7 | No screen-space-error LOD, no geomorphing | Phase 4 | `1B-3` (partial, interim) |
| 8 | No geometry below 43 m | Phase 5 | — |
| 9 | No macro-geology; global 35° fabric | Phase 5 | — |
| 10 | CPU: 181 evals/vertex, one worker | **Phase 1** | `1B-1`, `1B-4`, `1B-10` |
| 11 | Governor responds to CPU-bound frames | **Phase 1** | `1A-6a` (Phase 0), `1A-6b` |
| 12 | 64° vertical FOV ≈ 96° horizontal | **Phase 1** | `1B-11` |

Seven of twelve close in Phase 1. It is 43.0 days on top of Phase 0's 16.8, and it will not look like that much work — it will look like a different renderer.
