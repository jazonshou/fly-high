# The F-16's speed brakes had nothing to lie on

Jason: *"The speed brakes at the back of the F-16 also feel out of place with
respect to the plane."*

They were four boxes floating near the tail. Measured at their own height the
fuselage skin is 0.410 half-width at x −5.7, while the panels' outboard edge sat
at 0.640 — so each stood **230 mm outboard of the aeroplane**, with its inboard
edge **290 mm buried inside it**, and all four reached **50 mm past the tail**
into the nozzle. The lower pair also intersected the stabilators.

There was nothing to conform them to. The loft carries the body round to the
nozzle as an oval, and an airbrake needs something flat.

## The repair

A **flat-topped shelf each side**, between the nozzle and the stabilator roots,
squaring off the boat-tail — which is the structure the aeroplane has. Its outer
face runs from z 0.62 at x −4.3, where the body is 0.645 wide and the face is
still inside the skin, to z 0.50 at x −6.5 where the two are flush. The four
petals lie on the shelf's roof and floor.

| | before | after |
|---|---|---|
| stand-off from the surface | 230 mm outboard, 290 mm buried | **12.0 mm proud**, every vertex with shelf beneath it |
| tail overhang | 50 mm PAST the fuselage, into the nozzle | **50 mm clear** |
| enclosed by other structure | lower pair inside the stabilators | **0 of 38,880 samples**, all nine brake × elevator poses |

## Three failures, each caught by an instrument

**1. An `atan2` whose terms ran opposite ways.** `SHELF_TILT` was written
`atan2(dz, SHELF_AFT_X − SHELF_FORWARD_X)`. The x term is negative while the z
term is positive, so it returned **177 degrees instead of 3**, and every panel
hung off it was spun very nearly end-for-end — they came out *ahead* of their own
hinge, from −5.75 forward to −5.05 instead of aft to −6.45. Arithmetically
self-consistent, invisible in every number being printed, and obvious the moment
a bounding box was printed instead.

**2. The axis gate found the real one.** The petals were built as vertical
plates on the shelf's *side*, which puts their forward edge along Y while
`rotation.z` — the one angle `update` drives, with two senses — turns them about
Z. `render.swept-flap-hinge` reported *"starboard-speed-brake turns about an axis
90.00 deg off its own hinge line"*, to the degree. This is the gate that was
extended that same day to cover speed brakes at all, after it was found that its
pose never pulled the brake; it found a defect in the first airframe it was
pointed at. A panel hinged at its forward edge must turn about **that edge**, so
the edge has to run in Z: chord in x, span outboard in z, lying flat.

**3. Three clearance instruments disagreed until a fourth settled it.**

| instrument | verdict | why it was wrong |
|---|---|---|
| axis-aligned bounding boxes | 88 mm interpenetration | a swept stabilator's box spans three metres of span |
| `intersectsMesh(precise)` | TOUCHING | it is an *oriented box* test, not a triangle test — it said so from 119 mm away |
| minimum vertex-to-vertex distance | 119 mm clear | **overstates** the gap: two surfaces cross between their vertices |
| ray-parity containment | **28 of 4,320 samples enclosed** | a point inside a closed mesh has an odd number of faces between it and infinity |

The parity test carries its own positive control — the stabilator's own centroid
must read *inside*, or the run is void.

## The forward sweep, and how the chord was recovered

Moving the hinge to −5.90 fixed the breach retracted and **not deployed**. A
panel turns about the node's z axis, but that first version spanned 0.335 m in
Y, so its far edge swept **forward** by |y|·sin θ as it opened — 211 mm at full
deflection, straight back into the tailplane. That forced the hinge to −6.10 and
left a 0.40 m brake on an aeroplane whose brakes are twice that.

The sweep was an artefact of the panel being *vertical*. Laid flat on the shelf,
the panel sits **on** its own rotation axis and sweeps forward by half a
thickness — 16 mm. That freed the hinge, and the remaining conflict was solved in
**span** rather than in x: ending the panel at z 0.43, inboard of the
stabilator's root rib at 0.437, removes the overlap entirely. The hinge is then
set by the **ventral strake** (which reaches x −5.80) rather than the tailplane,
giving 0.65 m of chord at x −5.85.

## Known inaccuracies

- **The petals are 0.65 m, not the ~0.9 m the real aeroplane has proportionally,
  and they are narrower in span (0.23 m).** Both are set by what is available:
  the stabilator's root rib at z 0.437 caps the span, and the ventral strake at
  x −5.80 caps the chord.
- **The shelves stop at the fuselage's end (x −6.5).** On the real aeroplane the
  brake fairings run aft *alongside* the nozzle. That was attempted and set
  aside: the nozzle is 0.568 radius at x −6.6, **wider** than the shelf's 0.50
  outer face there, so continuing a constant-height slab aft would bury it in the
  nozzle. A fairing beside the nozzle needs a tapered loft with a concave inboard
  face, which is a larger piece of work than this pass.
- The brakes are 12 mm proud rather than flush, deliberately, so the two surfaces
  cannot fight in the depth buffer.

## Instruments

`scripts/airbrake-frames.mts` — chase, rear three-quarter and directly-astern
frames of the shipped page, closed / half / full. The deflection in each caption
is **measured**, as the rotation of the hinge node between its rest pose and that
frame, read off its world matrix as `acos((trace−1)/2)` — the same quantity the
axis gate measures, and independent of how the panel is modelled. A frame whose
measurement disagrees with its caption by more than a degree fails the run.

One trap it walked into first: the node filter `/speed-brake$/` matches
`lower-speed-brake` too, so holding all four to one angle swung the lower pair
**up** and the frames showed an arrangement the game never renders. The hold now
applies each petal's own sense.
