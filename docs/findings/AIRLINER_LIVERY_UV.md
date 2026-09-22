# The airliner's livery texture: the UV contract

2026-09-21. Written before the generator, because three things about the
existing loft are not what the plan assumed and all three change the code.
Updated 2026-09-22 after the bind and an adversarial review of it: the livery
rides UV1 (section 2), the radome's v is re-solved (section 3), the band moved
to -0.80..-0.30 (section 4), and sections 7 and 8 are new.

Driven by Jason's 747 complaints: the bottom window row is invisible, the
outside is blurry, and the spoilers appear to be gone. `AIRLINER_747_SHAPE.md`
has the diagnosis; this file is the mechanism.

## Why a texture at all, in one paragraph

The cheatline WAS vertex colour. The fuselage is lofted at 28 radial segments,
15 vertex heights a flank, but they bunch at the crown and keel: round the
waterline, where the band sat, they are 0.69-0.72 m apart at the cabin and
0.85 m under the hump at x = 21 (measured). The paint's own `smoothStep` ramp
was 0.22 m, so it fell inside a single vertex gap and what rendered was a
linear fade across the whole gap — about 0.8 m, four times the designed width
and ~12% of the 6.5 m fuselage height. **That is the blur,
and it is a resolution limit, not a tuning value: narrowing the ramp changes
nothing, and neither does moving the band at better than ~0.8 m precision.**
A texture's edge is texels, so it is crisp at every range and placeable to
about one texel, 4 cm round the section, on every loft that shares its v (see
section 3).

## 1. THE AXES ARE ALREADY ASSIGNED, AND THE OTHER WAY ROUND

