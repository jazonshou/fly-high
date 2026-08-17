# Phase 0 Execution Plan — The Architectural Shift

**Status:** execution reference for `RENDERING_PLAN.md` §1, scheduled **before** Phase 1.
**Basis:** `TERRAIN_AUDIT.md` (root causes, treated as established fact) and `RENDERING_PLAN.md` §1.1–§1.6 (today-vs-after, what moves to the GPU, the physics consistency contract, single owners, resolved user decisions, season and time of day).
**Verified against:** working tree at `58d5d15`. Every file, line and dead-code claim below was re-checked in the current tree.
**Effort:** **15.5 architecture days**, plus 1.3 days of Phase 1 work executed out of order on day one (§0.3). **16.8 days elapsed, ~3.7 weeks** at 4.5 productive days/week.
**Consequence:** Phase 1 drops from 49.6 d to **43.0 d**. Combined Phase 0 + Phase 1 is **59.8 d ≈ 13.3 weeks**, against 49.6 d ≈ 11.0 weeks for Phase 1 alone. **Net cost ≈ +10 days.** Program total ≈ **288 days**.
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

---

## 0. What this phase is, and what it is not

### 0.1 The premise

`RENDERING_PLAN.md` §1 is titled "Architecture shift" and is written as a set of decisions: a today-vs-after table, an inventory of what moves to the GPU, a physics/render consistency contract, a single-owner table, and the season/clock threading rule. Those decisions are currently **prose**. Phases 1–7 are expected to honour them by everyone remembering to.

Phase 0 converts them into **code, constants, types and tests that fail when violated**.

That is not a stylistic preference. It is the direct response to the audit's sharpest institutional finding, which is not about pixels at all:

> **Your team specified the correct architecture and then shipped a parallel ad-hoc path with none of its properties.**

That sentence is about `src/render/webgpu/world/` — 1,129 lines specifying page identity, a page-payload schema with a seam-safe gutter, an eight-state residency lifecycle with epoch-based stale-result rejection, flight-corridor streaming priority, and cache eviction ordering with compatibility checks. It is complete, it is good, and it is **imported by exactly two test files and nothing else**. Meanwhile `TerrainClipmapSystem` hand-rolls a worse version of every one of those five things.

The same pattern produced the other regressions the audit names. Nothing enforced that the detail texture survived a migration. Nothing enforced that AO survived. Nothing enforced that the budget system survived. Reading the project's own documentation does not reveal that they were dropped.

**Phase 0's product is enforcement.** Its risk is that it produces zero visible change — exactly the failure mode of commit `5ef9a0f`, which added 20,452 lines and improved nothing. §7 gives it a hard time-box and a cut line for that reason.

### 0.2 Scope rule

Every Phase 0 item must satisfy **both** tests:

1. **It is architecture** — a contract, an ownership boundary, an invariant, a shared type, a canonical constant, or the validation of an architectural premise. Not subsystem implementation.
2. **It is cheaper now than later**, or it prevents a later re-architecture.

Anything that fails either test stays in the phase that owns it. Concretely, and these were all considered and rejected for Phase 0:

| Rejected from Phase 0 | Why |
|---|---|
| `PerformanceBudget.ts` and `AdaptiveGovernor.ts` implementations | Real behaviour with real tuning. Phase 0 records the *ownership* (§1.4 row 7); `1A-2` and `1A-6b` build them. Moving them here would be relabelling, not architecture. |
| The aerial-perspective WGSL include | Phase 1 `1C-4`. Phase 0 lands only the shared-consumer plumbing every such include needs (`0-7`). |
| The page atlas, CDLOD, erosion | Phases 4–5. Phase 0 pins the constants and addressing they will use (`0-2`), nothing more. |
| A CPU→GPU height port | Phase 4 `4-1`. Phase 0 makes the kernel *portable* (`0-4`); it does not port it. |
| Widening the CPU tile colour buffer, or any tile-path generalisation | The path is deleted at `4-4`. Investing in it is waste wearing foundation's clothes. |
| A land-cover classifier signature carrying `dayOfYear` | There is no classifier worth threading yet — `classifyBiome` is a Class T threshold cascade deleted at `4-6`. Phase 0 lands the *types and the convention*; `4-6` inherits it. |

### 0.3 Two Phase 1 items jump the queue

Inserting three and a half weeks of invisible work ahead of Phase 1 would delay the fix for the user's loudest complaint — clouds counter-rotating with the aircraft — by a month, and would leave the renderer silently trading resolution for nothing for that whole time.

Both fixes are small, neither is architectural, and there is no reason to wait:

- **`1A-4` — the cloud bug (0.8 d)** runs on day 1 of Phase 0.
- **`1A-6a` — the absolute pixel cap and DPR ceiling (0.5 d)** runs on day 1 of Phase 0.

They remain Phase 1 items in the ownership sense; they are simply executed first. Both plans record this. Phase 1's ledger marks them *executed during Phase 0* and does not count their days twice.

---

## 1. What §1 of the rendering plan actually asks for, and who delivers it

### 1.1 The today-vs-after table, mapped

`RENDERING_PLAN.md` §1.1 lists eleven concerns and their end states. None of those end states is a Phase 0 deliverable — they arrive across Phases 1–6. What Phase 0 lands is the **contract each one will be built against**.

| §1.1 concern | End state delivered by | What Phase 0 lands |
|---|---|---|
| Height authority | Phase 4 (`4-1`…`4-3`), Phase 5 (`5-3`, `5-4`) | The kernel portability contract — 24-bit hashing, per-octave domain wrap, `pow` clamps, `filterWidthMeters` threaded (`0-4`); the sole-authority declaration and its tests (`0-5`) |
| Terrain geometry | Phase 4 (`4-4`, `4-5`) | Page geometry as one number: 264² height, 136² channels, gutter 4 everywhere (`0-2`); page identity and residency live (`0-3`) |
| LOD | Phase 4 (`4-5`) | Flight-corridor streaming priority and eviction ordering adopted (`0-3`) |
| Normals | Phase 1 (`1B-1`), Phase 4 (`4-4`) | The core/gutter addressing convention both will use (`0-2`) |
| Surface material | Phase 3 | `payload.ts` as the single change point for every channel addition (`0-1`, `0-3`) |
| Atmosphere | Phase 1 (`1C-4`) | `SharedReceiverRegistry` — one plumbing pattern, not three (`0-7`); single-owner rule enforced (`0-1`) |
| Indirect light | Phase 1 (`1C-6`), Phase 4 (`4-7`) | Same (`0-7`) |
| Shadows | Phase 1 (`1A-5`), Phase 4 (`4-8`) | The `MaterialPluginBase` + `ShadowDepthWrapper` premise **validated or refuted** (`0-9`) |
| Rivers/lakes | Phase 5 | The hydrology page schema already in `payload.ts`; owner recorded and enforced (`0-1`) |
| Resolution control | Phase 1 (`1A-6a`, `1A-6b`) | Ownership recorded (`0-1`); `1A-6a` executed day 1 (§0.3) |
| Measurement | Phase 1 (`1A-1`, `1A-2`) | The test environment decided and wired (`0-8`); the first contracts written *as tests* (`0-5`) |

