# The 747's flight-deck glazing: siting the re-loft

2026-09-21. Design only — no vertex has moved. Jason: *"getting the window
shape right"*; the opening is about 19 degrees tall where the type's is ~35,
and the panes lie high on the crown and too far aft.

## Frames

Two, deliberately, and confusing them is the trap that nearly cost a day:

- **Azimuths are AIRCRAFT-frame**, symmetric about the centreline, from a
  reference on it at the pilots' station **R = (29.9, 2.93, 0)**. A windscreen
  is symmetric about the aeroplane; the pillar is on the centreline.
- **Elevations and roof clearance are checked from the LEFT-SEAT eye
  E = (29.9, 2.93, -0.72)**, which the cockpit engineer re-solves afterwards.

The measurement that forced the distinction: the existing centre post, which is
ON the centreline, subtends **az +17.3..+31.9 from E**. A spec of "a centre
pillar at az +-2.5" can only be in the aircraft frame.

## The defect, located

`el` of the crown from E, station by station:

    x=30.4  crown 3.550  +35.3
    x=31.0  crown 3.310  +16.1
    x=31.2  crown 3.230  +11.4   below +15
    x=31.4  crown 3.150   +7.5   below +15

    crown falls below +15 deg at x = 31.044

And the pane that has to live under it:

    No.1 pane's top corner (az 2.5, el +12) exits the skin at x=31.236, y=3.214
    the crown at that station is                                        3.216
    => the pane top lands ON the crown, 2 mm clear

**There is no roof above the windscreen at all.** That is "the crown is their
ceiling", pinned.

Rise required to put the +15 roof line forward of the pane top:

    x=31.00   -0.028 m   already clears
    x=31.24   +0.124 m   the binding one
    x=31.40   +0.226 m

So **+0.12 to +0.23 m** over x 31.0-31.4, falling away past the glazing, hump
untouched.

### An earlier number of mine was wrong, and why

I first reported "+0.3 to +0.5 m", from two faults. I sized against x=31.4
rather than the station where the pane top actually lands (31.24); and my
roof-clearance test cast rays from the eye and asked whether they exit the
skin — **but the eye is inside the body, so every ray exits in every
direction and the test could not fail.** The table above measures the crown's
own elevation instead, which can.

## The corner table

Cast from R at the target az/el onto the body's outer surface — the **union**
of the nose and fuselage lofts, because the fuselage is still the outer skin
aft of ~29.6 and casting against the nose alone reads the wrong surface.
Controls: R and E both inside the body (f = 0.597, 0.685; < 1 required) before
any ray was cast.

Starboard; port mirrors in z. Order: (az_lo,el_lo) (az_hi,el_lo) (az_hi,el_hi)
(az_lo,el_hi).

    PANE ONE    az 2.5..25, el -18..+12
      ( 2.5, -18)   32.571   2.061   0.117
      (25.0, -18)   31.954   2.194   0.958
      (25.0, +12)   31.032   3.195   0.528
      ( 2.5, +12)   31.236   3.214   0.058

    PANE TWO    az 25..55, el -15..+10
      (25.0, -15)   31.847   2.354   0.908
      (55.0, -15)   30.931   2.448   1.472
      (55.0, +10)   30.597   3.144   0.996
      (25.0, +10)   31.087   3.161   0.553

    PANE THREE  az 55..75, el -15..+10
      (55.0, -15)   30.931   2.448   1.472
      (75.0, -15)   30.374   2.440   1.768
      (75.0, +10)   30.218   3.147   1.188
      (55.0, +10)   30.597   3.144   0.996

The group spans x 30.22..32.57. Today's spans 29.5..31.35 with No.3 reaching
29.1 — **behind** the eye at 29.9. The new No.3 starts at 30.22, ahead of the
shoulder, and that falls out of the azimuth targets rather than being applied
by hand.

Pane one is **30 degrees tall** by construction (el -18..+12) against the
type's ~35 and today's ~19.

## Open, before a vertex moves

1. **These corners are cast against the CURRENT nose.** The crown rise moves
   the surface, so the top corners move — pane one's +12 pair most, since they
   sit on the crown. Bottom corners barely shift. Re-cast and re-issue against
   the new sections; this is the target geometry, not the final numbers.
2. **No elevation range was given for No.3**; No.2's -15..+10 is assumed.
3. **Panes two and three share the az=55 edge with no pillar**, because the
   ranges are contiguous. A real 747 has pillars there. Proposed: a ~2 degree
   pillar at each boundary, panes shrunk into it.
4. **Face normals are deliberately absent.** The target is ~35 deg above
   horizontal and 10-15 deg outboard on the pane's own face, and the face is
   about to change. They come with the re-cast table.
5. The true CURRENT opening height from face normals is still owed. The
   selector that produced 0.3 degrees was picking an edge rather than a face —
   the panes carry both pitch and yaw, so constant-z is not a face on them —
   and it stays withdrawn rather than refilled badly.

Pane names hold: `<side>-airliner-flight-deck-window-<one|two|three>`, six
panes. No eyebrow windows: a -400/-8 has none.
