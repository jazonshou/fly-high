# The airliner's livery texture: the UV contract

2026-09-21. Written before the generator, because three things about the
existing loft are not what the plan assumed and all three change the code.

Driven by Jason's 747 complaints: the bottom window row is invisible, the
outside is blurry, and the spoilers appear to be gone. `AIRLINER_747_SHAPE.md`
has the diagnosis; this file is the mechanism.

## Why a texture at all, in one paragraph

The cheatline is vertex colour. At the cabin the fuselage has SIX vertices over
its whole height, spaced 0.72-0.85 m apart (measured). The paint's own
`smoothStep` ramp is 0.22 m, so the ramp falls inside a single vertex gap and
what renders is a linear fade across the whole gap — about 0.8 m, four times
the designed width and ~12% of the 6.5 m fuselage height. **That is the blur,
and it is a resolution limit, not a tuning value: narrowing the ramp changes
nothing, and neither does moving the band at better than ~0.8 m precision.**
A texture's edge is texels, so it is crisp at every range and placeable to the
centimetre.

## 1. THE AXES ARE ALREADY ASSIGNED, AND THE OTHER WAY ROUND

`builders.ts` `loft()` already emits UVs (line ~559):

    uvs.push((section.x - minimumX) / length, phase);

so **u = station along the body, v = angle around the section**. The plan for
this work specified the opposite (v = station, u = angle).

**We keep what the code does.** Swapping the axes would rewrite the UV buffer
of every loft in the fleet — trainer, Global, jet — to gain nothing but
agreement with a sentence. Everything below is written in the code's axes:

- **u** = station along the body, 0 at the loft's first section, 1 at its last.
- **v** = `phase` = `radial / radialSegments`, the angle around the section:

      v = 0.00   crown (top)
      v = 0.25   starboard flank
      v = 0.50   keel (bottom)
      v = 0.75   port flank
      v = 1.00   crown again

  The ring is closed with a DUPLICATED crown vertex (`ringSize =
  radialSegments + 1`), so v = 0 and v = 1 are two real vertices at the same
  place. That duplicate is the texture seam, and it is already where a seam
  should be: on the crown, out of sight, and the same place the loft's normal
  weld already treats specially.

## 2. THE STATION AXIS IS PER-LOFT, AND THAT IS THE JOIN STEP

`minimumX` and `length` are taken from each loft's OWN first and last section.
The fuselage runs x -26..30.6, so u = (x + 26) / 56.6. A nose loft over
x 28.6..33.8 maps u = 0..1 across its own 5.2 m.

At the join (x = 30.6) the fuselage reads **u = 1.000** and the nose reads
**u = 0.385**. A band drawn at one u therefore **steps by 0.615 of the texture
width** at the join — most of the way across the image.

This is why the cheatline is in body coordinates today: a function of world x
and y crosses the join without knowing it is there. A texture indexed by a
per-loft u does not.

**Fix: an optional explicit station range on `loft()`.** The lofts that carry
the livery (fuselage, radome, tailcone) pass ONE shared range and share one
parametrisation; every other loft omits it and keeps `minimumX`/`length`
exactly as now.

That is deliberately the smallest change that works, and it is what keeps the
promise that the trainer's, Global's and jet's lofts stay **byte-identical in
positions, indices AND uvs**. Only the airliner's three lofts pass the option,
so only their UV buffers move. Positions and indices move nowhere at all, which
is what the geometry digest reads (`render.loft-crown-seam.test.ts:243`
states the digest is `getVerticesData(PositionKind)` and `getIndices()` only),
so no digest is re-pinned by this change.

## 3. A LEVEL BAND IS A CURVE IN UV, NOT A ROW

v is an ANGLE, not a height. The section is a superellipse whose radius and
offset change station by station, so a band at constant world y sits at a
different v at every station. Measured, for a band edge at y = -0.40:

       x      v
     -20    0.2696
      -6    0.2696
       0    0.2703
       5    0.2738
       9    0.2807
      13    0.2864
      17    0.2897
      21    0.2909
      26    0.2910
      28    0.2986
    29.6    0.3041
    30.6    0.3141

**0.2696 .. 0.3141 — 0.0445 of a circuit**, about 23 texels on a 512-texel v
axis. The band is level in the world and bows by 23 texels in the image.

So the generator MUST compute, for each texel column u, the v of the band edge
from the same section table the loft uses:

    y = yOffset + yRadius * cos(2*pi*v)        (squareness 2)
    v(y, x) = acos((y - yOffset(x)) / yRadius(x)) / (2*pi)

Painting a straight row instead would put the band 23 texels off at the nose
and level at the cabin. **The direction is UP, not down**: v is measured from
the crown, so the straight row's 0.2696 is a SMALLER v than the level edge's
0.3141 and therefore sits HIGHER on the skin — about 0.69 m up, above the
window row. The band would ride up over the nose, not droop. (An earlier draft
of this file said "droops forward"; the magnitude and the reverse control were
right and the direction was wrong.) The same applies to every level feature:
door outlines, the window surround band, the wing-root tone.

## 4. WHAT THE IMAGE CONTAINS, AND WHAT IT DOES NOT

Generated in pure TypeScript into a `Uint8Array` and uploaded as a
`RawTexture` with mipmaps. **No canvas.** Every Node test runs under
`NullEngine` with no 2D context, so a canvas dependency would make the
generator untestable headlessly.

In this pass: the cheatline (navy `[0.011, 0.042, 0.147]` linear, on white,
the scheme Jason already has), **run BELOW the main-deck window line** so the
panes sit on white; panel lines; door outlines and their windows; the spoiler
and flap/aileron panel lines; nacelle lines; the wing-root tone.

NOT in this pass: **titles and logos**, which need a rasteriser and therefore a
canvas or a bitmap font. Called out rather than quietly skipped.

Cabin panes stay geometry (thin instances). Whether they also need a painted
dark surround is decided FROM A FRAME, not in advance.

## 5. WHAT THE TESTS ASSERT

Headless, on the generated `Uint8Array`:

- the cheatline's edge width in texels at named stations (it is an edge, not a
  ramp — a handful of texels, against the ~0.8 m it is today);
- the band is **below** the main-deck window line at every painted station, by
  sampling the texel at the window row and asserting it is white;
- a door outline exists at its station and is dark;
- the band's v at two stations differs, so the curve of section 3 is actually
  being computed and not flattened;
- the mip chain exists and is more than one level.

Every one of those carries its opposite in the same assertion where it can: a
test that samples a texel and finds white proves nothing unless another sample
finds navy.

## 6. SPOILERS

Panel-line texels in the livery, which the mip chain fades with distance —
this is the half geometry cannot do, because a real 2-3 cm panel gap is a third
of a pixel at the 112 m chase standoff and an exaggerated 10 cm rim that reads
at 112 m looks wrong at 30 m.

PLUS a tone change on the four stowed panel tops as vertex colour, which is an
AREA rather than a line and so survives any pixel scale. No new draws: the four
panels are already their own meshes.

The stowed panels are `airliner-body` — the same material as the wing they lie
on — and stand `SPOILER_PROUD` = 0.012 m above it. That is 0.13 of a pixel at
112 m, which is why Jason sees no spoilers at all. They deploy correctly:
measured -0.350 flight brake, -0.780 ground, -0.450 starboard-only on right
roll, against 0.000 stowed in the same run.