### 1.2 The single-owner table, made enforceable

`RENDERING_PLAN.md` §1.4 resolves twelve ownership disputes — five files claimed by two or three subsystem designs, and four incompatible page geometries. Every row below is currently enforced by nothing.

| §1.4 row | Enforced by | How |
|---|---|---|
| `world/payload.ts` — terrain-geometry | `0-1`, `0-3` | It becomes live code with real consumers. A test asserts no page-channel type is declared outside it. |
| `TerrainPageAtlas.ts` — terrain-geometry | `0-1` | Owner manifest entry; boundary test forbids atlas creation outside `terrain/`. |
| **Page geometry — one number** | `0-2` | `WORLD_PAGE_GUTTER = 4`, `HEIGHT_CORE = 256`, `CHANNEL_CORE = 128` as the only definitions, with a test asserting the exact values. No 132², no 260², no 66². |
| `TerrainErosionCompute.ts` — terrain-geometry | `0-1` | Manifest entry (file does not exist until Phase 5). |
| Aerial-perspective include — lighting | `0-1`, `0-7` | Single-definition-site test; shared registry so consumers cannot re-derive. |
| Sky env cube / IBL — lighting | `0-1`, `0-7` | Same. |
| Quality-tier table + governors — performance | `0-1` | Manifest entry; boundary test forbids tier constants outside `core/`. Implementation stays `1A-2`/`1A-6b`. |
| Runway earthworks profile — terrain-material | `0-1`, `0-5` | Manifest entry; the runway influence invariant becomes a test (`0-5`). |
| Vegetation density function — vegetation | `0-1` | Single-definition-site test: `densityField` has one implementation and terrain-material may only import it. |
| `MAX_TERRAIN_HEIGHT` — terrain-geometry | `0-1` | Manifest entry pinning it at 2,200 m until `5-8`. |
| Channel-graph extractor — water | `0-1` | Manifest entry (file does not exist until Phase 5). Previously unowned and on the critical path. |
| `detail.worker.ts` — vegetation | `0-1` | Manifest entry; created by `1B-10`. |

### 1.3 The physics consistency contract

`RENDERING_PLAN.md` §1.3 opens: *"This is the one thing in the plan that is game-breaking if we get it wrong, so it gets its own contract."* The invariant is one sentence — **the surface the aircraft touches and the surface on screen are produced by the same authority** — and today it holds by construction: `simulation.worker.ts:69-83` and `spawn.ts:78-92, 128, 199` call `sampleTerrainCollision`/`sampleTerrainCollisionHeight`, and the render path calls the same kernel through `tile.ts`.

It holds today, it must hold at every gate boundary from here to Phase 5, and at `5-2` it stops holding by construction and starts holding by readback.

**The only cheap moment to write that contract's tests is now, while they trivially pass.** That is `0-5`, and it is the item with the highest consequence-if-omitted in the phase.

---

## 2. Items

Three gates. Each gate is a shippable commit set; none leaves the sim worse, and none of them changes a pixel except A1's seed churn.

### Gate 0A — Ownership and page identity (6.0 d)

---

#### `0-1` — Owner manifest and boundary enforcement (1.5 d)

**Intent.** Turn §1.4's table from a decision anyone can forget into a test that fails.

**Deliverables.**

1. **`ARCHITECTURE.md` at the repo root** — the twelve ownership rows, the physics invariant (§1.3), the page geometry numbers, and the "every channel addition goes through one PR against `payload.ts`" rule, as the project's live architectural reference. It is short and it is normative; `RENDERING_PLAN.md` stays the programme plan, `TERRAIN_AUDIT.md` stays the evidence.
2. **`src/render/webgpu/owners.ts`** — the manifest as data:

```ts
export interface ArchitecturalOwner {
  readonly artifact: string;          // "aerial-perspective-include"
  readonly owner: SubsystemName;      // "lighting"
  readonly definitionSites: readonly string[];  // glob(s), normally exactly one
  readonly consumers: "any" | readonly SubsystemName[];
  readonly notes?: string;
}
export const ARCHITECTURAL_OWNERS: readonly ArchitecturalOwner[];
```

3. **`tests/architecture.boundaries.test.ts`** — a Node test that reads `src/` and asserts:
   - **Single definition site.** For every manifest row whose `definitionSites` has length one, no other file under `src/` declares a matching exported symbol. This is what stops a second aerial-perspective derivation, a second density function, or a fifth page geometry.
   - **Forbidden edges.** A declared allow-list for a small number of load-bearing boundaries — page addressing may only be defined under `world/`; quality-tier constants only under `core/`; `detail/` internals are not importable from `terrain/` except through the density-field entry point.
   - **Manifest completeness.** Every row's `definitionSites` glob resolves to at least one real path, or is explicitly marked `"planned"` with the phase that creates it.

**Deliberately not.** No ESLint plugin, no dependency-cruiser config, no module-federation ceremony. A ~150-line test that reads files and asserts a manifest is the right size: it is readable, it fails with a useful message, and it has no dependency that can rot.

**Done when.** Adding a second `aerialPerspective` definition, or a second page-gutter constant, fails `npm test` with a message naming the owner.

---

#### `0-2` — Page geometry: one number (1.5 d)

**Intent.** §1.4 had to resolve *four incompatible page geometries* proposed by four subsystem designs. The resolution — **height 256 core + 4 gutter = 264²; every other channel 128 core + 4 gutter = 136²; gutter 4 everywhere** — currently exists only as a table cell.

**Design.** `src/render/webgpu/world/pageGeometry.ts`, Class P, no Babylon import:

