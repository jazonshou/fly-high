# The Global's cabin windows stand 35–55 mm out of the fuselage

**Measured, not fixed.** Numbers first, so the decision is someone else's.

## The number

The pane's OUTER FACE CENTRE, against the fuselage skin, along the skin's own
normal. All 28 windows, both sides:

| | standoff |
|---|---:|
| constant-section stations (x = 4.20 … −2.24) | **34.8 mm proud** |
| aft-most window (x = −3.16) | 35.6 mm |
| forward-most window (x = 8.80) | **55.2 mm proud** |

Port and starboard are identical to 0.1 mm, as they should be.

The trend is the cause. The panes are thin instances placed at a **constant**
`CABIN_WINDOW_Z` of 1.325 m (pane face), while the fuselage's half-width at the
window line falls from 1.291 m through the constant section to 1.272 m at the
forward-most window. One number for a body that narrows — the same shape of
defect as the 747's spoilers, which were seated at one station's skin height and
stood 44–288 mm clear of a wing that moved underneath them.

## The control

The instrument is a ray cast and a projection, and this file has already had
**both** of them silently wrong:

- the ray started 3 m back along the radial, which on a body 1.1 m in radius
  lands OUTSIDE the far side — so the first hit was the opposite skin and the
  windows read as **2.6 m proud**, a number no part of this aeroplane can
  produce;
- `getNormal` returns the face normal, whose direction follows the winding.
  Here it points INWARD, which turned 35 mm proud into 35 mm sunk with no
  other symptom. The magnitude is now taken along the normal and the SIGN from
  the outward radial, which cannot lie about which side of a skin a point is on.

So the run carries a control through the same code: **a point known to be ON
the skin reads 0.00 mm, and a point known to be 100 mm outside reads 100.0 mm.**
If either fails, the run voids rather than printing a table.

## What is NOT the number

Measuring the worst pane EDGE gives 82.6 mm, and that figure is mostly the
oval, not the fit. A pane is a flat oval 0.58 m tall laid on a curved skin: for
a half-height of 0.29 m on a 1.1 m radius that is 39 mm of sagitta before the
pane's own 70 mm of thickness is counted. Only the face centre isolates the
seating.

## The frame, which did not come out

`timeOfDay: golden` was the right instinct — a 35 mm bump on a 2.6 m fuselage
needs grazing light — but at the headings the aeroplane flew, the low sun sat
nearly along its track and BOTH flanks came out backlit. `spine-frames.mts`
gained `side` and `side-port` views for this, and both frames are too dark to
read a 35 mm standoff from. **No frame is offered as evidence.** The table
above is the evidence; a dark frame would only decorate it.

If a frame is wanted, the cheap fix is to capture in `day` and accept flatter
light, or to wait for a heading with the sun abeam.
