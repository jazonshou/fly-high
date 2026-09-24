# The trainer's skin read blurry: three causes, one of them a trap (2026-09-23)

Jason, 2026-09-23: the outside of the trainer looks blurry. Branch `jazonshou/trainer-skin-256`.

## What the paint puts on the body

The trainer has no livery image. Its three paint materials (body, the cockpit's cowl stand-in, accent) are
procedural. Until now each was one 64-texel map laid over the WHOLE fuselage loft: u runs along the 6.9 m body,
v round its circumference. Texels a metre along the body, measured as the median of |du/dx| over the
fuselage's triangles times the albedo's width (`tests/render.aircraft-paint-resolution.test.ts`):

| airframe | albedo | texels / m along the body |
|---|---|---|
| trainer, before | 64² procedural | 9.1 |
| trainer, now | 256² procedural | 36.5 |
| Global (bizjet) | 1024 × 256 livery | 29.7 |
| 747 (airliner) | 2048 × 512 livery | 33.4 |
| jet | 64² procedural | 5.5 |

At a 10 m chase and 720p, a 64-texel trainer texel is magnified to about 6.5 px. The GPU samples mip 0 there,
so no mip or LOD bias can sharpen it.

## The frames

Starboard flank at 10 m, aimed at the cabin door (x = 1.0 m), 1280×720 and 1920×1080 at DPR 1. Baseline was
72c8edb; the plain 256² patch was f355a31, before the dials below.

- **The render scale is adaptive.** Only the 1080p pairs matched: 0.850 / 0.850 at Medium, 0.950 / 0.950 at
  High. The 720p pairs did not (0.859 vs 0.809, and 0.950 vs 0.849). Jason's Firefox GPU helper was at
  24-40 % of a core during the patch arm and 0-12 % during the base arm, and the game page lowered its scale
  under that load.
- **High never reached scale 1** (0.85-0.95). A true scale-1 pair needs the perf harness's
  `pinnedRenderScale`, not the game page.
- **Only compare frames whose recorded render scales match.** The mean luminance gradient was no measure of
  blur: the Global's smooth livery scored below the blurry trainer. The edge widths below are the figures
  that count.

## Three causes

1. **Density.** At 256 the grain, the rivet rows and the seam lines resolve; at 64 they were one wash.
2. **The green livery edge is soft by design.** The synthesis drew the band's edge as
   `smoothstep(0.055, 0.085)` in its own coordinate: 0.03 of the body, a 0.21 m ramp, whatever the texel
   count. At 1080p and 10 m (0.011 m/px) its 10-90 % width was 27 px at 64 and still 20 px with 256 texels.
   The Global's gold stripe edge in the same framing is 5-11 px.
3. **At 256 the paint drew a different design: the "totem pole" seam.** This is the trap. The synthesis
   indexed its noise in TEXELS:
   - Grain was `hash2(x, y)`.
   - The panel lines' jitter was `hash2(x >> 3, y >> 3)`, 8-texel blocks, each shifting its line by up to
     ±0.006 u (±4 cm).
   - A rivet was whichever texels fell in a band ±0.012 u across its line.

   At 64 a jitter block is 0.86 m × 0.41 m and the bilinear magnification smears it. At 256 it is
   0.21 m × 0.10 m: the lines step sideways every 10 cm round the body, and the rivets become dashes across
   the lines. At the door this read as a stack of dark blobs, not a seam. The same stepping is in the CPU
   maps themselves, so it is the synthesis, not the GPU.

## The change

`paintMaterial` takes an `edge` and records it in the material's metadata (`aircraftPaintEdge`). The trainer's
three materials paint at 256, with two recipe dials. Both are trainer-only; omitted, the synthesis is
byte-identical.

- **`noiseLattice: 64`.** Every noise term is smooth value noise on a 64-cell UV lattice, with nodes at the
  texel centres of a 64-texel map. A 64-texel map samples exactly `hash2(x, y)`; a 256-texel one draws the
  same values with smoothstep-weighted bilinear between them.
  - The jitter uses a lattice an eighth as fine and the filler mottling one half as fine. Rivets are domes
    about a cell across.
  - The lattices are precomputed per map. Sampling hashes per texel cost 96 ms a material; precomputed, it
    is 15.5.
- **`liveryEdge: [0.068, 0.072]`.** 0.004 of the body is 2.8 cm, about a texel at 256.

**The relief slope stays per texel (the second trap).** It is tempting to take the height-to-normal slope per
lattice cell (× edge / lattice) so that relief keeps its per-cell slope. But the relief that shows (lines and
rivets) is about a texel wide at 64 and a few texels at 256, so the per-texel slopes already match. Scaled,
the 256 map's tilt p90 was 39°. Normal-map tilt of the body paint (p50 / p90 / p99):

| body paint | p50 | p90 | p99 |
|---|---|---|---|
| 64, as shipped (bilinear to 256) | 1.6° | 12.8° | 19.4° |
| 256, texel-indexed | 1.7° | 15.7° | 28.9° |
| 256 with the dials | 0.7° | 11.5° | 21.1° |
| 256 with the dials, slope × edge / lattice | 2.9° | 39.1° | 57.1° |

## Measured on the CPU maps

- Livery edge, 10-90 %, along the body: median 3.4 cm, worst 4.4 cm. With the default ramp it is 0.13 m.
- The panel line at u 0.63, row to row: at most 0.08 texel over 95 rows. Texel-indexed at 256, it jumps up to
  3 texels every 8 rows.

## The frames with the dials (7f185ed)

Same framing, served from 7f185ed. Only the Medium 1080p pair matched the baseline's render scale
(0.850 / 0.850). High came back at 0.900 twice, against the baseline's 0.950, even with Firefox's helper at
0 %, so the High pair is not compared.

- **Livery edge, 10-90 % across the green band's edge** (Medium 1080p, 10 m, px):

  | build | px |
  |---|---|
  | 72c8edb, 64² | 21-28 |
  | f355a31, 256² texel-indexed | 19-20 |
  | 7f185ed, 256² with the dials | 4-7 |
  | Global's gold stripe, for reference | 5-11 |

- **The door seam** is one straight dark line: no stepping, no rivet ladder. It is the design's panel line
  drawn sharp: 0.012 of the body each side, about 8 cm on the trainer, so it reads as a strip about 10 cm
  wide. Real panel lines are narrower. A trainer-only width dial on the line's smoothstep would be the next
  step if that reads heavy.
- **The grain** is the 64 design's, smooth between lattice nodes. The texel-indexed 256 map's speckle is gone.

## Cost

- **GPU memory: +2.8 MiB.** Each material has three RGBA8 maps with full mip chains: 1.00 MiB at 256 against
  0.06 MiB at 64.
- **Build time.** Per material, median of 15 in Node, host load about 6 on 10 cores:
  - 1.3 ms at 64;
  - 11.1 ms at 256 texel-indexed;
  - 15.5 ms at 256 with the dials.

  That is about +42 ms for the trainer's three.
- **In the page, the plain 256 patch** measured 10.0-12.7 ms a material against 1.4-2.9 ms at 64.

## Pins (`tests/render.aircraft-paint-resolution.test.ts`)

- **Byte-identical paint.** Every airframe's paint set is re-synthesised from its recorded recipe and edge,
  and hashed over all three mip chains.
  - The jet, the Global and the 747 match hashes taken on b4f89bd.
  - The trainer's own three recipes at 64, with both dials removed, match b4f89bd's.
- **Density.** The trainer is at 30 texels a metre or more along the body; the other three are pinned at the
  table's values.
- **Livery edge.** 5 cm or less on the body.
- **Panel lines.** No row moves the line at u 0.63 half a texel or more.
- **`tests/gpu/mip-chain-upload.test.ts`** asserts that the recorded edge is the built albedo's width before
  re-synthesising against it.

Mutations, each run, each caught:

| mutation | caught by |
|---|---|
| the trainer's edge back to 64 | the density pin, the livery-edge pin, the trainer's hash |
| `liveryEdge` removed | the livery-edge pin, the trainer's hash |
| `noiseLattice` removed | the panel-line pin, the trainer's hash |
| the default ramp moved to 0.056 | the other airframes' hashes, the trainer's legacy-64 hash |
| legacy noise routed through the lattice | the same four |