```ts
export const WORLD_PAGE_BASE_EXTENT_METERS = 512 as const;
export const WORLD_PAGE_GUTTER = 4 as const;
export const WORLD_PAGE_HEIGHT_CORE = 256 as const;     // stored edge 264
export const WORLD_PAGE_CHANNEL_CORE = 128 as const;    // stored edge 136

/** The single canonical layout. payload.ts's WorldPageLayout stays parameterised
 *  so tests can construct others; this is the only one the renderer ships. */
export const WORLD_PAGE_LAYOUT: WorldPageLayout;

export function pageTexelSizeMeters(level: number, core: number): number;
export function coreToStoredIndex(row: number, column: number, core: number): number;
export function storedEdge(core: number): number;
```

**The addressing convention, which is the load-bearing part.** Core sample `(row, column)` lives at stored index `(row + gutter) * storedEdge + (column + gutter)`; the gutter extends *outside* the page and never renumbers the core; the world coordinate of core sample `i` is `pageOrigin + i * texelSize`. This is **the same convention** `1B-1`'s tile halo uses with `halo = 1` and `4-2`'s atlas uses with `gutter = 4`. Establishing and testing it once, here, is why `1B-1` gets 0.25 d cheaper and why `4-2` does not get to invent a fifth one.

**Reconcile with what exists.** `payload.ts`'s `getWorldPageStoredDimensions()` already computes stored edges from a layout and is correct; `pageKey.ts`'s `worldPageExtentMeters(level, baseExtent)` already computes `baseExtent * 2 ** level`, which is exactly `TerrainClipmapSystem`'s `BASE_PAGE_EXTENT * 2 ** level`. Import them; do not reimplement them. `0-2` supplies the *values* and the addressing helpers those parameterised functions were waiting for.

**Tests.** Exact-value assertions on all four constants (a drift to 132² or 66² fails CI, by name). Addressing round-trip for `core ∈ {128, 256}` and `gutter ∈ {0, 1, 4}`, including the four corners and all four gutter bands. Agreement with `getWorldPageStoredDimensions(WORLD_PAGE_LAYOUT)`. Level→extent agreement with `worldPageExtentMeters`.

---

#### `0-3` — Make `src/render/webgpu/world/` live (3.0 d)

**Intent.** End the parallel ad-hoc path. This is the item that most directly answers the audit's institutional finding, and it is the reason this phase is worth doing before Phase 1 rather than after.

**What is dead and what duplicates it.** Verified in the current tree:

| `world/` module | Provides | `TerrainClipmapSystem`'s hand-rolled version |
|---|---|---|
| `pageKey.ts` | Branded `WorldPageKey`, canonical parse (rejects `-0`, `01`), `parentWorldPageAddress`, `childWorldPageAddresses`, `worldPageBounds`, `worldPageExtentMeters` | A local `pageKey(level, tileX, tileZ)` returning a bare template string, a local `pageBounds()`, and `BASE_PAGE_EXTENT * 2 ** level` inline |
| `lifecycle.ts` | Eight-state machine with legal-transition enforcement and **epoch tokens for harmless rejection of stale worker results** | A `generation` counter plus a `pending` map, with staleness checked by hand at the callback |
| `streamingPriority.ts` | Swept flight-corridor scoring: closest approach, time-to-closest, along-track distance, behind-penalty, level penalty, `rankWorldPageStreamingCandidates` | `priority: distance + level * 400`, with a separate ad-hoc look-ahead computed inline in `update()` |
| `cache.ts` | Metadata, pinning, compatibility checks, `compareWorldPageCacheEvictionOrder` | `lastRequiredFrame` plus `EVICTION_GRACE_FRAMES = 90` |
| `payload.ts` | Page schema with the gutter, quantisation, transferables, `WORLD_PAGE_SURFACE_CHANNELS` | Nothing — the CPU tile path predates it |
| `validation.ts` | Structural validation of a payload | Nothing |

**Scope, kept deliberately tight.** Adopt the four modules that map onto what the clipmap already does, and delete the duplicates:

1. **Identity and bounds.** Replace the local `pageKey()` and `pageBounds()` with `WorldPageAddress` / `createWorldPageKey` / `worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS)`. The clipmap's `DesiredPage` carries an address, not three loose integers.
2. **Priority.** Replace `distance + level * 400` and the inline look-ahead with `rankWorldPageStreamingCandidates`. Feed it a `WorldPageStreamingObserver` built from the same state `update()` already receives. Tune `DEFAULT_WORLD_PAGE_STREAMING_PRIORITY_OPTIONS` against the measured result rather than adopting the defaults blind.
3. **Residency.** Replace the `generation`/`pending` pair with one `WorldPageLifecycle` per page. The current synchronous path exercises `unloaded → queued → loading → cpu-ready → uploading → resident` (with `applyToMesh` standing in for the asynchronous upload) and `resident → evicting → unloaded`. Using a subset is safe by construction: the machine throws on illegal transitions, and states you never enter cost nothing. `4-2` completes the asynchronous half.
4. **Eviction.** Replace the raw frame-grace comparison with `compareWorldPageCacheEvictionOrder` over `WorldPageCacheMetadata`, keeping the 90-frame grace as the metadata's recency input.

**Explicitly not in scope.** No CPU page cache (the plan cuts it — the Phase 4 atlas *is* the cache). No adoption of `payload.ts`'s quantised page format by the CPU tile path — that path is deleted at `4-4` and its `TerrainTileData` is fine until then. No other refactor of the clipmap.

**Lifetime honesty.** The four modules being adopted are **Class P** — `4-2` reuses three of them verbatim, and `payload.ts` is the Phase 4 page contract. The adapter inside `TerrainClipmapSystem` is **Class T** and must stay thin. This is not investment in doomed code; it is deletion of doomed code in favour of the surviving architecture, four months before Phase 4 depends on it being correct.

**Expected behaviour change, and it is the point.** Streaming order changes from "nearest first, coarse levels penalised" to "soonest-needed along the flight corridor first". That is strictly better and it is what `calculateWorldPageStreamingPriority` was written for. It will also surface latent bugs in modules that have never run outside a unit test — which is precisely why doing it now, against a CPU path that is easy to debug, beats doing it at `4-2` against a GPU atlas.

**Tests.** Extend `tests/render.webgpu-terrain-clipmap.test.ts`: the desired set is unchanged for a stationary observer; a moving observer requests pages ahead of the aircraft before pages behind it at equal distance; a stale worker result arriving after a profile change is rejected by epoch and does not create a mesh; eviction order matches `compareWorldPageCacheEvictionOrder`. Keep `render.webgpu-world-page-contract.test.ts` and `render.webgpu-world-streaming.test.ts` green — they are the existing specification of these modules.

