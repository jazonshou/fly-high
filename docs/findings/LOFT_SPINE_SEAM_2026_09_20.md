# Every lofted body was shaded as two surfaces

Found while answering a question about something else. Jason's complaint about
the 747 — *"the lines on the aircraft seem all disjointed"* — was traced to a
UV-space livery band and fixed. Measuring the fuselage section afterwards to
confirm the hump crease had gone turned up a second, unrelated line: a
**14–21 degree normal discontinuity down the top centreline of every lofted
body in the game**.

It was not introduced by the 747 work. Three of the four airframes that have it
were never touched by that pass.

## What it is

`loft()` repeats its first radial vertex at the end of every section. It has to:
the UV runs 0..1 round the section and one vertex cannot carry two texture
coordinates. The two vertices are at the same point in space, but
`VertexData.ComputeNormals` only ever sees each one's OWN triangles — the faces
on one side of the seam for one, the other side for the other — so it writes
them different normals.

The surface is continuous. The shading is not.

This is invisible in a wireframe, invisible in a silhouette, and invisible from
any angle where the spine is edge-on. It shows as a line down the middle of the
top surface, and only when the light is low enough for the two sides to return
different amounts of it — which is to say, exactly in the chase camera at
golden hour, looking down at the most-viewed surface on the aeroplane.

## The measurement, and why it needs a control

The angle between the normal one degree to port of the centreline and one
degree to starboard.

**A bare seam number cannot be read.** Across two degrees of a round section the
normal turns two degrees whatever the mesh does, so zero is not the target. The
control is the same measurement 45 degrees round, where there is no seam.

| airframe | seam, before → after | excess over control, before → after |
|---|---|---|
| 747-8    | 20.81 → 4.14 | 19.84 → 3.19 |
| F-16     | 18.18 → 1.36 | 16.75 → 0.00 |
| Cessna   | 11.13 → 2.97 |  8.70 → 0.53 |
| Global   |  8.78 → 2.15 |  6.78 → 0.16 |

**The positive control is the keel.** The ring closes at the CROWN: `angle`
starts at 0, where the superellipse is (yShape 1, zShape 0). The keel at angle
pi is an ordinary single vertex, and with an odd segment count there is no
vertex there at all. So the bottom centreline should read the same before and
after — and it does, on all four, to the digit: 2.76 / 2.15 / 2.00 / 1.72.

## Why the 747 keeps 3.19 degrees

Because it is an egg, not because it still has a seam. Two candidates were
separated:

**Not `mergeStatic`.** The 747 is the only airframe whose fuselage is merged
(`airliner-fuselage-shell`). Reading that merged mesh and grouping vertices by
position: 21 coincident groups, all 21 holding ONE normal, worst disagreement
0.000 degrees. The weld survives the merge.

> **The quantisation is load-bearing.** Group by EXACT position and this test
> finds nothing, reports "0 disagreeing groups" and appears to pass — while
> having looked at nothing at all. The ring's two crown vertices sit about
> 3e-16 apart in z, because `Math.sin(2 * Math.PI)` returns -2.4e-16 rather
> than zero. Keys are quantised to a micrometre. The same trap is in the unit
> test, where `toBe` on the two positions fails and `toBeCloseTo(..., 9)` is
> correct.

**It is the crown taper.** `crownZRadius` is set only from x = 0 forward; aft of
that the 747's sections are plain circles, which gives a control group inside
the same airframe:

| section | stations | excess |
|---|---|---|
| plain circle | x = −24, −20, −14, −10, −6 | −0.09, −0.12, −0.12, −0.12, −0.12 |
| egg | x = 0, 9, 17, 22, 26, 27, 28 | −0.05, 1.11, 2.83, 3.12, 3.15, 3.19, 3.09 |

Flat wherever the section is circular, rising monotonically wherever it is not
— and tracking the taper RATIO rather than the station. `crownZRadius/zRadius`
at those same stations runs 0.994 / 0.905 / 0.815 / 0.803 / 0.800 / 0.800, in
the same order. At x = 0, where the crown is tapered by six parts in a thousand,
the excess is indistinguishable from the circular stations.

A crown that leans in has a smaller radius of curvature, so its normal genuinely
turns more across the same two degrees of ray angle. The 45-degree control is
simply the wrong yardstick on a section that is tighter at the crown than on the
flank. **The 747 would read 3.19 on a mathematically perfect surface with no
seam in it.**

## Which builders share the pattern

- **`loft()`** — duplicates at the crown, surface smooth across it. **Fixed.**
- **`airfoilWing()`** — duplicates at the leading and trailing edges,
  **deliberately**: a trailing edge IS a crease and averaging across it would
  round off the one edge the shape depends on. Asserted to still differ.
- **`radialBlurDisc()`** — duplicates exactly as `loft` does, but is flat, so
  its seam normals already agree. Asserted. One exception: its degenerate
  centre ring, where all twenty-five vertices sit on the axis and the normals
  are undefined rather than wrong.
- **`planform()` / `verticalProfile()`** — wrap the outline with `% count`.
  No duplicates at all.
- **`conformedPanels()`** — rim meant to be sharp, no shared positions.
- **`box` / `cylinder` / `sphere` / `torus` / `strutBetween`** — Babylon's own
  builders; `vertexMesh` never sees them.

## What did not change

Positions-and-indices digests, hashed apart from normals, are bit-identical
across the change on all four airframes — `cc9d14d5` / `35f03ce5` / `9871642d` /
`10dd7ee9`, computed on 192ec3b and again afterwards rather than merely pinned.
In the 747's draw-budget census exactly four numbers move, and they are the four
normal terms.

## A note on the frames

The eight top-down captures are illustrative, not decisive. Two problems worth
knowing about before anyone leans on them:

1. The 747 and Global pairs are well lit (centre luminance 64–69 of 255); the
   F-16 and Cessna came out at 35 and 46 because the low sun was behind them on
   the heading they happened to be flying. Both members of each pair are lit
   the same, so each pair remains a fair comparison, but the seam is not
   legible in the darker two.
2. Before and after are separate runs of a moving aeroplane, so they are at
   different headings over different terrain. A tonal split is visible down the
   747's spine in the before frame and absent in the after, which is what the
   numbers say — but the pair is not a controlled A/B and should not be
   presented as one.

The measurements above are the evidence.
