# Phase 6 — what came out

**Written 2026-08-31 for someone who was not here.** Head at writing: `aada1cd`.
Self-contained: everything needed to follow a sentence is inlined, with deviation ids
(`D-3`, `D-7`, `D-8`, `D-9`, `D-23`) cited as the authority for the full record.
**If this document and `PHASE_6_EXECUTION_PLAN.md` §11 ever disagree, the deviation log
wins.**

**Provenance is marked throughout.** "Verified here" = checked against the tree while
writing. "Carried from `<session>`" = rests on another session's measurement and still wants
independent checking. Tonight produced at least four numbers that were correct in one
session and wrong by the time they reached a third, so the distinction is not ceremony.

---

## 1. Read this first: "landed" does not mean "you can see it"

**Roughly a wave of Phase 6's work is present in the tree, correct, green under test, and
invisible on screen.** It is not broken and not wasted — it is the *eroded* world's feature
set, waiting for a world that is not shipping. Anyone reading the plan's "landed" column
will over-count what a player sees.

**Ships and is visible** (proven in the R1–R3 rebaseline): 6-2's ocean run-up, 6-3's shelf
dispersion, 6-4's caustics, 6-5's wetness, 6-6's ecology channels, 6-7's talus, 6-8's canopy
handoff, 6-9's GPU scatter.

**Ships dark:**

| Item | Why it is dark |
|---|---|
| **6-1 river/lake flow, entirely** | Every term sits inside `if (input.waterInfo.w > 0.0)` ([HydrologySystem.ts:314](src/render/webgpu/water/HydrologySystem.ts), sentinel documented at `:303`). The four writers of that lane are `appendRiver`/`appendLake` — analytic, literal `0`, `:592`/`:644` — and `appendGraphRiver`/`appendGraphLake`, the eroded payload, `:680`/`:759`. On analytic the gate never opens. The lake-chop half is dark for the same reason: fetch reaches the shader solely through `appendGraphLake`. **Verified here.** |
| **6-2's inland half** | Depends on eroded bank geometry. Its ocean half ships and is visible. |
| **6-5, 6-6** | Dark by compile-time define and validity sentinel respectively. **Carried from `flight-simulator-d7`**; not re-derived here. |

**A third case of the same shape, found tonight:** the capture set's `night` shot is
effectively **moonless** — its clock puts a half-lit moon on the horizon — and Phase 7's
four new night shots inherit that clock. Gate 7A's moon, scotopic vision and star field were
all validated against it. Shipped, correct, and not visible. One moonlit shot is being
appended. *(Carried from the PM.)*

**So: read "landed" as "the code exists and is correct", never as "you can see it."** That
gap between the ledger and the screen is what made tonight expensive.

---

## 2. The headline

**Phase 6 ships on the analytic world. The eroded world was flown, found broken, and
terminated for this phase — parked behind its `?world=eroded` flag, not deleted.**

`DEFAULT_WORLD_EVOLUTION` is `"analytic"` (verified here,
[world.ts:33](src/world/world.ts)). That is §8 of the Phase 6 plan **resolving NO**, an
outcome the plan explicitly sanctions: *"the analytic default ships on and eroded stays a
flag — that outcome is acceptable by Q1's own terms and is not a phase failure."*

Phase 6's feature work landed. What it landed *onto* turned out to be two worlds, and only
one of them is real for a player.

---

## 3. The defect that ended the eroded world

Flown at `?world=eroded`: **no relief anywhere** — landmasses as flat page-shaped plates at
one elevation with water between them. Reproduced against an analytic control at the same
seed (`1s9phln`), which rendered correct hills, lakes and ridgelines, so the defect was
eroded-specific. **Completely silent: zero console errors across four loads.** Eroded
time-to-ready measured 20–60 s against a ≤1.5 s target.

**Mechanism** (`D-23`; carried from the ARCHITECTURE decision log):
`TerrainPageErosionGpu.demand()` returned zero for a `fine-band` stage its own `advance()`
could reach. The clipmap submitted nothing, `ComputeBudget.admitted` returned 0 for a client
that never submitted, `dispatchPageGeneration` returned at its `admitted <= 0` guard, and no
eroded page ever became resident. **Every erosion test pumped the DAG unconditionally, so
`demand()` was called by no test in the project.**