**Done when.** `src/render/webgpu/world/` has non-test consumers; the local `pageKey`, `pageBounds`, `generation` counter and `EVICTION_GRACE_FRAMES` comparison are deleted; the boundary test from `0-1` asserts page addressing is defined only under `world/`.

---

### Gate 0B — The kernel and physics contracts (4.5 d)

---

#### `0-4` — Kernel portability pass (2.5 d)

**Intent.** Make `src/world/{terrain,geology,noise,seed}.ts` — the Class K kernel, which is simultaneously the physics authority until `5-2` and the source `4-1` transliterates into WGSL — **signature-complete and WGSL-portable, without changing what it computes.**

**The governing idea, and it is the main design contribution of this phase: separate the signature change from the behaviour change.**

`RENDERING_PLAN.md` puts the band-limit cutoff, the hash-precision change and the domain wrap in three different places (`1B-2`, `4-1`, `4-1`). My Phase 1 plan already pulled two of them forward. Phase 0 goes one step further and splits the *kind* of change:

- **Phase 0 changes the interface and the numerics substrate.** Every function gains its final parameter list; hashing becomes reproducible in f32; coordinates become wrap-safe; `pow` bases become WGSL-legal. Behaviour is bit-identical apart from the hash.
- **Phase 1 `1B-2` changes the behaviour.** With the parameter already threaded and its invariance test already in place, band-limiting becomes a diff in two functions instead of a simultaneous signature-plus-behaviour-plus-hash change across four files and roughly twenty call sites.

That matters more than it sounds, because this kernel *is* the flight model. A twenty-call-site refactor that also changes what the ground is shaped like is a bad thing to debug.

**Four changes.**

1. **24-bit hash truncation.** `seed.ts:52-58` returns `(hash >>> 0) * (1 / 4_294_967_296)` computed in f64. `f32` cannot reproduce that above 2²⁴, so a 32-bit conversion can never be made bit-identical between the CPU kernel and its WGSL port — and `RENDERING_PLAN.md` §1.3 makes bit-exactness a binding requirement. Replace with `(hash >>> 8) * (1 / 16_777_216)`: 24 bits, exactly representable on both sides, 16× more entropy than a noise lattice consumes.

2. **Per-octave domain wrap.** The kernel divides raw world coordinates by small constants — `/43`, `/105`, `/310`, `/850` — and at |x| = 5×10⁶ m an f32 has ~1.6×10⁻² of a lattice cell of precision, so CPU (f64) and GPU (f32) will disagree about which cell a boundary point falls in and the noise jumps. Before any `Math.floor` in `valueNoise2D` (`noise.ts:30-43`), subtract an integer multiple of that octave's lattice period, computed in f64. In Phase 0 the multiple is computed locally; `4-1` hoists it into the page-origin uniform. **The failure mode this prevents is a parity test that passes near the origin and a simulation that breaks at 500 km.**

3. **`pow` base clamps.** `terrain.ts:62, 63, 71, 80` and `geology.ts:65` raise possibly-zero values to fractional powers. `pow(0, x)` is indeterminate in WGSL. Make the bases explicitly `max(0, …)` so `4-1` is a transliteration and not a debugging session.

4. **`filterWidthMeters`, threaded as a no-op.** Add it as a **required positional parameter** to `sampleNaturalTerrainHeight`, `sampleGeologicalRelief`, `sampleTerrainMoisture` and `sampleTerrainTemperature`, and pass it explicitly at every call site — `0` everywhere in Phase 0, so behaviour is unchanged. Positional and non-optional on purpose: this kernel runs ~181 times per vertex and an options-object literal per call is an allocation in the hottest loop in the codebase; and *required* means `tsc` names every call site that has not been considered, whereas a defaulted parameter lets a site silently reintroduce the horizon crawl.

**Seed churn.** Change 1 slightly changes every seed's world. It is done here because `RENDERING_PLAN.md` R10 asks that seed-churning items land together and because **no screenshot baseline exists yet** — `1A-1` has not run. This is the cheapest this change will ever be. Re-baseline `tests/world.test.ts`, `tests/world.tile.test.ts` and `tests/world.geology.test.ts` in the same commit, each updated constant carrying a comment naming this item.

**Tests.**
- Golden values, re-baselined once.
- **Domain-wrap continuity at |x| = 5×10⁶ m:** sample a 1 km transect at 1 m spacing across the wrap boundary; no step exceeds 4× the median step.
- **Wrap is a no-op near the origin:** unchanged to 1e-9 for |x| < 10⁴ m.
- **Filter-width invariance:** `sampleNaturalTerrainHeight(seed, x, z, 0)` equals the pre-change value bit-for-bit modulo the hash change, over 4,096 points. This is the assertion that `1B-2` will later relax to the 1 mm L0 bound.
- `tests/sim.flight.test.ts` still holds. If an envelope assertion is now marginal, that is information about the test's tolerance — investigate before re-baselining, and **never** re-baseline it in the same commit as a rendering change.

---

#### `0-5` — The physics/render consistency contract (2.0 d)

**Intent.** `RENDERING_PLAN.md` §1.3 names an owner for this invariant — `src/render/webgpu/terrain/TerrainCollisionMirror.ts` + `src/sim/terrainGrid.ts` — and then does not create it until Phase 5, four months after the invariant starts being at risk. Create it now, as a pass-through, with its tests.

**Why a pass-through is not busywork.** Today every physics terrain query goes directly to the analytic kernel from three places: `simulation.worker.ts:69-83` (`terrainSample`, `terrainHeightSample`), `spawn.ts:78-92` (`crashRecoverySurfaceHeight`), and `spawn.ts:128, 199`. At Phase 5 the authority changes to a read-back eroded grid with a coarse fallback. If those three call sites still point at the kernel then, `5-2` is a hunt across the simulation for every place that samples terrain. If they point at one module, `5-2` changes one file.

**Deliverables.**

