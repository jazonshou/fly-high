# The Global's cabin windows stand 35–55 mm out of the fuselage

> **SUPERSEDED 2026-09-23 (Global phase 3a, `GLOBAL_LIVERY.md`).** The bow this
> file records was written into a vertex buffer created non-updatable, which
> Babylon drops without a word: the CPU copy that every figure below was read
> from was bowed, and the GPU drew the flat pane. The "after" table is true of a
> mesh the GPU never received. The pane is now cast and built once, and seated
> by ray over the whole window, not at vertices.

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

The face CENTRE is the seating. The worst pane EDGE is a different and much
larger number — **152.5 mm proud at the top edge, 19.9 mm sunk at the bottom** —
because a pane is a FLAT oval 0.539 m tall laid on a curved skin, at a height
where that skin is steeply sloped. Across one pane the half-width runs from
1.341 m at its bottom edge to 1.178 m at its top: **163 mm of movement under a
dead-flat face.** Seating such a pane perfectly at its centre still leaves its
top edge 112 mm inside the aeroplane and its bottom 50 mm outside it.

> **CORRECTION.** An earlier pass of this file reported that edge figure as
> 82.6 mm. That reading was taken before the sign fault below was found, and it
> was wrong: the true figure is 152.5 mm, nearly double. The centre figures
> (34.8–55.2 mm) were taken after the fix and stand.

## The fix, and what it reads now

Two changes, because the defect was two defects.

1. **Each pane is seated at its own station.** `CABIN_WINDOW_Z = 1.29` — "the
   fuselage half-width at that height" — was the half-width at ONE station.
   Each instance now asks `cabinHalfWidthAt` for its own, plus 5 mm of
   clearance so the glass and the skin cannot fight in the depth buffer.
2. **The pane is bowed to the section.** Done once, on the single instanced
   base mesh, from the constant-section curve. A flat pane cannot lie in this
   surface at all, for the reason above.

| | before | after |
|---|---|---|
| outer face, all 28 panes, both sides | −19.9 to **+152.5 mm** | **+3.8 to +9.0 mm** |
| face centre | 34.8 → 55.2 mm proud | ~5 mm proud, uniform |

756 outer-face vertices measured, every one of them within 9 mm of the skin.
The −63.8 mm that the all-vertex figure shows is the pane's own 70 mm of
thickness — its inner face, buried in the fuselage.

**Thin instances stay thin instances.** One base mesh, 28 matrices, no change
to the draw count, and `mergeStatic` still refuses it.

## Two more ways this went wrong

**The port side bowed inward.** The pane used to be symmetric about its own
local Y, so one rotation served both flanks and the port instances were quietly
laid on with their local +Y pointing INTO the aeroplane. Nothing depended on
it. The bow does — it is asymmetric in local Y — so with one rotation the port
panes bowed the wrong way and read **270 mm proud** while starboard read 5. The
port rotation now takes local X to −X, Y to −Z and Z to −Y, which is a proper
rotation (a half turn about (0, 1, −1)); the mapping that seems more natural —
leave X alone, send Y to −Z — is a REFLECTION and renders inside out.

**And the height sense was assumed, not measured.** The airframe's own comment
said the quarter turn sends local Z to world −Y. It does. But with the port
fault in play, flipping that sense *also* changed the numbers, and for one run
it looked like the culprit. What settled it was printing the actual
local→world mapping of a base vertex through a real instance matrix, rather
than reasoning about a quaternion: local z −0.193 lands at world y 0.649, and
that is the end of the argument.

## The frame

`timeOfDay: golden` was the right instinct for a shading defect, but at the
headings the aeroplane flew the low sun sat nearly along its track and BOTH
flanks came out backlit. `spine-frames.mts` gained `side`, `side-port` and a
light argument; the before/after pair is taken in `day`, where the windows read
as plates stuck on the skin before and as panes set into it after.

The frames support the table. They are not the evidence — 5 mm against 35 is
not something a screenshot settles, and the instrument with its known-offset
control is.