**The rule this produced, worth more than the fix:** a producer behind an admission meter
has two separate questions — *is it correct?* and *does it ever run?* — and every natural
test answers only the first, because a harness that calls the producer makes the producer
run. Gate W had byte-determinism, seam audits, statistics suites, timing and 24/24 green
analytic shots, and **not one instrument that rendered the eroded world into an image a
human looked at.**

### If you resume eroded, read these in this order

1. **`D-23`** — the admission-gate defect above. Fix first; it is why nothing rendered.
2. **`D-7` and `D-9`** — adjacent GPU-produced pages are **not** bit-equal where they
   overlap: about 8 f32 ulps, and the error is **altitude-dependent** (0.008 mm at 10 m
   elevation, but **1.95 mm at the 2,400 m terrain ceiling**, against a 5 mm physics
   tolerance). Cause: the WGSL kernels take page-relative split-origin coordinates, so two
   pages evaluate the same world texel through different decompositions. The known fix is
   designed and unbuilt — snap the lattice origin to the **world 512 m block** rather than
   the evaluating page. Meanwhile `D-9`'s loosened bound
   (`worstAbsoluteToleranceMeters: 0.06`) **still outlives its cause**, which is the exact
   condition `D-9` warned becomes permission.
3. **`D-8` and W-4's two unmet targets** — sub-macro pit density 2.574/km² against a < 0.1
   target, and valley:crest curvature 0.805:1 against ≥ 3:1 (still inverted). Both have
   measured mechanisms: **nothing drains between the page breach's 32 m reach and the macro
   flood's 512 m**; and **a page has no hillslope domain**, because its contributing-area
   field is the 512 m macro accumulation upsampled, so every 2 m texel believes it drains
   29 hectares. A diagnostic soil-creep pass recovered 0.581 → 0.672 and was deliberately
   not shipped (new operator, new reach, new GPU pass).
4. **`D-3`** — bit-exact CPU↔GPU parity is **not attainable** and was never attempted: the
   CPU reference accumulates in `Float64Array` and rounds to f32 only at outputs, so no f32
   WGSL port can match bits. Authority is GPU-vs-GPU bit determinism plus tolerance parity
   against a frozen criteria contract. Do not plan work assuming byte equality.
5. **W-7** — the eroded capture shots were never appended and no eroded baseline was ever
   promoted. **Do this before any further eroded work.** Its absence is what let the defect
   survive.

---

## 4. Five inverted surfaces, across three files

The four visual reports — near trees near-black against far trees bright yellow-green, a
grey band across near trees, a blue band across far trees, camo-like brown/blue splotches on
terrain — were **inverted triangle winding**. Five emission sites were wound opposite to
Babylon's convention, so those surfaces received **no direct sunlight at all**. Fixed across
`bbf3d27`, `ed5b703` and `d713971`.

**The fifth is the one worth understanding** — the one actually reported, and it survived
two rounds of fixing. The ground-cover blade (`buildBladeRibbon`, `GroundCoverSystem.ts`)
was inverted and **in no test at all**: the winding guard's `cases()` imported only
`prototypeGeometry`, so the blade was outside its reach. Worse, `ed5b703`'s "grass fixed"
referred to the *card* path — retired globally — while the compute blade field is what a
capture actually draws. **The grass under test was grass nothing renders.** `d713971`
exports `buildBladeRibbon` so the guard can measure it, and derives the guard's cases rather
than listing them. **Verified here.**

**Why the class survived a phase:** an existing test was **asserting the inverted convention
as correct** — a green test pinning the defect. Not an instrument that failed to look, but
one pointed the wrong way.

**Since then, three guard hardenings** *(carried from the PM; commits verified here)*:
- **`6735258`** — the guard now enumerates all four grass archetypes and all four clutter
  kinds, two more families it had been sampling one member of. **It found no new inverted
  surfaces** — a real negative result from a guard confirmed to run its cases, which is a
  different thing from an absence of evidence.
