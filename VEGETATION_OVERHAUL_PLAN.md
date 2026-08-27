# Vegetation Overhaul — Beta Terrain Viewer, Skeletal Trees, Living Ground

**Status: execution plan.** Branch `jazonshou/Trees`, off Phase 5 close (`0cfca75`).
`ARCHITECTURE.md` remains normative; every rule below defers to it. This plan
supersedes nothing — it *extends* the vegetation subsystem the fix-pack left
behind, and records up front which recorded decisions it deliberately reopens.

---

## 0. The problem, stated honestly

The user's report: *terrain doesn't look great; trees especially. I want
genuinely realistic, unique trees where you can actually see branches and
leaves, and real ground texture — grass, shrubs, weeds growing organically —
without sacrificing performance.*

Why trees look the way they do today is recorded in the decision log
(`6e13d6e` row): the Phase-2 alpha-card crowns were replaced by **closed opaque
hulls** (42-vert icosphere broadleaf / 4-cone-whorl conifer) because
alpha-tested overdraw was the measured near-ground bottleneck, and the opaque
early-Z hull is what carried tier 1 to ~120 fps. The fix-pack (F1–F4) then
dressed the hulls with fragment-space cluster noise and a 6–8-card fringe.
Structurally, a tree is still: an 8-sided trunk pole (one optional fork), a
blob, and a handful of cards. There is **no branch geometry anywhere**, exactly
3 distinct tree shapes at the shipping tier, and ground cover is 48-triangle
cross-blade patches on a 64 m height grid that stand bolt upright on hillsides.

The constraint that produced the hulls is real and stays binding:

- Vegetation is a **draw-call workload** (measured 26 µs/draw; Δgpu tracked
  Δdraws linearly, triangles ~0). `VEGETATION_DRAW_CEILING = [50, 58, 450, 600]`.
- Alpha-tested fragments defeat hidden-surface removal on Apple TBDR GPUs; the
  opaque early-Z pre-fill is the perf keystone (the plugin says so in as many
  words at `DetailInstanceMaterialPlugin.ts:408`).
- Tier-1 contract: perf:capture's strict gate (≥60 wall fps, p95 ≤ 16.67 ms,
  ≤5 frames > 27.4 ms, max < 50 ms) on the reference host, plus per-shot SSIM
  and the woody triangle budget (1.85 M at tier 1).

**The design thesis of this plan:** keep the early-Z keystone, but invert what
it is *for*. The opaque hull stops being the visible surface and becomes the
canopy's dark **interior core** (shrunk ~0.7×, darkened); real branch geometry
(opaque swept tubes — early-Z friendly) and a shell of **leaf-cluster cards**
(few, large, tight-silhouette) become what you actually see. Silhouette,
parallax, and inter-leaf sky are carried by geometry; the core pre-fills depth
behind the cards so overdraw stays bounded — the same trick the fringe already
uses, scaled up into the primary representation. Ground cover moves from
sparse patches to a GoT-style **per-frame GPU compute grass** system with
opaque Bézier-ribbon blades (no alpha test at all — structurally cheaper than
cards on TBDR), harmonised with the terrain albedo so the fade line is
invisible.

Research grounding (full reports in the session scratchpad; key sources:
Weber & Penn SIGGRAPH'95, Runions et al. 2007, HZD GDC'18, GoW SIGGRAPH'19,
Ghost of Tsushima GDC'21, Jahrmann & Wimmer I3D'17, Brucks/Epic impostor docs,
Babylon 9.21.2 source — verified locally):

- A Weber&Penn-style parametric skeleton costs **0.3–5 ms/tree** (measured on
  this host) vs 45–350 ms for space colonization — the parametric generator is
  the right primary; its four published species tables ship verbatim.
- Leaf-**cluster** cards (10–40 leaves painted per card) are the industry
  default (SpeedTree, HZD, GoW); individual leaf quads are an overdraw trap.
- HZD's per-LOD budgets: 10 k → 2.6 k → 1.2 k → 200+billboard → 12 tris.
  GoW ships a 28-triangle card-cluster as both mid-LOD and the *only* shadow
  proxy. Our numbers below are scaled to the tier-1 woody budget.
- GoT grass: compute-placed cubic-Bézier blades (15/7 verts), Voronoi clumping,
  ~83 k blades ≈ 2.5 ms on PS4-class hardware — the right envelope for an
  M-series iGPU minus browser overhead.
