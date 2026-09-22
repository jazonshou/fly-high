# The 747's flight-deck glazing: the re-loft

2026-09-21 designed, 2026-09-22 built. Jason: *"getting the window shape
right"*. The opening was about 19 degrees tall where the type's is ~35, and the
panes lay high on the crown and too far aft.

**Built** in `src/render/webgpu/aircraft/airlinerGlazing.ts`, which sites each
pane by angle and casts it onto the nose as built; `AircraftBuildContext.skinPanel`
lays the glass on the skin; and one ring of `NOSE_SECTIONS` makes the brow. The
standing tests are `tests/render.airliner-glazing.test.ts`. The corner table below
is regenerated from the built meshes by `npx tsx scripts/airliner-glazing-table.mts`
(add `--json <path>` for the numbers).

## Frames

Two, deliberately, and confusing them is the trap that nearly cost a day:

- **Azimuths are AIRCRAFT-frame**, symmetric about the centreline, from a
  reference on it at the pilots' station **R = (29.9, 2.93, 0)**. A windscreen
  is symmetric about the aeroplane; the pillar is on the centreline. R is pinned
  in `airlinerGlazing.ts` (`FLIGHT_DECK_REFERENCE`), NOT read from the eye, so
  re-solving the eye does not move the glass.
- **Elevations and what the pilot sees are checked from the LEFT-SEAT eye
  E = (29.9, 2.93, -0.72)** (`catalogue.cockpitEye`), which the cockpit engineer
  re-solves.

The measurement that forced the distinction: the old centre post, which is ON
the centreline, subtended **az +17.3..+31.9 from E**. A spec of "a centre pillar
at az +-2.5" can only be in the aircraft frame.

## The design, as built

| pane | azimuth from R | elevation from R |
|---|---|---|
| No.1 | 2.5..24 | -18..+12 |
| No.2 | 26..54 | -15..+10 |
| No.3 | 56..75 | -12..+8 |

The centre pillar is +-2.5 degrees. Between panes, a 2-degree pillar is taken out
of the shared edge at 25 and 55. The centre post is a dark strip over +-1 degree
of the centre gap, cast the same way, so it lies on the skin at the glass's
height. A straight strut between two crown points sank 5 cm under the skin at
the 32.4 ring.

**How a pane is made.** Its window of sky is an 8 x 8 grid of sightlines from R.
Each sightline is cast onto the fuselage and nose lofts' own triangles, taking
the farthest crossing, since the body is a union and a ray from inside can cross
a buried cap first. The glass is laid there, 0.04 m out and 0.06 m in along the
skin's shading normal. Every triangle is wound by known geometry. A centroid test
cannot do it for a curved plate: the centroid of a pane that wraps a nose lies
beyond its inner face, and the inner face is the one the cockpit looks through.

**The brow.** The 31.4 ring's crown goes from 3.15 to 3.38, with the belly held
at -2.29. That is +0.14 m at x 31.0, +0.19 at 31.24 and +0.23 at 31.4, the
design's +0.12..+0.23. Nothing else in the airframe moved: mesh by mesh against
House-Keeping 500b80a, three of 93 meshes differ (the shell, the glazing and the
post), and the other 90 are bit-identical.

## The corner table (from the BUILT glazing)

The starboard side is shown. The port side is the z mirror to within **2.1 cm**,
not exactly, because the loft splits every quad on the same diagonal in index
order. That diagonal mirrors the other way on the port side, so the drawn skin
itself is 1.9 cm asymmetric, and the glass follows the skin as drawn. Body
metres: x forward, y up, z starboard.

    PANE ONE  (az 2.5..24, el -18..12)   outer face               inner face
      bottom inboard                  32.591  2.090  0.120     32.514  2.027  0.111
      bottom outboard                 32.073  2.186  0.981     32.013  2.135  0.920
      top outboard                    31.263  3.275  0.615     31.219  3.195  0.576
      top inboard                     31.512  3.303  0.072     31.461  3.217  0.066
      outer normal at centre: 39.7 deg above horizontal, 23.1 deg outboard

    PANE TWO  (az 26..54, el -15..10)
      bottom inboard                  31.918  2.357  0.998     31.860  2.303  0.936
      bottom outboard                 31.017  2.447  1.546     30.977  2.400  1.468
      top outboard                    30.648  3.182  1.037     30.621  3.104  0.981
      top inboard                     31.288  3.230  0.686     31.243  3.152  0.642
      outer normal at centre: 40.9 deg above horizontal, 66.0 deg outboard

    PANE THREE  (az 56..75, el -12..8)
      bottom inboard                  30.913  2.572  1.510     30.875  2.520  1.434
      bottom outboard                 30.361  2.582  1.711     30.334  2.527  1.632
      top outboard                    30.232  3.137  1.237     30.214  3.060  1.176
      top inboard                     30.632  3.142  1.092     30.604  3.065  1.034
      outer normal at centre: 41.1 deg above horizontal, 69.1 deg outboard

