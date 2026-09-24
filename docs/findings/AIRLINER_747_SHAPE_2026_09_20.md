# The 747-8's shape: what was wrong, what is fixed, and what is still not a 747

Jason, on seeing the aeroplane: *"I'm a bit disappointed with the 747 right now.
The second level looks like it's a cylinder combined with the rest of the body.
And the lines on the aircraft seem all disjointed. Please make sure these
details are fixed. Remember — details are what matters. The spoilers are also
out of place."*

Three complaints, three separate defects. All three are fixed. The last section
is the part that is easy to leave out: what is still not accurate.

---

## 1. "A cylinder combined with the rest of the body"

It was exactly that. The raised upper deck was a SECOND closed loft intersecting
the fuselage loft, and two intersecting closed surfaces cannot be tangent-
continuous. The airframe's own comment recorded the trade: a 41-degree crease
widened to a 31-degree one. Measured at three stations along the deck, the
surface broke by **23.5, 30.1 and 38.0 degrees**.

The repair was to give a loft section a second width. `LoftSection.crownZRadius`
lets a section be an EGG rather than an ellipse — widest at the main-deck floor,
narrower at the crown — which is what a wide-body's forward fuselage actually
is, and which a superellipse cannot say because `zRadius` applies equally above
and below the centre. The hump is now part of the one fuselage loft. The same
three stations read **1.4, 1.5 and 1.5 degrees**.

Two things were pinned rather than asserted, because a new field on a shared
builder must not move anything that does not ask for it:

- it is the IDENTITY when unused — checked against the superellipse formula
  recomputed independently, vertex by vertex, and against pinned geometry
  digests of the three airframes this pass does not touch;
- it is C1 AT THE WATERLINE — the ramp is a smoothstep, not linear, because a
  linear ramp would remove a crease at the crown by adding one at the equator.

Both checks were shown to bite at a crown radius of 0.999 before being trusted.

A first attempt raised the crown evenly from the wing to the flight deck. The
crease went and so did the hump: a 747's upper deck is a raised DECK, so the
crown climbs behind the wing, runs flat the length of the deck, and fairs down.
An even climb is a bulge. The shipped stations give 5 mm/m at the wing, 87 at
the steep part, then 17 and 2 over the deck itself, where it is level to the eye.

## 2. "The lines on the aircraft seem all disjointed"

They were drawn in each mesh's own UV space. `livery-decal` painted the band at
`fract(u - 0.37v + 0.18)`, and since every mesh carries its own 0..1 UV tile,
the band restarted at every panel — a blue dash across the fuselage at one
angle, another across each wing panel at another, thirty of them, none meeting
its neighbour. **No cheatline in UV space can cross a mesh join**; it is not a
tuning problem.

The band is retired airframe-wide (`liveryColor` set equal to `baseColor`) and
replaced with a navy cheatline painted in **body coordinates** as vertex colour,
at the main-deck window line, on the fuselage and the radome together. It is one
continuous line across the radome/fuselage join because both meshes are asked
the same question about the same body x, y and z.

## 3. "The spoilers are also out of place"

Built as axis-aligned boxes seated at ONE station's skin height. Measured
retracted, per panel, closest corner and worst corner:

| panel | closest approach | worst proud |
|------:|-----------------:|------------:|
| one   | 288 mm           | 583 mm      |
| two   | 241 mm           | 506 mm      |
| three | 84 mm            | 273 mm      |
| four  | 63 mm            | 250 mm      |
| five  | 44 mm            | 226 mm      |

Never touching the wing at all, and the error shrinking monotonically outboard —
which is the giveaway. It was the wing's dihedral being read off a single
station.

A box cannot lie in this surface. Over a 2.9 m panel the skin moves by the
dihedral, by the taper and by the thickness law, and no single height is right
at more than one corner. Each panel is now a grid whose every vertex is placed
at ITS OWN station and chord fraction. Measured the same way afterwards:
**12.2–13.0 mm proud on all twelve panels, both wings** — the 12 mm they are
deliberately raised to stay out of a depth fight, plus up to 1.0 mm of the
wing's own chordwise faceting.

Both edges are fixed CHORD FRACTIONS rather than a chord in metres, and that is
what makes it work. Within one wing panel the leading edge, the trailing edge
and the chord plane are each affine in z, so a fixed-fraction edge is an exactly
straight line in space. The panels hinge about their own forward edge with no
part of it leaving the skin: **the forward edge moves 0.000 mm over 108 samples
at three deflections, while the trailing edge of the same panels moves 1098 mm.**
At full spoiler and full flap the closest approach between any panel and any
flap is 541 mm.

Six a side now, which is what the aeroplane has — two inboard ground spoilers
and four outboard flight spoilers, with the inboard aileron's span left clear
between the groups. That cost nothing: every panel in a group lies on the same
chord-fraction line of the same wing panel, so a group is one hinge and one
mesh. Ten meshes became four and the drawn-mesh count went from 97 to 91.