`builders.ts` `loft()` already emitted UVs (now line ~641, where a station
range can replace the loft's own):

    uvs.push((section.x - uMinimumX) / uLength, phase);

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
The fuselage runs x -26..30.6, so u = (x + 26) / 56.6. The nose loft runs
x 25.5..34 and maps u = 0..1 across its own 8.5 m.

At x = 30.6, where the fuselage ends inside the nose, the fuselage reads
**u = 1.000** and the nose **u = 0.600** (measured on the built shell). A band
drawn at one u therefore steps by **0.40 of the texture width** there, and by
about 0.7 where the two surfaces actually cross at band height, x ~ 27.0-27.75.
(An earlier draft of this section computed 0.615 for a hypothetical nose over
x 28.6..33.8; the built nose starts at 25.5.)

This is why the cheatline was in body coordinates: a function of world x and y
crosses the join without knowing it is there. A texture indexed by a per-loft
u does not.

**Fix: an optional explicit station range on `loft()`, written into UV1.** The
two lofts that carry the livery, fuselage and radome, pass ONE shared range,
x -26..34. The tailcone does not: the band dies out by x = -24.5 and the
tailcone spans -38..-25, so it stays on `airliner-body`. Every other loft omits
the range, and its positions, indices and UVs are byte-identical by
construction (the caps keep their literal 0 and 1 when no range is passed).

UV1, not a second UV set, because of the fragment-input budget (section 7). A
second set was built first and cost the fuselage its last free varying. The
price of UV1 falls on the paint synthesis, which tiles on UV1 and wraps: its
panel lines now repeat over the shared 60 m rather than each loft's own, which
is 5.7 % longer on the fuselage and a FIX on the radome, whose own 8.5 m had
packed the whole panel pattern into the nose about 6.7x denser than the
fuselage's.

Only `airliner-fuselage-shell` changes, and `tests/render.airliner-livery-mesh.test.ts`
proves it by building the fleet twice in one run, with and without the ranges,
and diffing every buffer of every mesh: the shell's UVs differ and nothing else
anywhere does. Positions and indices move nowhere, and they are what the
geometry digest reads (`render.loft-crown-seam.test.ts`), so no digest is
re-pinned. The shell also lost its vertex-colour channel and moved from
`airliner-body` to `airliner-skin`, whose albedo is the livery.

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
0.3141 and therefore sits HIGHER on the skin — 0.69 m up, at y = +0.29, which
is the height of the main-deck pane band (0.02..0.38), although no main-deck
pane reaches that far forward (the row ends at x = 24.2). The band would ride
up over the nose, not droop. (An earlier draft
of this file said "droops forward"; the magnitude and the reverse control were
right and the direction was wrong.) The same applies to every level feature:
door outlines, the window surround band, the wing-root tone.

(The table is for the contract's top edge at -0.40. At the shipped -0.30 the
edge runs 0.2647 at the cabin to 0.3074 at x = 30.6: 0.0427 of a circuit, 22
texels. Tests 5 and 5b pin those.)

**The table is the FUSELAGE's, and forward of the crossover it is the wrong
surface.** At band height the radome is the outer skin from x ~ 27.0 (bottom
edge) and ~ 27.75 (top edge), and the fuselage's sections from 28 forward are
buried inside it. Carrying the radome's own phase put the band 0.23-0.49 m low
there, split it into two strips at x 27.3-27.76 with a white gap of up to
0.46 m, and dropped door 1's sill 0.45 m with a ghost window under it
(measured by the review of 5a35a42, with three separate instruments). No
single image fixes that, because at 26.9-27.8 both lofts are outer at
different heights. So each radome vertex's v is re-solved from its own height
(`radomeLiveryPhase`):

- inside the painted window (the band's bottom to door 1's top, 0.25 m of
  margin each way) v is exactly the fuselage-table phase of the vertex's
  height;
- outside it v runs linearly to the crown (0) and the keel (0.5), which keep
  their own phase, so the seam, the caps and the other flank are untouched;
- forward of the paint (x > 32.5) it fades to the loft's own phase.

Two increasing pieces meeting where they agree cannot fold, and that matters
because under UV1 this v is also the paint maps' v. A first version faded a
full re-solve by latitude instead and FOLDED: where the nose's crown rises
above the fuselage table (x ~ 30.4) v ran backwards for one step (-0.25 of the
loft's own step), and it squeezed to 0.09 of a step at x = 31.4. The shipped
map measures 0.73..1.32 of the own step on every ring.

## 4. WHAT THE IMAGE CONTAINS, AND WHAT IT DOES NOT

Generated in pure TypeScript into a `Uint8Array` and uploaded as a
`RawTexture` with mipmaps. **No canvas.** Every Node test runs under
`NullEngine` with no 2D context, so a canvas dependency would make the
generator untestable headlessly.

In this pass: the cheatline (navy `[0.011, 0.042, 0.147]` linear, on flat white
255, which is NOT the body paint's albedo -- see the spec's Base), **run BELOW
the main-deck window line** so the panes sit on white; four circumferential
frame lines; door outlines and their windows; the wing-root tone on the
fuselage flank. NOT in this pass: spoiler, flap, aileron and nacelle lines.
This image maps the fuselage and radome only; the wing and nacelles have their
own planar UVs and no place in it.

The band is **-0.80..-0.30**, not the contract's -1.40..-0.40. The belly
fairing meets the fuselage at y ~ -0.90 over x -6..0, so a band down to -1.40
had its lower half inside the fairing from x ~ -10 to +6: the visible band
halved in height over 16 m of mid-fuselage, from every angle. Frames at 0 and
+12 degrees of elevation told the two apart: aft of the wing the thinning was
the wing itself, crossing the sight line (0.18-0.64 m visible level, 0.93-0.95
at +12), but at the wing root it was 0.45-0.47 m from both, cut at y = -0.87 --
the fairing. -0.80 clears the fairing's crossing (-0.893..-0.908), and the top
moved up 0.10 m to keep the band 0.5 m deep, about 10 px at the chase camera's
112 m standoff.

NOT in this pass: **titles and logos**, which need a rasteriser and therefore a
canvas or a bitmap font. Called out rather than quietly skipped.

Cabin panes stay geometry (thin instances). Whether they also need a painted
dark surround is decided FROM A FRAME, not in advance.

## 5. WHAT THE TESTS ASSERT

Headless, on the generated `Uint8Array`:

- the cheatline's edge width in texels at named stations (it is an edge, not a
  ramp — a handful of texels, against the ~0.8 m the deleted vertex band
  managed);
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

NOT DONE: neither the panel-line texels nor the vertex-colour tone below
exists yet. The spoilers are on `airliner-body`, which the livery does not
reach, and a vertex-colour tone there costs a varying (section 7).

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

## 7. THE VARYING BUDGET

**The limit.** WebGPU refuses a pipeline whose fragment stage takes more than 16
inputs, counting the `@location` varyings PLUS `front_facing`, which Babylon's
WGSL declares on every fragment stage (`@builtin(position)` does not count).
The device says so verbatim:

    Total fragment input variables count
    (17 = 16 (user-defined) + 1 (front_facing)) exceeds the maximum (16)

16 is the spec default, and it is the limit here because the device is created
with `setMaximumLimits: false` (`FlightRenderer.ts`, `core/Capabilities.ts`).
Raising the requested limits would make a black screen depend on the adapter;
every GPU gate must keep the spec defaults or its positive control passes
vacuously.

**The failure mode.** The first livery build put the fuselage shell at UV1 + a
second UV set + vertex COLOUR. The device refused the pipeline, the renderer
stopped, and the 747 drew a **black canvas under a live HTML HUD** -- three
identical black frames at three camera distances, which reads as a lighting or
camera bug and is neither. Every Node test was green: NullEngine compiles no
shaders. No GPU test built the 747 at all; Gate A compiled only the trainer and
the jet.

**The container's slot.** The clustered light container is a scene light and
adds one varying (`vViewDepth`) to every lit material. `FlightRenderer` builds
it in EVERY flight, from the aircraft's own cast pools and wash lights, airport
or not. So a live count is the rig count plus one, and the standard is
headroom >= 1 in Gate A's container-less rig: 15 there is 16 of 16 in flight.

**Measured**, Gate A's rig on the adapter, 2026-09-22 (worst pass per material,
`effect.fragmentSourceCode`; live = +1):

