# Spec: the airliner livery image generator

2026-09-21. The contract a separate worker builds to. Read
`AIRLINER_LIVERY_UV.md` first — it holds the UV convention and the three
findings this spec depends on.

**Amended 2026-09-22, after the bind and its review.** This is the contract as
it was built to; where the shipped livery departs from it, the note is inline
and marked "Amended". The three departures that matter: the livery rides UV1
on the fuselage and radome only (not the tailcone), the radome's v is
re-solved per vertex, and the band is -0.80..-0.30, not -1.40..-0.40 (the
belly fairing; `AIRLINER_LIVERY_UV.md` section 4).

## The seam, and why it is here

ONE NEW MODULE AND ONE NEW TEST FILE. **No edits to any existing file.**

(Historical scope note: the split below was how the work was divided. The
generator and its binding landed together.)

    src/render/webgpu/aircraft/airlinerLivery.ts       new
    tests/render.airliner-livery.test.ts               new

The loft's UV emission (`builders.ts`), the shared station range, the material
wiring and the `RawTexture` upload are NOT in scope and are being done in
parallel on another branch. Touching `builders.ts` or `airlinerVisual.ts` here
collides with that work. This split exists precisely so neither side waits.

## The module contract

```ts
export interface LiveryImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, length width * height * 4. Straight alpha, opaque (255). */
  readonly data: Uint8Array;
}
export function buildAirlinerLivery(): LiveryImage;
```

Pure except for one thin upload boundary. The pixel and mip code uses no
Babylon, no canvas, no DOM and no `fs`; `createAirlinerLiveryTexture`, at the
bottom of the module, is the only code that touches Babylon (amended: the
module imports `RawTexture`, `Texture` and `Constants` for it). **Every Node test runs
under `NullEngine` with no 2D context**, so a canvas dependency makes this
untestable headlessly — that is the whole reason this is hand-rasterised.

Deterministic: two calls return identical bytes. No `Math.random`, no `Date`.

## Size

**2048 x 512**, u across 2048, v across 512.

That is 2.93 cm per texel along the body and 4.0 cm round the section at the
cabin, 4.6 cm under the hump (x = 21-26) — near enough isotropic. The cheatline
is a horizontal edge, so the ROUND-the-section texel resolves it: a one-to-two
texel edge is 4-9 cm against the ~0.8 m the deleted vertex-colour band managed,
roughly 9-20x better.

Cost: 4.2 MB (4.0 MiB) for the base level, 5.6 MB (5.33 MiB) with the full
twelve-level chain. If that is judged too much, 1024 x 512 is 2.1 MB, 2.8 MB
with its chain; the generator must not hardcode either,
so take the dimensions from two exported constants.

## The axes

From `AIRLINER_LIVERY_UV.md`, and they are the code's, not the plan's:

- **u = station along the body.** Shared across the fuselage, nose and tailcone
  lofts: `u = (x + 26) / 60`, i.e. x from -26 to +34 maps to u 0..1. Every loft
  that carries the livery will be given this same range, so a feature drawn at
  one u is at one station on all of them and does not step at the joins.
  (Amended: on UV1, shared by the fuselage and radome only -- the tailcone does
  not carry the livery. v is each loft's own phase, and the radome's is
  re-solved to the fuselage table's phase of its own height.)
- **v = phase, the angle around the section.** v=0 crown, 0.25 starboard,
  0.5 keel, 0.75 port, 1.0 crown again.

## THE ONE THING THAT IS EASY TO GET WRONG

**v is an ANGLE, so a level band is a CURVE in the image, not a row.**

The section's radius and offset change station by station, so constant world
height is not constant v. Measured, for a band edge at y = -0.40: v runs
0.2696 at the cabin to 0.3141 at x=30.6 — **0.0445 of a circuit, about 23
texels on a 512-texel v axis.** A straight row would sit level at the cabin and
23 texels HIGH at the nose. v is measured from the crown, so the cabin's 0.2696
is nearer the crown than the nose's 0.3141, about 0.69 m up the skin: a band
that rides up over the nose, which is the defect this texture exists to remove.
(An earlier draft here said it droops; `AIRLINER_LIVERY_UV.md` section 3
corrected the direction. At the shipped top edge, -0.30, the bow is 0.0427, 22
texels.)

For each texel column, convert u to x, interpolate the section, and solve:

    // squareness n (all painted sections use n = 2, but do not assume it)
    cosMagnitude = |(y - yOffset(x)) / yRadius(x)| ** (n / 2)
    V = acos(clamp(sign * cosMagnitude, -1, 1)) / (2 * PI)

    starboard flank: v = V
    port flank:      v = 1 - V

Interpolating `yOffset` and `yRadius` LINEARLY between sections is correct and
is not an approximation: the loft emits a ring per section and the renderer
interpolates positions linearly, and for a fixed phase that is algebraically
the same as interpolating the two parameters. Do not spline them.

If `(y - yOffset) / yRadius` falls outside [-1, 1] the band does not exist at
that station — the body is not that tall there. Leave those columns white; do
not clamp, which would paint a band along the crown.

## The section table

Fuselage (x, yRadius, zRadius, yOffset), squareness 2 throughout:

    -26 3.08 3.08  0.16      13  3.685 3.25 0.435
    -20 3.25 3.25  0          17  3.785 3.25 0.535
     -6 3.25 3.25  0          21  3.82  3.25 0.57
      0 3.265 3.25 0.015      26  3.825 3.25 0.575
      5 3.35 3.25  0.1        28  3.575 3.00 0.675
      9 3.525 3.25 0.275    29.6  3.15  2.60 0.65
                            30.6  2.55  2.05 0.6

Sections from x=0 forward also carry `crownZRadius`, which leans the upper
flanks in. It affects z only, never y, so it does NOT enter the band solve
above. It matters only if a feature is positioned by z.

## What is painted

Base: white. The scheme stays the one Jason already has.

(Amended: flat white, 255. That is NOT the body paint's tone: the review of the
bind measured the synthesized `airliner-body` albedo (baseColor 0xf4f5f3) at a
mean of sRGB 236, with soot, wear and panel tint down to 164, and the livery
replaces that albedo on the fuselage and radome only. The tailcone, fin, wings
and fairings keep the paint, so the skin is about 1.2x brighter in linear light
at the joins. Whether the base should match them is decided from a frame.)

- **Cheatline**, navy, linear RGB `[0.011, 0.042, 0.147]` (sRGB ~ 27,58,107).
  **BELOW the main-deck window line**: main-deck panes sit at y = 0.2 and are
  0.36 m tall, so the band's TOP edge must be at or below y = -0.40 to leave
  clear white behind every pane. Proposed band: y -1.40 .. -0.40. Station
  range: full from x = -22 to +30.5, smoothstepped to nothing by -24.5 aft and
  +32.5 forward, exactly as the deleted vertex band's code did. (Amended: the
  band is -0.80..-0.30. A bottom edge at -1.40 put half the band inside the
  belly fairing over x ~ -10..+6.)