1. **`src/sim/terrainGrid.ts`** — the simulation-side authority. Exports `sampleGroundHeight(x, z)` and `sampleGroundContact(x, z, target)`. Today it forwards to `sampleTerrainCollisionHeight` / `sampleTerrainCollision`. Phase 5 replaces the body with the bicubic page lookup plus fallback. **All three call sites route through it.**
2. **`src/render/webgpu/terrain/TerrainCollisionMirror.ts`** — the render-side counterpart, an interface plus a null implementation. Today it declares the contract (`publishPage(level, tileX, tileZ, heights)`, `fallbackSampleCount`) and does nothing. `5-2` implements it.
3. **`collisionSamplesServedByFallback: number` on `RenderDiagnostics`** (`src/game/types.ts:68-99`), wired to 0 and surfaced in the HUD. §1.3 requires this counter and states that any non-zero value below 500 m AGL is a bug. Reserving the field and the HUD row now costs minutes; retrofitting a diagnostic through the worker boundary later costs half a day.
4. **The sole-authority declaration** as a doc comment on `sampleNaturalTerrainHeight`, naming `5-2` as the point where it stops being the authority and becoming (a) the GPU uplift input and (b) the above-500 m-AGL fallback.

**Four tests, all of which pass trivially today. That is the point — they must keep passing at every gate.**

| Test | Asserts | Guards |
|---|---|---|
| **Runway invariant** | `getAirportInfluence(airport, x, z) === 1.0` for a dense sample of points inside the apron, and `isPointOnRunway` agrees | `sampleTerrainCollisionHeight` short-circuits on influence ≥ 1 (`terrain.ts:118-125`) and `sampleTerrainCollision` returns before any height sampling on the runway branch (`:167-176`). `3-8`'s earthworks and `5-6`'s erosion mask must not break this, and spawn and friction depend on it. |
| **Ground clearance** | Never negative over the full `sim.flight.test.ts` profile | The aircraft sinking into or floating above terrain — the game-breaking failure |
| **Authority agreement** | Render-path height equals physics-path height at L0 spacing, over 4,096 points | Divergence at every later gate. Trivial today; the whole safety argument for Phases 1–3 |
| **Crash-recovery coverage** | `crashRecoverySurfaceHeight`'s radius ring is served entirely by the active authority | §1.3's named hole: recovery samples a ring around an arbitrary crash point, routinely outside the 5×5 L0 page ring, and without coverage can place the aircraft below visible terrain |

**Determinism note, recorded now for Phase 5.** `vitest.config.ts` is `environment: "node"`. Once `5-2` lands, `sim.flight.test.ts` would silently exercise the analytic fallback — a *different* landscape from the rendered one — and the only regression guard on physics/render agreement would evaporate. The authority-agreement test above is written so that it fails loudly in that situation rather than passing vacuously.

---

### Gate 0C — Shared plumbing and validated premises (5.0 d)

---

#### `0-6` — `EnvironmentClock` and the season threading rule (2.0 d)

**Intent.** `RENDERING_PLAN.md` §1.6 calls the threading rule *"the whole point of writing this down now"*:

> `dayOfYear` is a parameter of the land-cover classifier's signature from the moment the classifier is first written (Phase 4, item `4-6`), not an addition to it. Same for the vegetation density and appearance fields (`1B-7`, `2-18`) and the surface plugin's palette (`3-10`).

The rule is only enforceable if the type exists before the first of those is written — and `1B-7` (vegetation density) is a Phase 1 item.

**Deliverables.**

1. **`src/world/environmentClock.ts`** — `EnvironmentClock { dayOfYear, solarTimeHours }` with range validation, plus solar declination and day-length helpers. Class P, pure, Node-testable.
2. **`WorldDefinition.latitudeDegrees`** with a sensible default for existing worlds.
3. **Settings schema and migration.** `src/settings/index.ts:38-39, 65-66, 124-132` persists `timeOfDay` as one of `"dawn" | "day" | "golden"` through a `oneOf` validator, and users have it in `localStorage`. Add the two scalars with range validation in the file's existing `clampNumber` style, and a migration mapping each persisted label to a plausible `(dayOfYear, solarTimeHours)` pair. **A pre-Phase-0 settings blob must load without throwing** — that is a test.
4. **The convention, enforced.** A CI assertion that `EnvironmentClock` (or `dayOfYear`) appears in the input type of every field function in the seasonal family — the vegetation density field, the classifier, the surface palette — as those files come into existence, with the manifest from `0-1` listing which ones are in the family and which phase creates them.

**Not in scope.** The `EnvironmentDirector`, the NOAA solar formula, and `presetFor()`'s deletion stay in `1C-1`. The UI stays in `1C-9`. Phase 0 lands the *types, the persistence and the rule*, which is what has to exist first; `1C-1` and `1C-9` shrink by 0.25 d and 0.75 d respectively.

**Why not later.** §1.6 costs this out explicitly: taking `dayOfYear` at the point of first writing costs ~0.5 d; retrofitting it after Phase 4 means re-threading a uniform through the WGSL include chain, its TypeScript mirror, the classifier signature and the page-atlas cache key — several days and a churned screenshot baseline.

---

#### `0-7` — `SharedReceiverRegistry` (1.0 d)

**Intent.** §1.4 names three shared GPU resources with three different owners — the aerial-perspective include (lighting), the sky environment probe (lighting), and cloud shadows (clouds, already built) — and every one of them needs the same plumbing: one shared resource, many PBR materials, rebind on floating-origin shift, register meshes or materials, dispose cleanly.

`CloudShadowReceiverRegistry` solves it correctly today. Without this item, `1C-4` hand-rolls a second copy and Phase 7's clustered lighting hand-rolls a third.

**Design.** Extract the generic shape into `src/render/webgpu/core/SharedReceiverRegistry.ts`:

```ts
export abstract class SharedReceiverRegistry<TProjection, TPlugin extends MaterialPluginBase> {
  registerMaterial(material: PBRMaterial): void;
  registerMeshes(meshes: Iterable<AbstractMesh>): void;
  setProjection(projection: TProjection, originX: number, originZ: number): void;
  dispose(): void;
  protected abstract createPlugin(material: PBRMaterial): TPlugin;
}
```

Reimplement `CloudShadowReceiverRegistry` on top of it with **no behaviour change**, guarded by the existing `tests/render.webgpu-cloud-shadow-receivers.test.ts`. That test passing unchanged is the proof the extraction is faithful.

**Payoff.** `1C-4` drops 0.5 d, `1C-6` drops 0.25 d, and `7-4` inherits a solved problem rather than a third pattern.

---

#### `0-8` — The WebGPU test environment (1.0 d) · *moved from `1A-3`*

