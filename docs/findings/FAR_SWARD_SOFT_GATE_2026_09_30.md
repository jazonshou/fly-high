# A straight-edged patch at a shore: the far-sward gate, and its soft read (V-4, 2026-09-30)

Reported by the PM from a Cessna mid-course frame (world V4HYQQ, scenic, in the air, cockpit view): a faint, lighter,
smoother rectangle on the ground at a shore, with straight edges. Branch `jazonshou/far-sward-soft-gate` from
Fix-Cockpits 7fc2280. Step 1 (Node) is 9663f2e. Step 2 (GPU) is pending.

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
- soft: 7 (the same 3 and the four gate alphas);
- 10 only in a cell where a refused nearest texel sits beside an eligible one.

All are texel loads, with no new texture, sampler or atlas byte. These fragments are most of a cruise frame. **The Low
tier does not take the branch at all**: its two-material cap leaves `TERRAIN_SURFACE_THREE_MATERIALS` undefined, so the
far read compiles out for cheap and soft alike, and nothing here interacts with the Low-tier performance work.

**One build, three reads.** The read is chosen at runtime:
- `TerrainSurfacePlugin.setFarSwardRead`, through the defines `TERRAIN_FAR_SWARD_OFF` and `TERRAIN_FAR_SWARD_SOFT`,
  both declared in the constructor's define map;
- `FlightRendererOptions.terrainFarSwardRead`;
- `?farSward=off|cheap|soft` in the game (URL only, never saved);
- `VITE_PERF_FAR_SWARD` in the perf harness. The report records it as `farSwardRead`, and it is refused together with
  `VITE_PERF_REBASELINE`.

The default stays cheap until soft is priced.

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
- The soft read's load structure: four gate loads, and a second pair only behind a refused nearest texel.
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

## Step 2 (GPU): pending the PM's grant

1. The compile test above, with the soft define.
2. Price off, cheap and soft at cruise, 1080p medium. The bar is soft minus cheap at 0.10 ms GPU or less. If the
   7-load read misses it, try one `textureGather` of the four gate alphas (3 + 1) before the no-load fallback, a
   noise-mottled threshold.
3. One frame at `?seed=v4hyqq&farSward=soft`, and the same pose at cheap.
4. One soft-against-cheap capture on the same build, for the true list of shots that move, with per-shot deltas
   against the gates and no promotion.

Estimated before measuring, from each shot's height, pitch and view: soft changes pixels only within about ±64 m of an
eligible/refused line on level-5 and coarser pages, so in thin bands at least about 2 km out.
- **Likely to trip a gate:** coast-10km-lowsun, slant-10km, cruise-horizon, cruise-sun-30, high-10000ft-down,
  horizon-shadow-far-annulus, sunset-sunward, golden-hour.
- **Not expected to move:** the three night shots, and the ground and near shots.