- Babylon 9.21.2 verified: `StorageBuffer` with `VERTEX|STORAGE` flags binds as
  instanced vertex/storage data, `forcedInstanceCount` is the proven house
  mechanism, material plugins can declare `var<storage, read>` and bind via
  `setStorageBuffer` from `hardBindForSubMesh`. No new dependencies needed.

---

## 1. Deliverables

1. **V — Beta terrain viewer.** A start-screen button entering a free-fly
   camera world with no aircraft and no HUD: WASD + mouse-look + vertical fly
   (Minecraft-creative feel), streaming terrain/vegetation around the camera.
   The iteration bench for everything below, and a shipped beta feature.
2. **T — Skeletal trees.** Real branch structure per species (excurrent
   conifers, decurrent broadleaves, weeping willow), leaf-cluster card
   canopies over a dark interior core, per-instance uniqueness, meshed at
   near/mid detail from ONE skeleton, impostors rebaked from the result.
3. **G — Living ground.** Per-frame compute-placed grass blades in camera
   rings (opaque geometry, terrain-albedo harmonised, wind-animated, altitude
   gated), plus fixes to the existing scatter layer (slope alignment,
   per-patch true height, denser weeds near camera).
4. **P — Perf closure.** Tier-1 contract still green; law/budget/memory rows
   re-derived, one sanctioned capture rebaseline, two new capture shots that
   gate the new look, decision-log entries recorded.