- **Panel lines**, a slightly darker white, along the body's structural
  stations and around the doors.
- **Door outlines and their windows**, at the main-deck door stations.
- **Spoiler, flap and aileron panel lines** on the wing surfaces — NOT
  delivered: this image maps the fuselage and radome only; see the note at the
  end of `airlinerLivery.ts`.
- **Nacelle lines** (NOT delivered, for the same reason) and the **wing-root
  tone** (delivered, on the fuselage flank).

NOT in this pass: **titles and logos.** They need a rasteriser, which needs a
canvas or a bitmap font, and both are ruled out above. Called out rather than
quietly dropped.

Cabin window panes stay geometry (thin instances). Whether they also want a
painted surround is decided from a rendered frame, not in advance — do not add
one speculatively.

## The tests

Headless, over `buildAirlinerLivery().data`. **Every assertion that looks for a
colour must also assert the opposite colour somewhere it should be**, in the
same test, or a generator that returns a uniform image passes it.

1. **Dimensions and opacity**: length is `width * height * 4`; every alpha 255.
2. **Determinism**: two calls byte-identical.
3. **The band is below the window line.** At several stations, the texel at the
   main-deck window row (y = 0.2, converted through the solve) is WHITE, and a
   texel inside the band at the same station is NAVY. Both in one test.
4. **The cheatline's edge is an EDGE.** Walking v across the band boundary at a
   named station, the count of texels that are neither white nor full navy is
   at most 2. State the number the test measured in its failure message.
5. **The band curves.** The band's top-edge v at x = -20 and at x = 30.6 differ
   by 0.040..0.049 (measured 0.0445). This is the test that catches a straight
   row, and it is the reason it is specified to a tolerance rather than
   "differs".

5b. **THE REVERSE CONTROL, and it is not optional.** Feed the same check a
   DELIBERATELY STRAIGHT row — the band painted at a constant v — and assert
   it FAILS, by roughly 23 texels at the nose. Without this, test 5 is
   satisfiable by any generator whose two sampled stations happen to differ,
   including by accident. With it, the test is pinned to the actual defect:
   a straight row must be measurably wrong at the nose, in the same units the
   real band is measured in.

   Same shape as the rule above every assertion in this list: a check that
   cannot fail on the thing it is guarding against is not evidence. Build the
   straight-row case as a fixture the test paints itself, not as a flag on the
   real generator.
6. **The band does not exist where the body is too short**: a station where
   `|(y - yOffset)/yRadius| > 1` has no navy in its column at all.
7. **A door outline exists** at a named door station and is darker than the
   skin beside it, with the skin beside it asserted lighter in the same test.
8. **Nothing bleeds off the ends**: column u=0 and the last column are white
   top to bottom. u CLAMPS, so these are what a sample off either end repeats.

The mip chain is built in this module (`buildLiveryMipChain`, box-filtered to
1 x 1 because the image is 4:1) and asserted in the same test file, every
level. The upload is asserted there too, under `NullEngine`.

## Review

Accepted against this spec AND against rendered frames at 30 m, 60 m and the
112 m chase. A generator that passes every test above and produces a band that
looks wrong in a frame is not done; the tests are necessary, not sufficient.