**Intent.** Phase 0's product is contracts enforced by tests, and some of those tests — WGSL compilation now, CPU/GPU parity at `4-1` — need a real adapter. `vitest.config.ts` is `environment: "node"`; there is no adapter anywhere in the repo today. `RENDERING_PLAN.md` says to decide this before any Phase 4 work; deciding it in the architecture phase is strictly better, because the decision *is* architecture.

**Recommendation.** A second Vitest project, `vitest.gpu.config.ts`, using browser mode with the Playwright provider and headless Chromium (`--enable-unsafe-webgpu --use-angle=metal`), while `vitest.config.ts` stays Node and stays fast. New dev dependencies: `@vitest/browser` and `playwright`. Add `npm run test:gpu`; keep it out of `npm run verify`, and run it explicitly and at every gate boundary.

**Why two projects.** Almost every assertion in Phases 0–1 — the manifest boundary test, page addressing, kernel golden values, the physics invariants, budget arithmetic, governor state machines, SH irradiance — is a pure function over numbers and **must** stay in Node, where it runs in seconds. Only shader compilation and GPU parity need an adapter. Splitting keeps the fast loop fast and makes the GPU dependency explicit rather than ambient.

**Fallback.** A documented manual `/dev/shader-check` page that compiles every registered WGSL include at startup. Slower and manual, but it catches the failure that matters. **Time-box to one day either way** — but make the decision, because every Phase 4 parity test blocks on it.

---

#### `0-9` — Vertex-plugin + `ShadowDepthWrapper` premise (1.0 d) · *moved from `1A-7`* · **run first**

**Intent.** This is not a Phase 1 convenience; it validates a **premise of §1.1's "after" column** and of §0.2's refusal to migrate engines. If it fails, the architecture changes — terrain becomes a dedicated `ShaderMaterial` rather than a `PBRMaterial` with plugins — and `0-1`'s manifest, Phase 3's `3-2` and Phase 4's `4-4` are all written differently. **An architectural premise must be tested before the architecture is recorded, so this runs on day 1.**

**What is already verified** (`RENDERING_PLAN.md` §7 R1): bind-group visibility derives from the stage a WGSL declaration appears in, so a texture declared in `CUSTOM_VERTEX_DEFINITIONS` gets VERTEX visibility; `getAttributes`, `getUniforms({arraySize})` and `!regex` replacement all exist; and this codebase already binds a texture through a plugin on the terrain material (`CloudShadowMaterialPlugin`).

**What is fatal if wrong:** `Lights/Shadows/shadowGenerator.js` builds its own shadow-map effect and never consults the plugin manager. Terrain displaced only in the PBR vertex shader would cast shadows from the undisplaced flat grid; alpha-tested foliage would cast solid cone shadows — worse than today.

**Spike, timeboxed to one day, then decide.**

1. Attach a trivial `MaterialPluginBase` to the existing terrain `PBRMaterial`; declare a uniform in `CUSTOM_VERTEX_DEFINITIONS`; displace `position.y` by a constant in `CUSTOM_VERTEX_UPDATE_POSITION`. Confirm the mesh moves.
2. Confirm the **shadow does not** move.
3. Set `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, { remappedVariables: [...] })`. Confirm the shadow now follows.
4. Confirm it composes with `CloudShadowMaterialPlugin`, already attached to the same material.
5. Record the working incantation **verbatim** in the decision log.

**Fail path.** A dedicated `ShaderMaterial` for terrain — the ocean already proves the pattern on this stack — at the cost of reimplementing PBR receiving, CSM and the cloud-shadow plugin. That is a Phase 3/4 re-plan of several days, and the entire value of running this on day 1 of Phase 0 rather than in month 4 is that it is knowable now.

---

## 3. Work order and schedule

### 3.1 Dependency graph

```
0-9 spike ─────→ (gates 0-1's manifest, and Phases 3/4 architecture)
1A-4 · 1A-6a ──→ (jumped Phase 1 items, no dependencies)
0-8 harness ───→ (gates every Phase 4 parity test)

0-2 page geometry ──→ 0-3 make world/ live
0-1 owner manifest ─→ (consumed by every later gate's CI)

0-4 kernel portability ──→ Phase 1 1B-2, Phase 4 4-1
0-5 physics contract ────→ Phase 5 5-2

0-6 environment clock ──→ Phase 1 1C-1, 1C-9 · Phase 2 2-18 · Phase 4 4-6
0-7 shared registry ────→ Phase 1 1C-4, 1C-6 · Phase 7 7-4
```

There is no long chain here — Phase 0 is a set of mostly independent foundations, and its duration is simply the sum, because one person builds them. The only hard ordering constraints are **`0-9` first** (it can change the architecture), **`0-2` before `0-3`**, and **`0-4` before `1A-1` commits a screenshot baseline**.

### 3.2 Week ledger — 4.5 productive days per week

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `1A-4` cloud bug (0.8) · `1A-6a` pixel cap (0.5) *— both jumped from Phase 1* · **`0-9` plugin spike (1.0) — architectural premise, run before anything is recorded** · `0-8` test harness (1.0) · `0-1` owner manifest (1.2 of 1.5) | 4.50 |
| 2 | 4.5 → 9.0 | `0-1` finish (0.3) · `0-2` page geometry (1.5) · `0-4` kernel portability pass (2.5) | 8.80 |
| 3 | 9.0 → 13.5 | `0-5` physics contract (2.0) · `0-3` make `world/` live (2.5 of 3.0) | 13.30 |
| 4 | 13.5 → 16.8 | `0-3` finish (0.5) · `0-6` environment clock (2.0) · `0-7` shared registry (1.0) → **Phase 0 closes, d16.8** | 16.80 |

**15.5 architecture days + 1.3 jumped Phase 1 days = 16.8 elapsed ≈ 3.7 weeks.**

### 3.3 What this costs, stated plainly

| | Days | Calendar |
|---|---|---|
| Phase 0 (architecture) | 15.5 | 3.4 wk |
| Phase 0 (jumped Phase 1 work) | 1.3 | — |
| **Phase 0 elapsed** | **16.8** | **3.7 wk** |
| Phase 1, re-costed | 43.0 | 9.6 wk |
| **Phase 0 + Phase 1** | **59.8** | **13.3 wk** |
| *Phase 1 alone, previous plan* | *49.6* | *11.0 wk* |
| **Net cost** | **+10.2** | **+2.3 wk** |

Roughly 4.75 of Phase 0's 15.5 days are Phase 1 work relocated, not added; the genuinely new cost is ~10.75 days, of which the largest single piece is `0-3` at 3.0.