- **`aada1cd`** — the two-sided-lit material set is now **derived from source** rather than
  listed, with one named, asserted exemption. Its own docblock states the limit: it
  guarantees the *builder* is represented, not every *variant* it produces.
- **The honest bound is "six materials, twenty-seven surfaces."** Six is a fact about
  materials; until tonight the case roster covered fourteen of the surfaces. **Do not write
  "the family is complete"** — that was true of materials and false of cases, and the
  difference is exactly where the blade hid.

---

## 5. What Phase 6 leaves open

- **6-11** — the four-tier sweep, **QR-1**, cold-start wiring, memory truth. QR-1 has been
  **reframed by measurement**; the live question is the `keep` clause at tier 3. Not
  detailed here pending `SWE III`'s recon report.
- **The cold-start instrument exists and nothing runs it.**
  `tests/perf/cold-start.test.ts` is correct — both `console.error` and Babylon's
  `Logger.Error`, plus a timeout race — but `tests/perf/**` is excluded from `npm test` and
  `npm run verify`, and `.github/workflows/` holds only `ci.yml` and `gpu-tests.yml`.
  **The residual is CI wiring, not construction.** Verified here.
- **One documentation survivor**: [vitest.perf.config.ts:9](vitest.perf.config.ts) said
  the harness rendered sixteen shots while the list held **24 at the time of writing**.
  Fixed by pointing the docblock at `PERF_CAPTURE_SHOTS` rather than restating a number,
  because a restated count goes stale on the next append — **which it promptly did: more
  shots were appended the same night, and the `docs-truth` guard then caught this very
  line for restating the number in turn.** The count is deliberately not written here;
  `PERF_CAPTURE_SHOTS` is its only authority.

  *Recorded because it is the guard's own limitation, found on first contact: the check
  keys on the phrase "N canonical shots" and cannot distinguish a live claim from a
  quoted historical one. Rephrasing away from the pattern is the workaround; teaching it
  to detect quotation would be guessing at intent. It narrows the class rather than
  closing it, which is the honest description of what it does.*
- **Four latent vegetation defects (L-1…L-4)**, filed in `PHASE_7_EXECUTION_PLAN.md` §10a
  with per-row provenance. **No committed capture shot can see three of them.** L-4's 0.510
  far/mid ratio is explicitly unverified and rests on one measurement.
- **A latent trap, not a live defect:** `GroundCoverArchetype` is declared three times and
  the copies have drifted. Nothing reaches it today because the shipping caller hard-codes
  the same four. Filed for Phase 7, deliberately not fixed mid-promotion. *(Carried from the
  PM.)*
- **`VEGETATION_DRAW_COST_MS = 0.026` is a draw-*submission* model** and under-prices the
  measured caster cost by ~3.3× *(carried from `Principle Engineer`)*. Anything quoting the
  declared frame-budget table — including tier 2's "0.050 ms of slack" — quotes a model, not
  a measurement.
- **Headroom carries a ~0.80 ms noise floor.** Quote tier 1 as **~3.5–3.9 ms**, not to two
  decimals. Differences below 0.80 ms are not measurements. *(Carried from the PM.)*

---

## 6. The one lesson worth carrying

Every deep defect this phase produced was found by **consulting the artifact**, never by
reasoning about it: the flat eroded world by *flying it*; a zeroed readback by *a guard on a
value the encoding cannot produce*; a stale sampler list by *an agent asked to check one
claim against the tree*; the fifth inverted surface by *noticing which grass a capture
actually draws*.

The matching failures were all instruments that could not see their own subject — a suite
that never rendered its product, a test asserting an inverted convention, a guard importing
the wrong geometry, a budget row that models submissions and is read as cost. **None was
written carelessly.** Each was specified once, was reasonable when written, and was never
re-checked against the thing it modelled.

The sharpest single example: **a mechanical re-pin of the delivery floors from fresh samples
would have *loosened* 14 of the 24 gates, while reading as routine maintenance.** Caught
before landing. A correct-looking process, faithfully executed, producing a worse artefact
than the one it replaced.

The cheapest defences found: **ask what this actually reads, not what it is meant to read** —
and for any measurement, **ask what a passing result would look like if the feature were
entirely absent.** If the answer is "the same", it is not measuring the feature.