- `airliner-skin`, livery on UV1 alone: **14** (15 live). With a second UV set it
  was 15 (16 live, no headroom); with the second set AND colour, 16 (17 live:
  the black screen).
- `airliner-body`: 15 while an all-white colour fill stood on every body mesh.
  After the cheatline became a texture the fill painted nothing; it is deleted,
  and Gate A re-measured the body at **14** (15 live) -- the slot it held for
  nothing is free.
- `bizjet-body` (carries vertex colour): 15 -- **16 of 16 live, zero headroom**.
  `bizjet-display` 14; trainer and jet paint 14.
- The black-screen build, rebuilt inside Gate A as a positive control: 16, and
  the headroom check rejects it.

**What Gate A cannot see, and the test that does.** Gate A's `ReflectionProbe`
has an empty `renderList` and renders nothing, and its rig has no container, no
clip plane, no fog, no lamps and no cockpit layers.
`tests/gpu/aircraft-render-variants.test.ts` builds each airframe in a scene of
its own WITH the container (as every flight has it) and measures five passes:
the day baseline; a REFLECTION -- Babylon's `MirrorTexture` under a water plane
with the aircraft in its render list, what the lake capture 5-12 plans would
build (the live game has no such pass: 2-10 retired the mirror); NIGHT, with the
container's lamps lit; the COCKPIT layer mask, the shell hidden but still
casting; and Babylon FOG. Each reading is the worst count per material over
every pass, every device error in that pass's own frames, and pixels read back
from the target rendered directly. Measured 2026-09-22, live counts:

- day, night, cockpit: trainer and jet paint 15, `airliner-body` /
  `airliner-accent` / `airliner-skin` 15, `bizjet-body` **16**. No errors,
  every target drawn and not black. The live passes are clean.