Non-goals (recorded so they don't creep): far-field forest→splat folding
(TERRAIN_AUDIT §3.5's last item — noted as the natural Phase-next), tier-2/3
retuning beyond keeping their tests green, precipitation/wetness, wildlife
changes, any new npm dependency (everything stays synthesised from the seed).

---

## 2. Architectural ground rules this plan obeys

- **The tier rule.** All new knobs are data fields on `WebGpuQualityProfile`
  (`renderedDensityLaw` gains band prices; new `groundCover` field). No
  `profile.tier` branches outside `core/`.
- **Single owners.** New artifacts get rows in `owners.ts` in the same commit:
  tree skeleton generator (vegetation), grass system + WGSL (vegetation).
  `densityField.ts` stays the sole density authority; `LandCoverClassifier`
  stays the species/habitat authority; the 32-byte instance record is not
  widened (leaf-card wind data rides the prototype's free vertex-color RG
  lanes — color.rgb is currently hardwired to 1, so R/G are free).
- **Seasonal threading rule.** Any new seasonal field function takes
  `dayOfYear` from its first commit. The leaf-card shed reuses the existing
  uv-cell dissolve shared with the impostor bake.
- **The 51b rule.** No compound assignment to multi-component swizzles in any
  new WGSL; the static scan covers new strings automatically.
- **Shadow incantation.** Every new material: plugin attached first, wrapper
  via `createGuardedShadowDepthWrapper` with
  `remappedVariables: ["vNormalW","vertexOutputs.vNormalW"]`, before first
  effect compile. `forceBackFacesOnly = true` CSM constraint: opaque casters
  stay closed volumes (tubes and cores are; cards only cast at tier ≥ 2 as
  today).
- **Budget honesty.** Every new steady allocation is a row in
  `DYNAMIC_ALLOCATIONS`; every new compute producer admits through
  `ComputeBudget`; the woody-triangle Node test moves in the same commit as
  the law, never after.
- **Buffer discipline.** Instance/storage buffers pooled, never destroyed in
  flight; no `StorageBuffer(STORAGE|READ)` (drops WRITE); readbacks (none
  planned) would need the buffer ring.
- **Capture is the oracle.** GPU tests passing means nothing until
  `perf:capture` PNGs are looked at (Phase-4-close lesson). Every wave ends
  with a capture run and eyeballs on the artifacts.

---

## 3. Wave V — Beta terrain viewer

### V-1 Start-screen entry + phase plumbing
`FlightGame.tsx` gains phase `"viewer"` (union currently
`"menu" | "flying" | "paused"`; every strict `===` gate audited). A fourth
button in `.start-screen__minimal` — label **“Beta: Terrain Viewer”**, styled
like `.seed-action` with a small `BETA` tag. Entering: pause the simulation
(the sim worker stays alive — it is the terrain-authority publisher), hide the
start screen and HUD, start the free-fly controller. Esc returns to the menu
and restores the attract demo exactly as it was.

### V-2 Free-fly controller (`src/game/freeFly.ts`)
A self-contained class, no `InputManager` involvement (flight bindings collide
with fly-cam WASD semantics; the existing manager stays untouched):

- Pointer lock on canvas click; mouse-look yaw/pitch (`movementX/Y`,
  pitch clamped ±89°); WASD planar, Space up, C/Ctrl down, Shift ×3 sprint,
  wheel adjusts base speed over [2, 250] m/s (log scale). Velocity smoothed
  with a short exponential response so motion feels inertial but crisp.
- Produces a full, finite `FlightVisualState` every frame: `position` =
  camera world position, `orientation` = quaternion from yaw/pitch,
  `velocity` for streaming prediction, `simulationTime` accumulated locally
  (drives wind/clouds/water phase), all aircraft-only fields zeroed. This
  satisfies `finiteState` and — because streaming observers are
  `state.position`-driven — terrain, detail, and wildlife stream around the
  camera with **zero changes** to their update contracts, and the floating
  origin rebases off the camera automatically.
- Ground clamp: camera never below `consumerTerrainSample(x,z).height + 1.0 m`
  (the render-side consumer authority; physics `terrainGrid` is not touched —
  no aircraft exists).

### V-3 Renderer viewer mode
`FlightRenderer` gains `setViewerMode(enabled)` and camera mode `"freefly"`:
the camera is placed exactly at `state.position` (origin-local) with the
state's orientation — no smoothing, no aircraft-relative offsets, fov 62°.
The aircraft visual is `setEnabled(false)` (meshes, shadow casters skipped via
the existing enabled checks); `updatePresentation` guards its aircraft writes.
Cockpit/chase/cinematic camera paths are untouched. `graph.invalidateHistory`
on mode toggle (camera cut).

### V-4 Viewer overlay
A minimal `ViewerHud` (new, tiny): position / altitude AGL / speed readout,
current fps + GPU p95 from `getDiagnostics()`, and the key help line.
Optionally a `V` keybind cycling vegetation debug info (resident instances,
draws, band radii) — the numbers already exist in `RenderDiagnostics`.

**Exit criteria.** Enter viewer from the start screen; fly from ground level
to 3 km altitude and back at up to 250 m/s with terrain/vegetation streaming
correctly (no page holes, origin rebase without a visible jerk — the polish
pass rig already keeps rebase smooth); Esc restores the menu attract mode;
`npm run verify` green. No capture baseline moves (viewer draws nothing new
in flight mode).

---

## 4. Wave T — Skeletal trees

### T-0 Design: the tree, per band (tier-1 prices)

| Band | Representation | Target tris/tree |
|---|---|---|
| **near** (0–180 m) | full skeleton: trunk + 2 branch levels as swept tubes (opaque bark batch) + shrunken dark interior core (opaque crown batch) + 45–80 leaf-cluster cards (alpha-test batch) | **~1,100–1,400** |
| **mid** (180–1,100 m) | same skeleton, decimated mesh: trunk + primaries at 3–4 sides, core, 10–16 large cluster cards | **~220–280** |
| **far** (1,100–3,000 m) | hemi-octahedral impostor rebaked from the new near prototype (existing pipeline) | 6 |

Budget arithmetic at tier 1 (78 stems/ha saturated forest, the law's own
integral form): near π·180²·0.0078 ≈ 794 stems × 1,300 ≈ **1.03 M**; mid
2π·0.0078·180²·ln(1100/180) ≈ 2,870 stems × 250 ≈ **0.72 M**; far floor
≈ **0.03 M**. Total ≈ **1.78 M against the 1.85 M ceiling** — the near radius
(350 → 180 m) is what pays for 7× richer trees. `renderedDensity.ts` gets the
new radii and per-band `trianglesPerPlant`, and its Node budget test moves in
the same commit. Draw-call count per chunk changes shape but not order:
tier 1 = 3 families × (bark + core + cards)·near + (bark + core + cards)·mid
+ 1 impostor ≈ 19 meshes/chunk vs ~16 today; the ceiling row (58) is
re-derived from the measured baseline, not guessed.

Band mechanics stay exactly as shipped (codes 0–3, fragment-range windows,
per-stem hashed 160 m mid/far distribution). Near→mid is no longer
geometry-identical, so the near→mid switch reuses the fringe's existing 80 m
Bayer dissolve mechanism (band-code window + `detailBayer8`), applied to the
card batches only — bark/core swap hard (tubes to tubes at 180 m is
sub-pixel).

### T-1 Skeleton generator (`src/render/webgpu/detail/treeSkeleton.ts`, new, Class P)
Weber & Penn subset, implemented from the paper (formulas in the research
report; the four published species tables — Quaking Aspen, Black Tupelo,
Weeping Willow, CA Black Oak — ship verbatim as presets, mapped onto the
existing 7-species enum plus conifer presets built per §6 of the report):

- Recursive stem chains with per-segment curvature (`nCurve`/`nCurveBack`/
  `nCurveV`), S-curves, clone splits with Floyd–Steinberg error diffusion,
  child counts/lengths via `ShapeRatio`, pipe-model radii with `RatioPower`,
  base flare, vertical attraction (willow −3), whorled placement for
  conifers (`nrings`-quantised with ±0.1% jitter), golden-angle phyllotaxis
  elsewhere, opposite/decussate for maple.
- All RNG in the skeleton stage, one seeded stream (repo hash utilities),
  fixed parent-before-children order — meshing consumes **zero RNG** so one
  skeleton meshes at every detail level with agreeing silhouettes.
- Output: flat stem array `{level, parentId, points, orientQuats, radii,
  branchPhase, role}` + leaf-anchor array `{position, quat, size}`.
- A triangle **estimator is part of the module** and a Node test hard-fails
  any preset whose near mesh exceeds its band price (the measured
  sycamore-preset 5× blowup is the failure mode this guards).
- Species mapping: pine/cedar/spruce = excurrent conifer presets (branch
  length ∝ 1−height, low whorls drooping); oak = CA Black Oak; maple =
  decussate variant; birch = aspen-with-weep (`attractUp` negative on levels
  1–2); willow = Weeping Willow. Shrub presets (multi-trunk, 2 levels) feed
  T-6.

### T-2 Meshing (`prototypeGeometry.ts`, rewritten tree path)
- `sweepTube` generalised: per-section quaternion frames (carried construction
  quaternion = rotation-minimising frame + twist), per-stem radial sides by
  radius class (trunk 8, primaries 5, secondaries 3; mid band 4/3/—),
  duplicated seam vertex with integer `wrapsU`, arc-length V seeded from the
  parent's V at the attachment point, junction collar (first two rings
  ×1.35 fading), child base sunk 0.8·r_parent into the parent. Radius floor
  ~2 cm ends tube meshing; beyond it the skeleton only carries leaf anchors.
- Interior core: the existing hull builders survive as
  `buildCanopyCore` — scaled 0.68×, occlusion alpha darkened (the fix-pack's
  cluster-noise fragment path keeps working on it), still `DETAIL_OPAQUE_CROWN`.
- Leaf-cluster cards: placed at terminal-stem anchors by the phyllotaxis
  grammar; each card 1 quad (2 tris), half-width 0.55–0.95 m, oriented by the
  Weber&Penn outward+upward bend with gravity droop; **dome normals** — vertex
  normals blended 0.7 toward `normalize(v − domeOrigin)` with the dome origin
  at the canopy *bottom* (the centroid gives black undersides); baked sky
  occlusion via the existing 16-ray bake, multiplied to match the core ramp.
  Card wind: branch phase in color.r, flex weight in color.g (both currently
  hardwired 1 → free), flutter via the existing atlas-path band.
- Character modifiers (lean/broken/thinned/dead) keep working: they operate on
  the instance record and vertex stage, not the prototype.
- Prototype builds move to an **amortised startup path** (one prototype per
  frame from the frame loop, the `3-1` pattern) — tier-2/3 species×variants
  ≈ 70 meshes must never be a synchronous block in `create()`.

### T-3 Foliage atlas spray layers (`FoliageAtlas.ts`, append-only)
New 256² layers: `sprayBroadleafOak`, `sprayBroadleafBirch`, `sprayMaple`,
`boughPine`, `boughSpruce`, `sprayWillow` (18–23) — each a *cluster* painting
(12–30 overlapping leaves/needle tufts with real silhouette raggedness, alpha
coverage ≥ 0.34 at the 0.5 test, drawn with the existing leaf primitives).
Existing layers untouched (fringe + shrubs keep working during the
transition). `foliageAtlasMiB` row 6.0 → ~8.0.

### T-4 Runtime integration (`WorldDetailRuntime.ts`, `presentationBuild.ts`)
Batch keys per (family|species, variant, band): `-bark-`, `-core-`,
`-cards-` replace `-trunk-`/`-crown-`/`-fringe-`. Catalog changes are
structured-cloned into the worker (`createPresentationBuildCatalog` — keys
must match `createBatches` exactly). Materials: bark (opaque, existing),
core (opaque crown material, existing), cards (alpha-test two-sided, existing
foliage material). Draw order intent preserved: bark+core in the opaque
bucket fill depth before the card bucket shades.

### T-5 Impostor + season compatibility
`ImpostorAtlas` bakes from the new near prototype through the existing
software rasteriser (it consumes `PrototypeGeometry` arrays — cards and tubes
flow through). Verify the bake's mean-colour envelope/normal-orientation
tests still hold; re-pin deliberately if the new canopy shifts them. Seasonal
shed: cards ride the existing tint-alpha uv-cell dissolve verbatim; the core
keeps its silhouette contraction (now hidden behind cards until late shed —
the fix-pack's accepted halo residual actually improves).

### T-6 Shrubs on the same generator
`buildShrubPrototype` rebuilt as multi-trunk 2-level skeletons (5–9 tubes +
6–10 cards, ≤ 60 tris near / ≤ 30 mid) — Weber&Penn's own note that shrubs
are short multi-trunk trees. One preset each for juniper/hazel/sage.

**Exit criteria.** In the viewer at 2–30 m: visible branch structure from
trunk to secondaries, leaf clusters with sky gaps, no floating cards, silhouettes
differ across species and (via per-instance wobble/anisotropy/lean) across
neighbours; near→mid switch invisible in normal flight, detectable only
frame-stepping. Node: skeleton determinism (same seed → byte-identical),
per-preset triangle estimator under band price, law integral under 1.85 M,
canopy-closure ≥ 0.55 still green, appearance-spectrum tests green. GPU:
`foliage-material-compile` extended to a bark+cards tree draw. Capture:
strict tier-1 gate green on the reference host.

---

## 5. Wave G — Living ground

### G-0 Design
Three camera-centred rings of compute-placed **opaque Bézier ribbon blades**
(no alpha test — structurally cheaper than cards on TBDR), parameters a pure
function of world position (zero streaming state, stable at any speed), packed
32 B/blade, drawn via `forcedInstanceCount` + storage-buffer fetch in the
vertex stage with a live-count vertex kill (no indirect draws in v1 — the
count buffer is bound read-only to the vertex stage and lanes ≥ count collapse;
compaction via workgroup-local atomics keeps dead-lane waste ~0).

Tier-1 ring table (profile datum `groundCover`, scaled by tier):

| Ring | Range | Density | Verts/blade | Width comp |
|---|---|---|---|---|
| R0 | 0–14 m | 48/m² | 15 | ×1 |
| R1 | 14–38 m | 12/m² | 7 | ×2 |
| R2 | 38–95 m | 3/m² | 5 | ×4 |
| beyond | terrain material only | — | — | — |

≈ 45–65 k live blades ≈ 300–400 k tris worst case at 2 m AGL; **altitude
gate** `1 − smoothstep(20, 80, AGL)` scales ranges (and density quadratically)
so the system is free above ~80 m — in the flight envelope it costs nothing
almost always. Estimated 1.2–2.2 ms at 2 m AGL (GoT calibration), which is
exactly the regime the existing `ground-2m-lowsun` shot gates.

### G-1 Grass domain tile (amortised compute)
A camera-snapped 256 m tile (512², 0.5 m/texel): height, packed normal,
grass/dryGrass splat weight, and harmonised ground albedo (classifier weights
× material reference albedos — the same values the terrain fragment shows at
distance). Baked by one compute dispatch sampling the resident terrain height
atlas + splat channels (the `splatSlopeAt` pattern from
`LAND_COVER_SPLAT_BAKE_WGSL` is the worked example), re-baked when the camera
crosses a 32 m quantum. Admitted through `ComputeBudget` as a new client
`groundCoverCompute` (seed ~0.4 ms, measured thereafter);
`SubsystemBudgetMs` gains the matching row. Non-resident pages → tile texel
marked empty → no blades there (only affects the first seconds after a hard
teleport).

### G-2 Per-frame placement pass
One dispatch (~150–220 k lanes at full gate): hash world position → candidate;
reject on splat weight / slope > 0.42 / airport apron (tile carries the
clearance); two-nearest-Voronoi clump blend (0.9 m cells: shared facing, tint,
height, pull — the "meadow, not noise" ingredient); distance-bucket falloff
(i % 8 rule), frustum test, orientation cull; survivors compacted into the
ring's slab with workgroup-local atomics. Runs inside a new frame-graph pass
`ground-cover-compute` ordered after `world-page-visibility` — all compute
stays before the main pass (a mid-frame pass split costs a full MSAA
store+load).

### G-3 Blade rendering
One mesh per ring; base geometry encodes `(segment_t, side)`; a
`GroundCoverMaterialPlugin` on a PBRMaterial (house pattern — inherits sun,
IBL, cloud shadows, aerial perspective, guarded shadow wrapper) reads the
blade record by `instanceIndex`, evaluates the cubic Bézier (tilt/bend from
wind + per-blade phase against the shared `detailWind` uniform, Jahrmann
validation so blades never stretch), curves the normal across the width, and
**blends the shading normal toward the terrain normal past ~8 m** (specular AA)
while base colour comes from the tile's harmonised albedo (root 0.55×, tip
1.35× + clump tint) — the fade line has nothing to reveal. Far edge:
shrink-to-zero over the last 15% of R2, never dither. Blades cast no shadows
and are excluded from cascades entirely.

### G-4 Scatter-layer fixes (existing card system)
- Per-patch true terrain height + slope-aligned orientation (tilt ⊗ yaw, like
  rocks) at presentation build — kills floating/leaning-uphill patches.
- Fern/heather/reed keep the card path; grass-archetype patches retire where
  the blade system is active (profile-gated so tier 0 can keep patches only).
- Weed/flower sprinkle: a low-density card scatter (2 crossed quads, dome-ish
  up-normals) reusing existing layers, near-band only.
- New allocation rows: grass buffers (~4 MiB), domain tile (~3 MiB).

**Exit criteria.** In the viewer at 2 m: continuous believable meadow —
clumped, wind-swept, colour-continuous with the terrain at every distance; no
visible ring boundaries or pop while flying at 100 m/s at 3 m AGL; grass
vanishes by ~80 m AGL with no cliff. `ground-2m-lowsun` and the new shots pass
the strict gate on the reference host. Node: WGSL static scans, budget rows,
determinism (blade params pure in world position). GPU: compile+dispatch test
for both compute passes and the plugin.

---

## 6. Wave P — Perf closure & process

- **P-1 Capture shots.** Append (never insert) `grove-forest-2m` (in-forest
  ground camera, low sun — the money shot) and `grove-meadow-2m` (open
  grassland, sun behind). `ceilings: null` on first landing, promoted via the
  candidate flow.
- **P-2 A/B.** Full `perf:capture` on the reference host before (committed
  baseline) and after each wave; deltas judged per-shot GPU p95 + draws +
  triangles. The B-2 discipline: a wave that regresses the five core sub-30
  shots > 1 ms net gets its knobs turned before anything ships.
- **P-3 One sanctioned rebaseline** at the close (`perf:capture:candidate` →
  human review → promote), accepting intended vegetation pixels only.
- **P-4 Records.** ARCHITECTURE.md decision-log rows for: the core-inversion
  design (hull → interior core), the law re-derivation (near 350→180 m),
  the grass system's placement-is-pure-function contract, and the viewer
  mode's synthetic-state seam. Owners rows + boundary-test updates in the
  same commits as the files.
- **P-5 Governor.** Grass gate joins the GPU work ladder as a rung after
  `vegetationDistanceScale` (data field, min/max-combined).

---

## 7. Risks, ranked

1. **Card overdraw regresses the forest shots** (the exact failure that
   killed the 2-12 system). Mitigations: interior core pre-fills depth;
   cards are few and large (cluster sprays, not leaves); near band shrunk to
   180 m; card halfwidths and counts are the declared tuning knobs; fallback
   is `needDepthPrePass` on the card material (HZD depth-prime, off-the-shelf
   in Babylon) — and the hard floor is raising card size while cutting count.
2. **Draw-count creep** (3 parts × 2 bands × families × chunks). The model in
   `renderedDensity.ts` is updated first and the ceiling re-measured; if over,
   collapse core into the bark batch (same material family, both opaque —
   NOT the rejected crown/trunk merge, which crossed the opaque/alpha-test
   boundary; B-2's measurement is re-run regardless before shipping).
3. **Grass storage-fetch path fights Babylon.** De-risked by the verified
   `forcedInstanceCount` + plugin-storage-buffer path (GaussianSplatting does
   exactly this in-tree); fallback ladder: instanced `VertexBuffer` over the
   same `StorageBuffer` → CPU-built rings (still correct, smaller).
4. **Generation-time bloat** at tier 2/3 (70 prototypes). Amortised build +
   the estimator test cap it; worst case, tier 2/3 variant counts drop via
   their existing profile data.
5. **Viewer phase leaks into flight state.** The synthetic-state seam is
   additive (no change to sim/render contracts); Esc-path restore is tested
   manually against every phase gate; `npm run verify` catches type holes.
6. **Capture baselines churn mid-work.** Visual waves land behind the
   candidate flow; only P-3 rewrites `tests/perf/baseline/`.

---

## 8. Execution order

`V-1..4` → capture sanity → `T-1..2` (generator + meshing, Node-tested pure) →
`T-3..6` (atlas, runtime, impostor, shrubs) → capture A/B + tune → `G-1..4` →
capture A/B + tune → `P-1..5`. The viewer lands first because every later
judgment ("does this look real at 2 m?") is made inside it.

---

## 9. Implementation record (2026-08-27)

Waves V, T, and G landed (`5620cc6`, `9af949f`). Deviations from the plan
above, recorded per the working rules:

- **T-2 wind lanes deferred.** The plan put branch wind phase/flex in the
  prototype vertex-colour RG lanes. Deferred: vertex colours multiply PBR
  albedo when a colour buffer exists, so repurposing RG risks tinting; the
  existing three-band wind (trunk bend + branch flex + card flutter) reads
  acceptably on skeletal bark. Revisit only if captures show rigid limbs.
- **T-0 band structure kept at three bands.** Instead of a fourth "hero"
  band, near meshes the full skeleton and mid meshes the same skeleton
  decimated — the near/mid switch stays inside the existing band machinery
  (new card band code 4 only).
- **Law floors widened.** `renderedShareAtDistance` now applies the far
  floor through the MID band (the shrunken near radius otherwise inverted
  the density profile); floors 0.02/0.015 → 0.045/0.035.
- **G-1 domain tile is CPU-baked**, not a GPU pass over the terrain atlas:
  same consumer authority, no cross-system GPU wiring, NullEngine-testable,
  amortised at 1.5 ms/frame. The attribute channel reads the classifier at
  the reference day (species-stay-climatic); seasonal blade tinting is an
  open follow-up alongside the winter shed.
- **G-2/G-3 shipped the "no-compaction" rung deliberately**: every lattice
  lane writes its record every frame (blade or degenerate zero) — no
  atomics, counters, or indirect draws. The vertex-load estimator in
  `groundCoverLaw.ts` is the honest cost model and is test-pinned per tier.
  Compaction + indirect is the recorded next rung if capture numbers demand.
- **Two GPU landmines burned a debugging session** and are pinned in code
  comments: packed u32 blade fields must travel as `uint32x4` vertex
  attributes (float-attribute NaN canonicalization scrambled every packed
  lane while the float root positions arrived intact), and any plugin using
  `forcedInstanceCount` must force `INSTANCES`/`THIN_INSTANCES` off (the
  recorded 2-12-close discovery, hit again verbatim).
- **The teal-canopy chase (wave P), recorded because the first diagnosis was
  wrong:** noon captures showed sea-green crowns, worst on conifers. Cutting
  card specular (0.4) barely moved it — pixel statistics showed the cast was
  (a) albedo: spruce needles were authored at hue 0.42 and the dense conifer
  crown at 0.40 (literally teal before lighting), and (b) diffuse sky
  irradiance lifting shaded card faces' blue channel to ~0.8×green (terrain
  sits at ~0.64). Fix: conifer hues warmed to 0.30–0.33, broadleafs to
  0.275–0.285, `DETAIL_CROWN_ALBEDO` warmed, and `environmentIntensity`
  trimmed to 0.62 on card shell + interior core + impostor material (the
  impostor mirrors the card shell's full lighting response — roughness,
  specular, probe — per the handoff rule). Verified by pixel ratio: crown
  B/G 0.67 vs terrain 0.70, zero cyan pixels, all sun angles checked.
- **Known polish debt (open):** denser leaf-spray art (T-3) remains the
  main lever on canopy richness; ring width steps at blade-ring boundaries;
  the 4 m attribute-tile quantisation shows as density blocks near clearance
  edges; far-field forest→splat folding remains the recorded non-goal.