Programme total moves from ~278 days to **~288 days**.

---

## 4. Verification

Phase 0 adds no visual assertions. Everything it produces is a Node test.

| # | Assertion | By | Guards against |
|---|---|---|---|
| 1 | Single definition site per manifest artifact | `0-1` | A second aerial-perspective derivation, a second density function, a fifth page geometry |
| 2 | Forbidden import edges | `0-1` | Page addressing defined outside `world/`; tier constants outside `core/` |
| 3 | Manifest completeness — every glob resolves or is marked `"planned"` | `0-1` | The manifest rotting into fiction |
| 4 | Page geometry constants are exactly 512 / 4 / 256 / 128 | `0-2` | The four-incompatible-geometries problem recurring |
| 5 | Core↔stored addressing round-trip for `core ∈ {128,256}`, `gutter ∈ {0,1,4}`, all four corners and gutter bands | `0-2` | A Phase 4 atlas addressing bug, and a Phase 1 tile halo bug |
| 6 | Stationary observer's desired page set unchanged by the `world/` adoption | `0-3` | A silent regression in what is resident |
| 7 | A moving observer requests ahead-of-aircraft pages before behind-aircraft pages at equal distance | `0-3` | The corridor priority not actually being used |
| 8 | A stale worker result after a profile change is rejected by epoch and creates no mesh | `0-3` | The class of bug the `generation` counter was hand-rolling |
| 9 | Domain-wrap continuity at \|x\| = 5×10⁶ m | `0-4` | A parity test that passes near the origin and a sim that breaks at 500 km |
| 10 | Wrap is a no-op below \|x\| = 10⁴ m | `0-4` | Silent world change near spawn |
| 11 | Kernel golden values (re-baselined once for the hash change) | `0-4` | Undetected kernel drift |
| 12 | **Runway influence is exactly 1.0 throughout the apron** | `0-5` | Spawn, friction and runway physics breaking at `3-8` or `5-6` |
| 13 | **Ground clearance never negative over the flight profile** | `0-5` | The game-breaking failure |
| 14 | **Render-path height equals physics-path height at L0** | `0-5` | Physics/render divergence at every gate from here to Phase 5 |
| 15 | Crash-recovery ring is covered by the active authority | `0-5` | Recovery placing the aircraft below visible terrain |
| 16 | A pre-Phase-0 settings blob loads and yields a plausible clock | `0-6` | Breaking existing users' saved settings |
| 17 | Cloud-shadow receiver tests pass unchanged after the registry extraction | `0-7` | An unfaithful refactor |
| 18 | `npm run test:gpu` acquires an adapter and compiles a WGSL compute shader | `0-8` | Discovering in Phase 4 that no parity test can run |

**Baseline note.** `1A-1` has not run, so **no screenshot baseline exists during Phase 0**. That is deliberate: `0-4`'s seed churn happens before the first baseline is captured, so it never has to be rebased. The first baseline is committed in Phase 1 at the end of `1A-1`.

---

## 5. Exit criteria

Phase 0 is done when every line is true.

- [ ] `1A-4` shipped: rolling the aircraft rolls the clouds in the correct direction; cloud edges are translucent, not a grey wall.
- [ ] `1A-6a` shipped: default render target ≤ 1.5 Mpx on a 1512×982 CSS viewport at DPR 2 (was 5.94 Mpx).
- [ ] `0-9` resolved and recorded: `ShadowDepthWrapper` composes with plugin vertex participation — **or** the `ShaderMaterial` fallback is chosen, and Phases 3/4 are re-planned before Phase 1 starts.
- [ ] `npm run test:gpu` acquires an adapter and compiles a WGSL compute shader through Babylon's `ComputeShader`.
- [ ] `ARCHITECTURE.md` exists and carries all twelve §1.4 ownership rows, the physics invariant, and the page geometry numbers.
- [ ] Adding a second definition of a manifest-owned artifact fails `npm test` with a message naming the owner.
- [ ] Page geometry has exactly one definition: 512 m base extent, gutter 4, height core 256, channel core 128.
- [ ] `src/render/webgpu/world/` has non-test consumers; `TerrainClipmapSystem`'s local `pageKey`, `pageBounds`, `generation` counter and raw eviction comparison are deleted.
- [ ] Terrain pages are requested in flight-corridor order, and a stale result after a profile change is rejected by epoch.
- [ ] `unitFloatFromHash` returns a 24-bit quotient; world golden values re-baselined **once**, each with a comment naming `0-4`.
- [ ] `filterWidthMeters` is a required parameter of all four kernel entry points, passed explicitly at every call site, and is a behavioural no-op.
- [ ] Domain-wrap continuity holds at |x| = 5×10⁶ m; `pow` bases are clamped.
- [ ] All physics terrain queries route through `src/sim/terrainGrid.ts`. The four §1.3 invariant tests pass.
- [ ] `collisionSamplesServedByFallback` exists on `RenderDiagnostics` and is visible in the HUD.
- [ ] `EnvironmentClock` and `WorldDefinition.latitudeDegrees` exist; settings persist and migrate; a pre-Phase-0 blob loads.
- [ ] `CloudShadowReceiverRegistry` is built on `SharedReceiverRegistry` with its existing test green and unchanged.
- [ ] `npm run verify` green. **No screenshot baseline has been committed yet — that is correct.**

---

## 6. Decision log

| Date | Item | Decision | Rationale to record |
|---|---|---|---|
| — | `0-9` | Plugin vertex participation: pass, or fall back to `ShaderMaterial` | **The working incantation, verbatim**, or the re-plan |
| — | `0-8` | Vitest browser + Playwright, or the manual shader-check page | Which, and why |
| — | `0-3` | `DEFAULT_WORLD_PAGE_STREAMING_PRIORITY_OPTIONS` tuning | The values, and the observed change in what is resident |
| — | `0-3` | Which lifecycle states the CPU path exercises | So `4-2` knows which half is untested |
| — | `0-6` | `timeOfDay` label → `(dayOfYear, solarTimeHours)` migration mapping | The three pairs |
| — | `0-4` | Golden values re-baselined | The commit, and confirmation `sim.flight.test.ts` was checked separately |

---