- reflection and fog (+1 each, the clip plane and the fog varying): trainer,
  jet and all three 747 paints 16 -- no headroom, and they draw. `bizjet-body`
  **17**: the device refuses the pipeline and the target is black.
- The positive control, the black-screen layout rebuilt (the shell with a second
  UV set carrying the livery and a colour channel): 17, refused, with the
  device's own message. A colour channel ALONE on today's UV1 skin is 16 and
  legal, which is why the control carries both.

The test holds three rules: the counter and the device agree (over 16 exactly
where the device refused); a live pass over budget is a hard fail; and a pass
that does not exist live may be over only for the materials listed in its
`KNOWN_OVER_BUDGET`, asserted both ways, so the list cannot go stale.

**REGISTER: the Global's body has no slot for a clip plane or fog.** It carries
vertex colour and sits at 16 of 16 live. It needs a varying freed (its painted
band moved to a livery texture, as the 747's was) before 5-12 puts aircraft in
the lake capture or anyone enables fog -- either one makes the Global stop
drawing in that pass. Pre-existing, not the livery's; measured by the test
above, where it is the one listed known-over-budget material.

Two instrument traps the rig met, for whoever extends it. A mesh that a pass
never DRAWS never builds a pipeline, so the device never refuses it even when
its compiled shader counts 17: the reflection was first aimed at the airframe
and its image fell off the mirror, and the Global read 17 with no error. And in
this environment a canvas frame must be closed (`engine.beginFrame()` /
`endFrame()` around `scene.render()`) before targets are drawn directly and read
back, or every scene logs one "Destroyed texture ... WebgpuSwapChainTexture ...
used in a submit".

**Three Babylon 9.21 traps that make an inter-stage audit read the wrong
thing:**

- `subMesh.effect` returns the effect for `engine.currentRenderPassId` at the
  moment of reading, which can be a shadow cascade. The main colour pass is the
  CAMERA's `renderPassId` (measured 12, cascades 13-16), not
  `Constants.RENDERPASS_MAIN` (0). Read every pass through `_drawWrappers` and
  take the worst.
- `material.markAsDirty` dirties the defines of the CURRENT pass's draw wrapper
  only, so mutating a mesh between frames leaves the main pass on its old
  shader. Build a variant on a fresh clone with `makeGeometryUnique`.
- Effects are cached by source and defines, so a permutation compiled earlier
  in the file is reused without a fresh `createShaderModule`. Count from the
  effect's `fragmentSourceCode`; the file-level module capture is a rolling 64.

**The rule.** No vertex colour, second UV set or UV'd detail map on the shell
without first freeing a varying. It is guarded on the adapter by
`tests/gpu/aircraft-material-compile.test.ts` and in Node by
`tests/render.airliner-livery-mesh.test.ts`, which cannot count varyings but
does refuse the mesh layouts that spend them.

## 8. HOW THE FRAMES WERE MEASURED: at projected positions, never by colour search

The first two band-edge measurements were wrong, and in the same way: they found
the band by searching the image for a colour. The sky passes a naive
"blue-dominant" test, and a threshold on the flank saturated at 60 px. A
measurement that locates its subject by the property it is measuring finds
whatever has that property.

So every number below was read at a position computed from the geometry, not
found in the image:

- `scripts/livery-flank-frames.mts` parks the camera on the starboard flank in the
  aeroplane's own frame (a distance out along the wing axis, an elevation above
  the wing plane), re-parked every frame, and writes the shell's world matrix W
  and the camera's view-projection VP beside the PNG. Body-frame points go
  through W then VP (Babylon's row-vector convention), and NDC maps to pixels as
  `((x + 1) / 2 * width, (1 - y) / 2 * height)`. Pane centres come from the
  window mesh's own thin-instance matrices; skin points from the section table.
- The HTML HUD is hidden (`visibility: hidden` on every element that neither is
  nor contains the canvas) before the screenshot. One set was reshot because a
  HUD box sat on the flank being measured.
- The script refuses to capture until the dev server proves which checkout it
  serves (`/@fs<tree>/package.json`): two worktrees on two ports look the same
  from the page.
- `scripts/livery-measure.mts`: pixels per metre on the flank; the band's top
  edge as a 10-90 % transition width along a vertical line of skin points at
  eight stations; pane-versus-skin contrast per row, pane centre against the
  skin midway to the next pane. `scripts/livery-band-height.mts`: the visible
  band height per station, door stations flagged.
- A thinning that could be geometry or viewpoint was taken again from a second
  elevation (0 and +12 degrees), which is how the wing's occlusion (aft; it
  moves with the camera) was told from the fairing's (at the root; it does not).