The group spans x 30.23..32.59. The old one spanned 29.1..31.35, reaching
**behind** the eye at 29.9.

**The glass stands off the skin by less than 4 cm in places.** Between grid
points the glass is a chord across the 28-segment nose's facet creases. Measured
at every cell centre, the outer face is 2.2 cm or more outside the skin and the
inner face 4.6 cm or more inside it.

## True opening heights

Through the outer faces only, in 0.05 degree steps. The rims are the frame, not
glass: a sightline through a pillar gap grazes them, and counting them as glass
closed the gaps up.

- **From R**, through each pane's centre azimuth: No.1 **30.25 degrees**
  (-17.30..12.95), No.2 25.35, No.3 20.25. The old No.1 was ~19.
- **From E at the horizon**, left to right: port No.3 -62.0..-33.1, pillar,
  port No.2 -30.6..-3.7, pillar, **port No.1 -1.8..+17.9**, centre post
  +17.9..+22.5, starboard No.1 22.5..41.1, No.2 42.8..65.3, No.3 66.8..79.8.
- **From E, through each pane's middle as the pilot sees it**: port No.1
  30.8 degrees (-17.3..13.5), port No.2 32.8, port No.3 34.2, starboard No.1
  26.8.

## The brow

The No.1 glass's top edge lands on the centreline at x 31.51, on the
windscreen's steep face: the crown there falls **1.08 m per metre (47 degrees)**.
The crest, the 31.4 ring, is 0.11 m aft of it and 0.12 m above the skin at the
glass's top. On the old ring, the same panes put their top at x 31.24 on the
roof, falling 0.40 per metre with no crest behind it. That was "the crown is
their ceiling". The glazing test holds the new numbers and runs the old ring as
its control.

### A criterion of mine was wrong, and why

The design sized the rise to put "the crown at +15 degrees from E" at the No.1
top station. **No crown can meet that.** A pane top cast at el +12 from R lands
on the local skin next to the centreline, so the crown at that station IS the
glass's top. Seen from E, 0.72 m to port, that point is always below +12. The
rise was sized with the top held at x 31.24, but a cast pane follows the raised
skin forward, to 31.51. What the crown rise actually buys is where the top lands:
on a face under a crest, not on the roof. The test measures that instead.

The earlier "+0.3 to +0.5 m" had its own fault: a roof-clearance test that cast
from an eye inside the body, which every ray exits, so it could not fail.

## Open: two things the design does not meet, and one for the eye

1. **The No.1 normal.** The target was ~35 degrees above horizontal and 10-15
   outboard; built, it is 39.7 up and 23.1 out, and No.2 and No.3 follow the
   skin's rake as agreed. It is the smooth round nose's rake. Sweeping the 32.4
   ring (crown 2.1..2.9, half-width 1.36..1.7) never moves it toward both
   targets at once: wider or taller turns it more outboard, narrower turns it
   more upward. Meeting it needs a flat, forward-facing windscreen face, which
   is a new nose design, not a tweak. (The sweep read the skin's shading normal,
   ~7 degrees steeper than the pane's own face, so only its trends carry over.)
2. **The No.1/No.2 pillar sits 1.8..3.7 degrees left of the pilot's
   straight-ahead line.** From E, the port No.1 spans -1.8..+17.9, so the pilot
   looks ahead through the outboard edge of their own No.1 pane, with the pillar
   just left of it. The glass is 1.6..2.7 m ahead of E; the old boxes were
   ~1.4 m. With azimuths from the centreline, a pillar at 25 degrees from R
   passes just outboard of an eye 0.72 m off the centreline. The remedy belongs
   to the eye (inboard and/or forward) or to the design (No.1 wider).
3. **The glass no longer covers the fuselage/radome crease.** The two lofts
   cross along x 29.0..29.9, and there the skins' normals differ by 32 degrees
   at the crown, 17 at 45 degrees round the section, and 7 low on the flank. It
   renders as a jagged shading line down the flank just aft of the new No.3.
   It is not new: nothing aft of the 30.4 ring moved. The old No.3 and No.2
   boxes, at x 29.1..30.85, sat over part of it. The fix is a tangent join: the
   radome carries the hump's section forward of ~28.5, or the fuselage ends
   inside it. That is a separate item.
4. **The eye re-solve** runs against this table. Five of the 27
   `render.cockpit-airliner` tests go red on the re-loft branch, by design: the
   kit's `AIRLINER_GLAZING` constants and four sightline checks were copied
   from the old boxes.

Pane names hold: `<side>-airliner-flight-deck-window-<one|two|three>`, six
panes. No eyebrow windows: a -400/-8 has none.
