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
| trainer, 2026-09-23 | 256² procedural | 36.5 |
| trainer, 2026-09-30 | 512² procedural | 73.0 |
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

## 512, and the panel lines drawn narrow (2026-09-30)

Branch `jazonshou/trainer-paint-512`, the PM's option A after a GPU survey of the 256 paint. Every edge on the
skin drew about a texel wide however sharp its ramp, so the widths were the texture's, not the renderer's.

**Take the frame's scale from the frame.** The survey first turned px into cm with a 75° horizontal lens at the
nominal distance. That was wrong on both counts:
- The capture parks the camera 6 m from the fuselage's axis, not from its skin.
- The chase lens is 62.4° horizontal (the chase frame records `cameraFovDegrees`), not 75°: 75° is the cockpit's.

The panel lines give the scale directly. Abeam at 6 m and 1080p, the lines at u 0.39, 0.63 and 0.84 sit at 531,
1001 and 1411 px, spaced in the map's 0.24 : 0.21. That is 1958 px per unit of u: 283.7 px/m, or 3.52 mm/px on
the skin. At 10 m it is about 1150 px per u, 6.0 mm/px. (The 0.011 m/px quoted above for 10 m does not match
this frame's lines.) The lens-based figures were 36 % wide. The widths in px were right.

The 256 paint, abeam at 6 m, 1080p, render scale 0.85, in px from the frames and in cm from the lines:

| edge | 6 m | 10 m | on the skin |
|---|---|---|---|
| livery, 10-90 % | 8.3 | 5.0 | 2.9 cm |
| a panel line's flank, 10-90 % | 11-12 | | 4.2 cm |
| the door line at half depth | 28 | 17 | 9.8 cm |

- **The renderer adds almost nothing to the line.** The CPU map's door line is 3.7 texels at half depth. At the
  frame's 7.65 px a texel that predicts 28.6 px at 6 m and 16.7 px at 10 m, as measured.
- **A render model agrees.** It uses the albedo, the cavity and the groove's normal, resampled and blurred, and
  fits the frame's profile to 4.9 levels rms with a blur of σ 1.4 px.
- **The livery's width splits into a texel term and a screen blur.** From the two distances: 1.06 texels, and
  2.1 px of screen blur at 10-90 %.

The dials, all trainer-only (`src/render/webgpu/aircraft/trainerVisual.ts`):

- **Edge 512.** 73.0 texels a metre along the body.
- **`liveryEdge: [0.069, 0.071]`.** A ramp of one texel at 512, as `[0.068, 0.072]` was at 256.
- **`panelEdge: [0.0006, 0.0036]`,** a new recipe dial (default `[0.004, 0.012]`).
  - It sets the lines' smoothstep. The door seam takes three quarters of it, as its default does.
  - The height map's groove is built from the same line, so the groove's shading narrows with it.
  - Omitted, the synthesis is byte-identical.

**The line's width is set by its gate, not by its texel count.** The PM asked for a line about 4 cm wide at half
depth, three texels at 512, with a band of 9 px or less abeam at 6 m. At the frame's true scale, 9 px is 3.2 cm,
and three texels render about 10.2 px at the door. So the line is 2.9 cm, two texels.

The line beads below two texels: its darkness and width vary row to row as it crosses the texels.

| body paint | door line at half depth | px at 6 m (predicted) | row-to-row darkness sd | width sd |
|---|---|---|---|---|
| 256, default line | 3.7 texels (9.9 cm) | 28 (measured) | 1.9 at the door, 3.9 at u 0.39 | 0.13-0.19 texel |
| 512, `[0.0009, 0.0049]` | 2.7 texels (3.6 cm) | 10.2 | 1.8 / 4.5 | 0.13-0.14 |
| 512, `[0.0006, 0.0036]`, shipped | 1.9 texels (2.7 cm) | 7.4 | 2.7 / 5.0 | 0.11-0.14 |
| 512, `[0.0005, 0.0025]` | 1.5 texels (2.0 cm) | 5.5 | 6.2 / 7.1 | 0.26-0.27 |

## Measured on the 512 maps

- **Panel lines at half depth.**
  - u 0.39: median 2.8 cm, worst 3.2.
  - The door (u 0.63): 2.7 cm, worst 2.9.
  - The default: 10.7 and 9.9 cm.
- **Grooves.** The span where the normal leans more than 0.1 along u is 5.5 cm (worst 6.8), against 16.4 cm for
  the default. The floor is the line plus a texel either side, since a central difference leans the texel beyond
  the slope.
  - The grooves' peak tilt is unchanged: 19° on the lines, 26° at the door.
  - With the default line at 512 the groove's slope halves (tilt p99 13.9° against 21.2° at 256); the narrower
    line restores it.
- **Livery edge, 10-90 % along the body.** Median 1.7 cm, worst 2.2 (4 cm at 256).
- **The livery's diagonal is straight.** Each row's half-way crossing, read linearly between texels, sits within
  0.16 texel of a fitted line (rms 0.115). That is 0.2 cm on the skin, against 0.4 cm at 256.
  - A ramp of a tenth of a texel snaps rows up to 0.46 texel off the line: a staircase.
  - The PM's ramp is the sharpest that stays straight.
- **The door line, row to row.** It moves at most 0.07 texel.
- **Normal-map tilt of the body paint.** p50 0.3°, p90 4.7°, p99 19.0°, against 0.7° / 11.6° / 21.2° at 256. The
  p90 falls because the grooves, which carry the tilt, cover a third of the area they did.

## Cost at 512

- **GPU memory: +9 MiB.** The trainer's three materials go from 3.0 to 12.0 MiB, three RGBA8 maps each with
  full mips.
- **Build time: +144 ms.** The three paints take 47.8 ms at 256 and 192.0 ms at 512 (Node, median of 7, host
  load 3.4). The PM's limit is +0.2 s.

## The frames at 512

The PM's GPU slot, abeam at 6 m and 10 m and the chase, at 1080p. Widths are in px, 10-90 % for edges; each
frame's scale comes from its own panel lines (1965-1975 px per u at 6 m, 1150-1154 at 10 m, in every frame).

- **Medium: 0.850 in both arms,** the P0 frames against 07dbc6c. This is the gates' pair.
- **High: 0.900 in both arms.** The 256 arm was re-captured at 4e5e62f, since P0's high frames came at 0.849.

| medium, scale 0.85 | 256 | 512 | gate |
|---|---|---|---|
| 6 m: the door line at half depth | 26.8 | 6.7 | 9 or less |
| 6 m: the line's flanks, left / right | 12.0 / 11.7 | 4.8 / 5.4 | 6.5 or less |
| 6 m: the livery edge, across it | 8.3 | 4.6 | 4.8 or less |
| 6 m: the livery diagonal off a straight line, rms / worst | 0.82 / 1.94 | 0.44 / 1.03 | |
| 10 m: the door line / its flanks | 15.5 / 7.0, 7.1 | 3.8 / 2.7, 3.1 | |
| 10 m: the livery edge | 5.3 | 3.0 | 3.3 or less |
| the chase: dips across the wing's top, flank / half depth | 3.1 / 4.6 | 2.6 / 4.5 | |

- **The high pair reads the same, within 0.1 px.** At 6 m: line 26.7 → 6.7, flanks 11.9 / 11.8 → 4.9 / 5.4, livery
  8.4 → 4.5, diagonal rms 0.81 → 0.42. At 10 m: line 15.4 → 3.8, livery 5.3 → 2.9.
- **The render scale barely moves the widths,** 0.85 against 0.90; the paint sets them.
- **The Node predictions held.** They were 7.4 px for the line at 6 m, 4.4-4.6 for the livery at 6 m and 3.1-3.2 at
  10 m.
- **The chase's high pair did not match** (0.95 and 1.0), and at 0.85 its wing-top detector finds few dips. So the
  chase is a look, not a gate.
- **Seen, not a gate: the door line now meanders.** It is the design's own warp, `u + broad × 0.012` on an 8-cell
  lattice: about ±4 cm over about 0.4 m round the body. The 10 cm band's centre averaged it away (1.5-1.8 cm peak to
  peak). The 2.9 cm line shows it at 3.2-3.3 cm, about its own width, as a slow wave most visible at 10 m.
  - It is smooth: row to row the line moves at most 0.07 texel.
  - Real panel lines are straight. A trainer-only warp dial would straighten them if that reads hand-drawn.

## Pins added (`tests/render.aircraft-paint-resolution.test.ts`)

- **Density.** 70 texels a metre or more.
- **Livery edge.** 2.5 cm or less.
- **The livery diagonal.** Straight within 0.2 texel.
- **Panel lines at u 0.39 and 0.63.**
  - Half depth: median 3.2 cm or less, worst 3.6.
  - Groove: median 6 cm or less, worst 7.5.
- **`withoutDials`** removes `panelEdge` too, so the legacy-64 hashes still hold.

Mutations, each run, each caught:

| mutation | caught by |
|---|---|
| the seam ignores `panelEdge` | the door line's width pin, the trainer's hash |
| the groove keeps the default line | both line pins, the trainer's hash |
| `panelEdge` ignored | both line pins, the trainer's hash |
| the default line moved to 0.0121 | the other airframes' hashes, the trainer's legacy-64 hash |
| the livery ramp a tenth of a texel | the diagonal pin, the trainer's hash |
| the edge back to 256 | density, livery edge, diagonal, both line pins, the hash |
| the three-texel line, `[0.0009, 0.0049]` | both line pins, the trainer's hash |