**Measured, the vertex band (f9d2672) against the first texture build** (UV1,
band -1.40..-0.40, before the review's fixes), a 1280x1280 viewport at device
scale 2, so a 2560x2560 PNG; every pixel figure counts those pixels:

- pixels per metre on the flank: 81.6 at 30 m, 38.4 at 60 m, 20.0 at 112 m;
- main-deck pane contrast (skin minus pane, sRGB luminance) at 30 / 60 / 112 m:
  **-2 / -5 / -4 before**, the panes as light as the skin, which is Jason's
  invisible bottom row; **+104 / +104 / +69 after**. The upper deck read +97 to
  +150 in both;
- band top edge, 10-90 % (median over stations, the corrected instrument --
  see below): **32 cm before** at 30 m, 25 cm at 60 m, 24.5 cm at 112 m, all
  LOWER BOUNDS, since the vertex band's ~0.8 m ramp is wider than the scan;
  **7.0 cm after** at 30 m (5-8 across stations), 11.0 cm at 60 m.

**The final skin** (band -0.80..-0.30, the radome re-solved, the body's maps
shared), the same instruments, every frame's serving tree proved from the
dev server's own working directory:

- main-deck pane contrast at 30 / 60 / 112 m: **+104.6 / +103.6 / +60.3**
  (before: -2.3 / -4.6 / -4.1); upper deck +146 / +151 / +100;
- band top edge, 10-90 %, median: **9.0 cm = 7.3 px at 30 m** (8-10.5 across
  stations), 13.5 cm = 5.2 px at 60 m, 20 cm = 4.0 px at 112 m, where it is
  pixel-limited. Half a texel wider than the first build's 7.0 at 30 m;
- band height at half coverage, against the intended 0.50 m: **0.47-0.51 m at
  every station at 30 m, median 0.50 = 40.5 px**, the wing root included
  (0.50-0.51 at x -6..0 -- the fairing no longer cuts it; the -1.40 band read
  0.45 of 1.0 there); the same from +12 degrees. At 112 m, **0.44 m = 8.8 px**
  (x 2..26; aft of the wing the wing hides the flank at 0 degrees);
- across the nose join, x 24 to 31.5 at 30 m: top edge -0.29..-0.32, bottom
  -0.76..-0.83 at every station, no step and no split at the 27.3-27.8
  crossover, from 0 and +12 degrees.

**One more instrument lesson.** With the band's top raised to -0.30, the edge
scan (+-0.35 m) reached the pane bottoms at y = 0.02; where a pane sat on the
scan line the first sample read dark, the 90 % crossing landed on sample 0, and
four stations reported the scan window -- 38 cm -- as the edge. The scan now
stays under the panes and takes the LAST sample above 90 % before the first
under 10 %; every figure above was re-measured with it, the earlier builds'
included.

**The Node instruments follow the same rule.** `render.airliner-livery-mesh`
reads the band on the OUTER skin by casting a ray at each (x, y) against the
built shell and taking the outermost hit, interpolating its UV as the
rasteriser does; a straight row painted by the test itself is its positive
control, and must read off-level forward. The radome's no-fold check reads the
ratio of each ring step to the loft's own; a swapped pair of v's is its
control. The draw-budget test samples the livery at every shell vertex and
triangle centroid, and a 0.4 m shift of the same lookups must put navy off the
band.
