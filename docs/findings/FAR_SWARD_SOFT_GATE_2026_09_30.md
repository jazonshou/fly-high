# A straight-edged patch at a shore: the far-sward gate, and its soft read (V-4, 2026-09-30)

Reported by the PM from a Cessna mid-course frame (world V4HYQQ, scenic, in the air, cockpit view): a faint, lighter,
smoother rectangle on the ground at a shore, with straight edges. Branch `jazonshou/far-sward-soft-gate` from
Fix-Cockpits 7fc2280. Step 1 (Node) is 9663f2e; step 2 (GPU, the PM's slot, 2026-09-30 03:14-03:44) is cb9eb1c.

## Where the patch is

**The frame gives render coordinates; the world gives the rest.**
- The HUD's world code is the seed in base 36 (`seedToString`): V4HYQQ is 1882008098.
- `createWorld` and `createSimulationSpawn` put the airborne spawn at (-9496, 21290).
- The floating origin snaps to 2048 m (`FLOATING_ORIGIN_GRID`), so render and world coordinates agree modulo 2048,
  and the frame's origin is (-10240, 20480). The aircraft is at world (-8600, 20039).
- Check: flying straight at the runway heading (145°) from the spawn predicts (-8615, 20027), within 20 m, and the
  frame's own attitude reads heading 148.6°.

**The patch is land, not water.** It lies on a peninsula 8-22 m above sea level, grassland, and the water to its west
is the sea.

**Its edges are on the world axes.** They were projected onto the ground using the frame's recorded camera and the
patch's own ground height (about 15 m):

| edge | world | nearest 128 m line | off by |
|---|---|---|---|
| A, frame x ≈ 205 | x -8579, over z 14888-15916 | -8576 = -67 × 128 | 3 m |
| C, frame x ≈ 262 | x -8454, at z 16206-16271 | -8448 = -66 × 128 | 6 m |

No natural boundary runs along the world axes. The patch's "top edge" (z ≈ 14870) is the peninsula's southern coast,
not an artefact.

## The grid, and the system that owns it

**The grid is the level-5 page's splat texels.**
- A page's channels are 128 texels a side (`WORLD_PAGE_CHANNEL_CORE`), and pages align to multiples of their extent.
- So a level-5 page (16 384 m) has 128 m texels on world multiples of 128. The patch sits in page (-1, 0).

**The system is the far-sward read** (`TERRAIN_FAR_SWARD_READ = 1`, "cheap", 2026-09-20's world LIVERY fix,
`docs/findings/GROUND_NEAR_FIELD_D.md` section 5). Level 5 is the first level whose page confidence falls under 0.1,
so its fragments take the zero-trust branch:
- The branch reads the NEAREST texel's top two materials.
- If both are swards (Grass, DryGrass, Shrub, or a negligible secondary), the fragment draws their mixture, mottled by
  W-1's patchwork.
- Any other pair (sand, forest floor, rock, gravel, snow, pavement) keeps the smooth Grass base.
- The switch is all or nothing, per texel, so a coast or a treeline becomes a straight 128 m line about 2 km out, and
  it follows the aeroplane.

GROUND_NEAR_FIELD_D.md had predicted exactly this: "stair-stepped outlines at 128-256 m… in dry hills they could; not
seen in the frames shot, and logged". This is the first frame to show it.

**The Node measurement.** The bake's CPU twin was run at each level-5 texel around the patch:
- four taps a quarter of a texel out, the classifier's weight vectors averaged and cut to the top four, from
  `sampleTerrain`'s drivers;
- then the gate.

The coastal column x [-8704, -8576) is Sand/DryGrass or Sand/Grass, and refused, from z 14848 to 16256. Its eastern
neighbour is DryGrass/Grass and eligible. North of z 15872 the refused region steps one column east, to -8448. Both
frame edges fall on those texel lines. The GPU bake reads the page's own channels, so a texel right on a class boundary
can differ from the twin.

## The soft read (step 1, 9663f2e)

`src/render/webgpu/terrain/FarSwardGate.ts`, each WGSL function beside its CPU twin:

1. **The bake stores each texel's gate** for both season buckets (bit 0 low, bit 1 high) in `splatWeightHi.a`.
   - It computes the gate from the 8-bit weights exactly as the fragment will decode them: lanes 0-2 quantised, lane 3
     the residual.
   - That lane was written but never read. Canopy closure is read from `splatWeightLo.a` only, by the vertex stage's
     corner taps and `terrainSurfaceCanopyClosure`, and nothing mixes the alpha lanes. The canopy pin now checks both.
2. **Where all four corners agree, the fragment returns the cheap read unchanged.** It loads the four corners' gates;
   when they are all eligible or all refused, both interiors are bit-identical to cheap.
3. **Between them, the gate is bilinear.**
   - The drawn pair is the nearest texel's, or, where that one is refused, the most-weighted eligible corner's.
   - The pair's weight moves toward Grass as the gate falls, in two layers and continuously. A pair holding Grass
     moves its own share. One without first folds its secondary into its primary, then trades the primary for Grass,
     so the upper id changes only where its weight is zero.
4. **Everything leaves at the cheap read's confidence, -1.** The Grass base is a refused pair, exactly as cheap hands
   over a refused texel, so the fragment body, its class strength and its third candidate are untouched.

**Loads on the zero-trust branch:**
- cheap: 3 (ids and both weight buckets);
- soft: the same 3, and ONE gather of the four corners' gate alphas (step 1 used four loads; see the price
  below);