### The skin law was wrong, and the first attempt was worse than the boxes

Worth recording because it passed every self-consistent check. The first
conformed version seated the panels **540 mm out** — worse than what it
replaced. `wingPanels` hands `airfoilWing` a trailing edge at the HINGE LINE,
because aft of it the metal is flap, so the fixed wing is a complete aerofoil of
**70% of the local chord** and not the front 70% of a full-chord one. Evaluating
the thickness law on the full chord is self-consistent, reads plausibly, and
describes a wing this aeroplane does not have. Only a measurement against the
built mesh caught it.

`wingSkinY` now rescales into the wing box, carries the camber term and the
dihedral tilt, and shares `nacaThickness` with the builder that draws the wing,
so the two cannot disagree again. It replaced a pair of helpers that evaluated
the section at 60% chord and nowhere else from a hand-copied 0.3753 — the true
value there is 0.3789.

That moved the two parts hung off the lower skin, so both were re-measured
rather than assumed: all eight flap track canoes keep their roof **97–118 mm**
inside the surface above them with no daylight anywhere, and the pylons stay
inside the wing (every ray landing on the wing at a pylon station hits wing,
not pylon).

### The axis gate was not looking at spoilers at all

`render.swept-flap-hinge` drives a pose and measures every surface that turns.
It never pulled the speed brake, so every spoiler on every airframe turned less
than half a degree and was skipped as "not driven by this pose" — and `SPINNING`
filtered `starboard-speed-brake` out on top of that, with a word meant for wheel
brakes. The sweep now covers **46 surfaces instead of 30**: the F-16's four
petals, the Global's eight spoilers and the 747's four spoiler groups. All
sixteen newly-visible surfaces hold their hinge lines.

---

## What is STILL not accurate to the aeroplane

Ranked by how much it would show.

1. **The rudder is a leaning box, not a hinged panel.** Its rake is a
   `rotation.z` applied about the box's own centre, which swings the panel
   forward past its hinge so the hinge line runs THROUGH it — 2.26 m from the
   leading edge and 0.64 m from the trailing edge. It is declared in
   `DECLARED_UNRAKED` and asserted to still fail, so the list cannot go stale.
   Simply raking the axis sends the trailing edge the wrong way on right
   rudder (measured, and caught by `render.webgpu-control-surface-sides`); the
   panel needs re-seating on its hinge line and shearing rather than rotating.
   The F-16 has the same defect.

2. **The spoilers all deploy to the same angle.** On the aeroplane the ground
   spoilers and the flight spoilers do different jobs and travel differently,
   and the flight spoilers also rise differentially with roll. Here one pose
   number drives all twelve. It is the arrangement that reads wrong in a hard
   turn, not in the cruise.

3. **The panels are 12 mm proud rather than flush.** Deliberate — two surfaces
   at the same depth fight, and at chase range the panels would flicker. 12 mm
   is under a quarter of a pixel at the 65 m orbit, so nothing is visible, but
   it is not what the metal does. The real fix is to cut the spoiler bays out
   of the wing skin, which is a wing rebuild rather than a panel one.

4. **There is no spoiler bay under the panels.** *(A dark bay now lies under each panel, 2026-09-23: see
   `GROUND_SPOILERS_2026_09_23.md`. The skin is still not cut.)* Deployed, the underside of
   each panel shows the wing's own upper skin beneath it, not a recessed well
   with its actuator. At 39 degrees and chase range this reads as a shallow
   step; close up it would not.

5. **The wing has no twist.** Every section sits at the same incidence, so the
   washout a 747 carries from root to raked tip is absent. It shows most in the
   plan view at high sun, where the outboard skin highlights should roll off
   ahead of the inboard.

6. **The flap track canoes are one shape instanced eight times**, scaled per
   station. The real fairings differ inboard to outboard by more than a scale
   factor.

7. **The 747's `wing` paint recipe is now identical to `body`** and is a
   redundant material. Harmless, one draw's worth of state, worth folding.

---

## Instruments

All in `scripts/`, all of which refuse to report rather than report a zero:

- `spoiler-frames.mts` — retracted and deployed frames from the shipped page,
  with the deflection measured off the vertex buffer about the panel's own
  hinge axis and the frame failed if it disagrees with its caption by more than
  a degree. It caught its own first version: measuring the chord vector's raw
  turn read 35.5 degrees for a 39 degree deployment, because the hinge is swept
  and the chord crosses it at about 66 degrees.
- `livery-frames.mts` — orbit bearings and the chase view, cropped by
  projection. Generalised from the Global in this pass; it was matching one
  airframe's name prefix and cropping the 747 to its tail surfaces.
- `wing-slot-sweep.mts` — leaking span stations between wing structure and
  moving surface, VOID unless both classes were hit.