## 7. Risks

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-0A** | **`0-9` fails.** `ShadowDepthWrapper` does not compose with plugin vertex participation. | Day 1, spike step 3 or 4. | Stop and re-plan Phases 3 and 4 **before** recording the manifest in `0-1`. The fallback is a dedicated `ShaderMaterial` for terrain, reimplementing PBR receiving, CSM and the cloud-shadow plugin. Several days, and the entire point of running this on day 1 is that it is knowable now rather than in month 4. |
| **R-0B** | **Phase 0 produces no visible change and loses the room.** This is exactly the `5ef9a0f` failure mode: 20,452 lines, zero pixels. | Any time. | Mitigated structurally: the two jumped Phase 1 items ship visible fixes on day 1, so the phase opens with the cloud bug fixed and the picture no longer degrading. Beyond that, accept it honestly — Phase 0 is 3.7 weeks of infrastructure and saying otherwise would be the same self-deception the audit is about. |
| **R-0C** | **Phase 0 grows.** Architecture phases attract scope; every later item has a plausible "we should just decide this now". | Day count exceeds 18. | **Hard cut line, in order:** reduce `0-1`'s boundary test to the manifest plus a single-definition-site grep, dropping the forbidden-edge check (−1.0 d); defer `0-3`'s streaming-priority adoption to `4-2`, keeping key, bounds, lifecycle and eviction (−1.0 d). **Do not cut `0-4` or `0-5`** — they are the two items whose omission is expensive rather than merely regrettable. |
| **R-0D** | **`0-3` surfaces bugs in modules that have never run.** 1,129 lines of `world/` have only ever been exercised by two unit tests. | During week 3–4. | This is a benefit, not a cost, and the schedule assumes it: finding them now against an easily-debugged CPU path is much cheaper than at `4-2` against a GPU atlas. If it overruns by more than a day, apply the R-0C cut rather than pushing into Phase 1. |
| **R-0E** | **`0-4`'s seed churn breaks `sim.flight.test.ts`.** The kernel is the physics authority. | An envelope assertion fails or becomes marginal. | Treat as information about the test's tolerance, not a reason to revert. Investigate whether the assertion was ever robust. **Never** re-baseline `sim.flight.test.ts` in the same commit as a rendering change. |
| **R-0F** | **The `world/` modules are subtly wrong for the eventual GPU path**, and adopting them entrenches a mistake. | Discovered at `4-2`. | Low. They were written against exactly this architecture — `payload.ts` documents its gutter as *"Samples stored outside every edge to make filtering and derivatives seam-safe"*, which is precisely `4-2`'s requirement — and `RENDERING_PLAN.md` `4-2` already commits to reusing three of them verbatim. Adoption here does not add risk; it moves discovery of any such flaw four months earlier. |

---

## Appendix A — File manifest

**New (8)**
`ARCHITECTURE.md` · `src/render/webgpu/owners.ts` · `src/render/webgpu/world/pageGeometry.ts` · `src/render/webgpu/core/SharedReceiverRegistry.ts` · `src/render/webgpu/terrain/TerrainCollisionMirror.ts` · `src/sim/terrainGrid.ts` · `src/world/environmentClock.ts` · `vitest.gpu.config.ts`

**New tests (4)**
`tests/architecture.boundaries.test.ts` · `tests/world.page-geometry.test.ts` · `tests/sim.terrain-authority.test.ts` · `tests/gpu.shader-compile.test.ts`

**Modified (11)**
`src/render/webgpu/terrain/TerrainClipmapSystem.ts` (adopts `world/`; local `pageKey`, `pageBounds`, `generation`, eviction comparison deleted) · `src/render/webgpu/clouds/CloudShadowReceiverRegistry.ts` (rebuilt on the shared base) · `src/render/webgpu/clouds/VolumetricCloudSystem.ts` (`1A-4`) · `src/render/FlightRenderer.ts` (`1A-6a`) · `src/render/webgpu/core/QualityProfile.ts` (`maxRenderPixels`, `maxDevicePixelRatio`) · `src/world/{seed,noise,terrain,geology}.ts` (`0-4`) · `src/workers/simulation.worker.ts` and `src/game/spawn.ts` (route through `terrainGrid`) · `src/world/types.ts` (`latitudeDegrees`) · `src/settings/index.ts` (clock scalars + migration) · `src/game/types.ts` (`collisionSamplesServedByFallback`) · `src/ui/Hud.tsx` (fallback counter row) · `package.json` (`test:gpu`, `@vitest/browser`, `playwright`)

**Deleted**
`TerrainClipmapSystem`'s local `pageKey()` · its local `pageBounds()` · its `generation` counter and hand-rolled staleness check · its raw `EVICTION_GRACE_FRAMES` comparison · `renderTargetUv()` (`1A-4`) · `qualityPixelRatio` (`1A-6a`)

**Explicitly untouched**
The CPU tile path's `TerrainTileData` format (deleted at `4-4`) · `TERRAIN_SKIRT_DEPTH_METERS` and the skirt index builder (`4-5`) · shadow distance (`4-8`) · `classifyBiome` (`4-6`) · everything in `AtmosphereSystem` except what `1A-4`/`1A-6a` require

## Appendix B — Where the §1 decisions end up

| `RENDERING_PLAN.md` §1 | Becomes | Enforced by |
|---|---|---|
| §1.1 today-vs-after | Phase assignment table (§1.1 above) | Each phase's exit criteria |
| §1.2 what moves to the GPU | Unchanged; Phase 0 lands no compute | `0-8` makes it testable |
| §1.3 physics consistency contract | `terrainGrid.ts` + `TerrainCollisionMirror.ts` + 4 tests + a diagnostic counter | `0-5` |
| §1.3 `unitFloatFromHash` correction | 24-bit truncation | `0-4` |
| §1.3 per-octave domain wrap | Wrap in `valueNoise2D`, f64 multiple | `0-4` |
| §1.4 twelve owner rows | `ARCHITECTURE.md` + `owners.ts` + boundary test | `0-1` |
| §1.4 "page geometry — one number" | `pageGeometry.ts` with exact-value tests | `0-2` |
| §1.4 "make the renderer consume `payload.ts`" | `world/` adopted by the clipmap | `0-3` |
| §1.5 hangars kept, night in Phase 7 | Manifest note; no code | `0-1` |
| §1.6 two continuous scalars, not presets | `EnvironmentClock`, `latitudeDegrees`, settings migration | `0-6` |
| §1.6 the threading rule | Convention test over the seasonal family | `0-6` |
| §1.6 season cache-key consequence | Recorded for `4-6`; no Phase 0 code | `0-1` |