- 3 more only in a cell where a refused nearest texel sits beside an eligible one.

No new texture, sampler or atlas byte: the gather uses the high weight bucket's existing sampler. It is taken at
the corners' shared point, (corner + 1) / edge, so the footprint is exactly the four corners whatever the sampler's
sub-texel precision, and mapped out of WGSL's (umin, vmax), (umax, vmax), (umax, vmin), (umin, vmin) order. These fragments are most of a cruise frame. **The Low
tier does not take the branch at all**: its two-material cap leaves `TERRAIN_SURFACE_THREE_MATERIALS` undefined, so the
far read compiles out for cheap and soft alike, and nothing here interacts with the Low-tier performance work.

**One build, three reads.** The read is chosen at runtime:
- `TerrainSurfacePlugin.setFarSwardRead`, through the defines `TERRAIN_FAR_SWARD_OFF` and `TERRAIN_FAR_SWARD_SOFT`,
  both declared in the constructor's define map;
- `FlightRendererOptions.terrainFarSwardRead`;
- `?farSward=off|cheap|soft` in the game (URL only, never saved);
- `VITE_PERF_FAR_SWARD` in the perf harness. The report records it as `farSwardRead`, and it is refused together with
  `VITE_PERF_REBASELINE`.

Soft is the default since step 2 (the PM's decision on the price below). Cheap and off stay selectable; the
step-1 four-load form of soft is gone, replaced by the gather.

## Pins (`tests/render.far-sward-soft-gate.test.ts`)

**At V4HYQQ, on the bake's twin.** The table gives the largest change between samples 0.5 m apart across each edge's
band (±120 m, texel centre to texel centre), in 8-bit sRGB levels of the drawn material mixture's reference albedo:

| crossing | cheap | soft |
|---|---|---|
| x = -8576 at z 15000 | 25.7 | 0.12 |
| x = -8448 at z 16240 | 18.4 | 0.08 |

Cheap is the positive control, pinned above 4. Soft is pinned at 1 or less.

**Also pinned:**
- Soft is bit-identical to cheap where all four texels are eligible (LIVERY's dry pairs, a negligible Dry/Sand pair
  among them) and where all four are refused, over 28 fractions.
- The season bits, and the gate on the quantised weights: a near-tie that flips the pair when decoded.
- The soft read's load structure: one gather of the four gates at their shared point, in WGSL's corner order, and a
  second pair only behind a refused nearest texel.
- `tests/gpu/terrain-surface-compile.test.ts` compiles the CDLOD + page-channel path once per read (cheap, soft, off)
  and checks the compiled source for the read the dial asked for, and only that one. It runs on the GPU in step 2.

Mutations, each run, each caught:

| mutation | caught by |
|---|---|
| the gate taken from the nearest corner only | both crossings |
| no search for an eligible corner | both crossings |
| a Grass secondary's share scaled the wrong way | the -8576 crossing, the continuity pin |
| no interior shortcut | both bit-identity pins |
| the season bits swapped | the season pin |
| the gate on the bake's unquantised weights | the quantised-gate pin |
| the bake keeping canopy in the high alpha | the bake pin, both canopy pins |

## Not in scope: the step between two eligible texels

Between two ELIGIBLE texels whose pairs differ, cheap and soft both switch the pair at the nearest texel. That is the
pair read's own limit, not the gate's. At V4HYQQ, Grass/DryGrass 0.50 against DryGrass/Grass 0.40 at x -8192 is 3.9
levels. Removing it needs a bilinear pair read (the 12-load gather) or GROUND_NEAR_FIELD_D's biome-tone map. It is out
of V-4's scope by the PM's ruling, and recorded here.

## Step 2 (GPU, the PM's slot, 2026-09-30)

Host load average 3.6 at the start, 2.3-4.4 while pricing, 2.3-3.0 during the full captures, 2.5 at the end.

**Compile.** `tests/gpu/terrain-surface-compile.test.ts` passes 9 of 9, with the CDLOD + page-channel path compiled
for cheap, soft and off. Each compiled source holds only its own read, with no GPU errors. It passes again after the
gather change.

**Price.** cruise-horizon at 1920 × 1080, medium (render scale 0.86), `VITE_PERF_GPU_TIMING=1`, one build, rounds of
12 interleaved runs. The figure is the median of the main pass's GPU milliseconds. Three runs of 24 read 1.4-1.7 ms,
the known per-pass timing drop-out, and are excluded.

| read | off | cheap | soft | soft - cheap |
|---|---|---|---|---|
| soft by four loads | 4.94 | 5.11 | 5.25 | +0.14 (misses the 0.10 bar) |
| soft by one gather | 4.92 | 5.21 | 5.23 | +0.016 (cheap 5.06-5.28, soft 5.19-5.25) |

The gather passes, so the no-load fallback was not needed.

**OPEN: wall-clock frame time disagrees, unexplained.**
- The fps medians were cheap 88.3 and soft 86.8: +0.19 ms a frame, the same run to run. The four-load round gave
  +0.245.
- This host is not GPU-bound: a frame is about 11.4 ms against about 5.9 ms of GPU work. The main pass moves 0.016 ms,
  so these numbers cannot attribute the difference to it.
- What would settle it: first a cheap-against-cheap A/A on the same harness and shot, to find the fps floor between
  identical arms. Then, if the difference outlives that floor, a per-pass breakdown of soft against cheap.
- It was not run. It would not change the decision: the Low tier compiles the branch out, and the defect showed from
  every cruise.

On the same runs cheap costs +0.17 and +0.29 ms of GPU over off, its own price, now recorded in GROUND_NEAR_FIELD_D.

**Frames.** Taken at `?seed=v4hyqq`, with the camera parked at the mid-course frame's recorded camera: render
position (1640.00, 951.02, -441.98), the aircraft's attitude, a 75° horizontal lens. The simulation was paused 16 s
in, under the same 2048 m origin, at medium quality and render scale 0.850 in both arms.
- The cheap frame reproduces the reported rectangle exactly.
- In the soft frame the coastal strip fades into the mottled ground with no straight edge.
- The whole-frame difference is 11 031 pixels over 3/255, the largest 33. All of it lies in thin bands along
  coastlines (the patch, the inlet's shore, distant coasts near the horizon), except animated sea foam, which moves
  between any two captures.

**The shots that move.** The full canonical capture was taken once per arm on one build (`VITE_PERF_FAR_SWARD`,
unpinned host), with no promotion and no baseline written.
- Both arms pass every gate on all 39 shots: SSIM, RGB, lower-frame and worst-tile, against the committed baselines.
- Arm to arm (`scripts/perf-arm-compare.mts`), lake-island-piercing is bit-identical and 38 shots move, all in thin
  bands:
  - cruise-horizon 4.2 % of pixels (largest 25/255);
  - high-10000ft-down 3.0 %;
  - cruise-sun-30 2.6 %;
  - slant-10km 1.8 % (largest 26/255);
  - forest-500ft-sunbehind 1.4 %;
  - the rest 0.1-1.1 %, and seven under 0.1 %.
- canopy-1200ft, grove-forest-2m and veg-seam-near-500ft moved by 2/255 or less on under 0.01 % of pixels. Only a
  cheap-against-cheap control could say whether that is noise.
- The largest SSIM drop, soft against cheap, is -0.0032 on high-10000ft-down's worst tile (gate 0.72). Whole-frame SSIM
  moves by 0.0004 at most.
- The tightest soft margin anywhere is +0.0094 (forest-500ft-sunbehind, whole-frame SSIM against 0.985), the same as
  cheap's.

The estimate made before measuring, about eight gate trips, was too pessimistic: none trip.

**Decided (the PM, 2026-09-30): soft ships as the default, and NO baseline is promoted.** Both arms pass every gate on
all 39 shots, so the committed baselines stand.

The five largest movers, soft against cheap:

| shot | pixels changed | largest change |
|---|---|---|
| cruise-horizon | 4.2 % | 25/255 |
| high-10000ft-down | 3.0 % | 11/255 |
| cruise-sun-30 | 2.6 % | 19/255 |
| slant-10km | 1.8 % | 26/255 |
| forest-500ft-sunbehind | 1.4 % | 14/255 |

The tightest margin to any gate under soft is +0.0094 (forest-500ft-sunbehind, whole-frame SSIM against 0.985), the
same as cheap's. The largest SSIM drop is -0.0032 on high-10000ft-down's worst tile (gate 0.72).
