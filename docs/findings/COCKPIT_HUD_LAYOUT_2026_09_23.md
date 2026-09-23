# The 2D HUD in cockpit view: keeping it off the instruments

**Status: built on `jazonshou/cockpit-hud-layout` from `de91cef`, merged as `b8f7e59`.
Node tests, a Chromium check of the real stylesheet and in-game frames of all four
decks agree. The hybrid cockpit lens (2026-09-23, `jazonshou/hud-hybrid-lens`, below)
changes the rule's half-width term on windows wider than 16:9; frames and Jason's
look pending.**

## The problem

The 2D HUD (`src/ui/Hud.tsx`, laid out by `src/game/flight.css`) is one layout for
every camera, in fixed pixels. The cockpit view is a 3D deck that scales with the
window. So in cockpit view the HUD printed across the instruments:

- the key-hint line ran across the F-16's two MFDs;
- the lower-right ACTUAL panel sat on the 747's upper EICAS;
- the lower-left instrument strip ran into the F-16's port bezel.

## How it was measured

**Cockpits.** Each deck is built under NullEngine as tests/render.cockpit-*.test.ts
build it. The eye is at the catalogue `cockpitEye`, with the gameplay lens (75
degrees, horizontal-fixed). One ray per 2 px cell records the first surface the GPU
**draws**. That means the cockpit tests' drawn-mesh predicate, the 0.08 m near plane,
and front faces only, using the winding convention
tests/render.cockpit-drawn-faces.test.ts measured. The last part matters. The eye
sits inside the Global's and the 747's fuselages, and a plain ray cast returned
"fuselage" straight ahead on both, because it hits the back faces the GPU culls.
Merged screens and bezels are split into their parts by `metadata.mergedFrom`, so
every screen is named. The tool is `tests/support/cockpitFootprints.ts`.

**The HUD.** Node cannot lay out CSS, and text widths need the real fonts (SF Mono,
Avenir Next). So the rectangles come from the real `Hud` markup (React
`renderToStaticMarkup`) inside the real `main.flight-shell`, with `globals.css` and
`flight.css` inlined, laid out by headless Chromium. That is CSS layout only: no
app, no dev server, no WebGPU.

**Controls.**
- The ray grid reproduces angles render.cockpit-jet.test.ts asserts:
  - the coaming's far edge at -10.2 degrees gives y 637.6 predicted, 638 measured;
  - the HUD-frame uprights at +-6.5 degrees give x 681 and 919 predicted, 672-688
    and 912-928 measured;
  - the frame's bar at +4.5 degrees gives y 368 predicted, 360-376 measured.
- A live F-16 frame from the cockpit engineer's F2 work matches the grid to a few
  pixels: bezels, screens, coaming and frame.
- The layout reproduces the observed key-hint line at y 871-880 on a 900-row window.

## What the cockpits occupy (1600 x 900)

At 1920 x 1080 every figure scales by exactly 1.2, because the lens is
horizontal-fixed.

| deck | screens (x / y) | bezels | deck top |
| --- | --- | --- | --- |
| trainer | gauges x 586-1014, y 668-900 (ASI, attitude, altimeter; VSI, engine) | none | glareshield x 532-1600 from y 602 |
| F-16 | port 450-616, starboard 984-1150, from y 794 | port 412-658, starboard 942-1188, from y 764 | coaming from y 638; HUD frame x 672-928, y 358-712 |
| Global | port-outboard 424-780, port-inboard 820-1178, from y 760 | 408-1192 from y 742 | glareshield from y 634 |
| 747 | port-PFD 646-954, port-ND 990-1298, port-EICAS (upper page) 1332-1600+, from y 746 | from y 730 | glareshield from y 614 |

The Global's and 747's starboard screens are off the frame to the right.

## Where the HUD sat (the old layout)

Each cell is the share of the element's box over screens + bezels | over deck surface
(glareshield or panel).

**1600 x 900:**

| element | trainer | F-16 | Global | 747 |
| --- | --- | --- | --- | --- |
| key hints (text, x 398-1202, y 871-880) | 33 \| 52 (VSI, engine) | 60 \| 40 (both MFDs, both bezels) | 97 \| 2 (both port screens) | 70 \| 0 (PFD, ND) |
| ACTUAL panel (x 1282-1572, y 755-846) | 0 \| 100 | 0 \| 29 | 0 \| 100 | **99** \| 0 (upper EICAS 83) |
| instrument strip (x 28-444, y 779-846) | 0 \| 0 | 6 \| 45 (port bezel, 22-28 px deep) | 9 \| 0 | 0 \| 0 |
| session line, tapes, attitude, alerts | 0 \| 0 | 0 \| 0 | 0 \| 0 | 0 \| 0 |

**1920 x 1080:**
- key hints: 38 / 57 / 99 / 74 % screens on trainer / F-16 / Global / 747.
- ACTUAL panel: 100 % on the 747's upper EICAS.
- Instrument strip: 0 % on the F-16's bezel. The fixed-pixel HUD no longer reaches
  it, because the bezel starts at x 500.

At 1280 x 720, 4:3 (1600 x 1200) and 21:9 (2560 x 1080), the worst element still
covered 89 %, 71 % and 99 % screens.

## The rule

**In cockpit view, nothing of the HUD draws below the deck line.** The deck line is
the row where the airframe's glareshield, panel, screens and bezels begin, less a
12 px margin. The cockpit lens is horizontal-fixed, so on a window W x H that row is

    H / 2 + (W / 2) * k,    k = tan(cockpitDeckLineDegrees) / tan(37.5 degrees)

on every window shape. In CSS that is `calc(50% + 50vw * k)`, so the rule follows a
resize with no script. Since the hybrid lens (below) the half-width term stops at a
16:9 window's: `H / 2 + min(W / 2, 8H / 9) * k`, in CSS
`calc(50% + min(50vw, 88.889vh) * k)`.

`cockpitDeckLineDegrees` is a new catalogue field, measured on the built kit by ray.
Each column is walked down to its first deck hit and bisected to 1e-4 degrees, with
a coarse pass and a fine pass (`measureDeckLineDegrees`). The fine pass matches an
exhaustive 1,600-column search exactly on all four decks.

| deck | survey (2 px grid) | bisected, in the catalogue | k |
| --- | --- | --- | --- |
| trainer | 8.29 | 8.31 | 0.1904 |
| F-16 | 10.22 | 10.19 | 0.2343 |
| Global | 10.01 | 10.00 | 0.2298 |
| 747 | 8.94 | 8.99, on the kit before K1 | 0.2062 |

The survey's figures read 1-2 px high, because they took the first 2 px cell's top
edge. The F-16's bisected 10.19 agrees with its own test's -10.2 +- 0.1. The 747's
eye moves and its glareshield is rebuilt in the cockpit kit's K1, so its value and
its ray assertion belong to that MR.

**Exact on any window shape.** Babylon's own horizontal-fixed camera was built at each
of 1280 x 720, 1600 x 900, 1920 x 1080, 1600 x 1200 and 2560 x 1080. On every deck it
finds the first deck row within 2 px of the formula. Every screen, gauge and bezel on
all four decks lies below the line, so the rule alone keeps the HUD off every
instrument.

## The layout (the PM's decisions), cockpit view only

`Hud` adds the class `flight-hud--cockpit` and one inline custom property,
`--deck-k`, only when the camera is the cockpit. Every rule in `flight.css` that
places anything for the cockpit is scoped under that class.

- **Bottom group to a top band.** It sits at 60 px, under the session line: the
  instrument strip top-left and the ACTUAL panel top-right, including in the minimal
  HUD. Up there is roof, posts, the overhead, the 747's interior, or sky. Nothing on
  any deck carries information there.
- **Key hints always shown,** at 42 px, between the session line and the band.
- **Session line, tapes, attitude and alerts stay.** Two guards:
  - the attitude box (340 x 230, centred) is clipped at the deck line, because its
    pitch ladder moves with pitch;
  - the tapes' top is `min(50%, deck line - 85 px)`, so they rise on tall windows.
- **Diagnostics overlay** (debug, off by default) moves to 163 px, below the band.
- **F-16: no change.** The 2D ladder, aircraft symbol and heading box sit inside
  the real HUD frame. The 300 px horizon line crosses its uprights (see the
  correction below).

**Measured result:**
- **Overlap:** on all four decks, at all five window shapes, with the full, minimal
  and alert HUDs, no element lies over a screen, bezel, glareshield or panel pixel.
- **Clearance:** the attitude box clears the deck line by at least 7 px (trainer,
  1280 x 720) and by 37-111 px at 16:9 from 1600 wide up. The tapes clear it by at
  least 37 px.
- **Real stylesheet:** checked in Chromium with the real `Hud` markup at the five
  shapes, the layout lands where the Node model places it, to within 0.39 px.
- **The one clipped pixel:** at 1280 x 720 the trainer's heading readout reaches
  1 px past the margin, and the attitude clip cuts it. The glareshield itself is
  still 12 px below.

## Tests

`tests/ui.hud-cockpit-deck-line.test.ts` holds each deck's catalogue value to its
built kit, by ray, within 0.02 degrees: trainer, F-16, Global. Not the 747, for the
reason above.

`tests/ui.hud-cockpit-layout.test.ts` holds five things:
- **Exterior markup.** Every camera but the cockpit renders byte for byte the markup
  captured from the unchanged component on `de91cef`
  (tests/fixtures/hud-exterior-markup.json): every airframe, both visible HUD modes,
  cruise and alert states, the metric and mouse variants, 50 cases.
- **Cockpit markup.** It differs from the chase view's by the class and `--deck-k`
  alone, and `k` is the catalogue's deck line through the renderer's lens. The
  renderer's camera is held to horizontal-fixed, which the rule needs.
- **Stylesheet.** Its cockpit rules are all scoped under the class, carry the layout
  module's numbers (`src/ui/cockpitHudLayout.ts`), and nothing else reads
  `--deck-k`.
- **Deck line, five shapes.** Each deck's first row sits within 2 px of the rule, and
  there is nothing of any deck above it.
- **Zero overlap, five shapes.** Four decks and three HUDs, with the element boxes
  read from the stylesheet (`tests/support/cockpitHudModel.ts`). A deleted layout
  rule sends its element back to the chase view's place, onto the screens, and the
  test fails.

Mutations, each run against both files and restored. All were caught:

| mutation | caught by |
| --- | --- |
| `Hud` stops writing `--deck-k` | the cockpit markup test |
| the key-hints rule deleted (hints back on the screens) | zero-overlap at all five shapes |
| the cockpit class applied in the chase view | the exterior markup pin, the cockpit markup test |
| the F-16's deck line off by 3 degrees | its ray assertion; the deck line at all five shapes |
| the 747's deck line off by 3 degrees | the deck line at all five shapes |
| the bottom-group rule deleted | zero-overlap at all five shapes |
| the stylesheet's margin 12 -> 0 | the stylesheet-numbers test |
| the minimal HUD's ACTUAL rule deleted | the stylesheet-numbers test |

The PM's phrase for the first mutation was "k dropped (hints land on a screen)". In
this layout the hints no longer depend on `k`: they sit in the top band. So that case
is split in two: `--deck-k` dropped, and the hints rule deleted. Both are caught.

## Frames

Taken 2026-09-23, 20:43-20:46. The dev server ran on port 3021 from this worktree
with `--strictPort`; its `/@fs` check answered 200 for this tree and 403 for the
main checkout. The frame tool was the cockpit engineer's scripts/cockpit-frames.mts,
which asserts the live eye, the lens and horizontal-fixed from the scene. Air pose,
scenic start.

- **1600 x 900, all four decks.** The instrument strip is top-left, the ACTUAL
  panel top-right and the key hints under the session line.
  - Every gauge (trainer), both MFDs (F-16), the PFD and ND (Global) and the PFD,
    ND and upper EICAS (747) are wholly clear.
  - The tapes and the attitude sit above each glareshield.
- **1680 x 720, the F-16.** The coaming begins at about y 557, against the rule's
  556.8, and the whole HUD is above it.
  - At this aspect the MFDs themselves fall almost wholly below the frame. That is
    a cockpit framing question, not the HUD's.

## Corrections to the survey

The survey said the F-16's 2D symbology fits between the HUD frame's uprights (the
90 px ladder line). The horizon itself (`.attitude__horizon`) is 300 px wide, so it
crosses each upright by about 20 px, faded by the attitude box's radial mask. The
live F2 frame shows exactly that. The decision (no change) stands.

## Look items, and the hybrid lens (2026-09-23)

**Survey, on `99ffed3` (747 deck 18.57).** Every screen, bezel and dial was
projected from the kits' own constants (`jetMfdPlacements`, `bizjetScreenPlacements`,
`airlinerScreenPlacements`, `trainerDialPlacements` and their sizes) through the
gameplay lens. Each top edge was checked against the ray grid's first drawn row:
within 2 px on all four decks. The HUD's boxes come from the stylesheet model.

- **Overlap: 0 px everywhere.** The check covers 9 HUD elements, 4 airframes,
  7 windows (16:9 at four sizes; 21:9 at 1680 x 720, 2560 x 1080 and 3440 x 1440)
  and 4 HUD states. The nearest element to any display is the attitude box above
  the trainer's dials: 66 px at 1280 x 720, 104 px at 1600 x 900.
- **The 747 over its EICAS: 0 px.** The ACTUAL panel sits in the top band, 665 px
  above the upper EICAS at 1600 x 900.
- **The limit is the lens, not the HUD.** A horizontal-fixed 75 degree lens puts the
  frame's bottom 23.35 degrees under the eye at 16:9 and 18.20 at 21:9. Of each
  display's rows, this much was in frame:

| deck part | degrees below eye | whole up to W/H | 16:9 | 21:9 |
| --- | --- | --- | --- | --- |
| F-16 MFD screens | 18.2-26.3 | 1.55 | 62 % | 0 % |
| Global screens | 16.6-28.0 | 1.44 | 57 % | 13 % |
| 747 PFD, ND, upper EICAS | 20.0-28.4 | 1.41 | 38 % | 0 % |
| 747 lower EICAS | 29.7-36.8 | 1.02 | 0 % | 0 % |
| trainer lower dials | 18.0-23.9 | 1.71 | 86 % | 2 % |

  At 21:9 not even the 747's glareshield lip was in frame (it leaves at W/H 2.28).
  The 747's 38 % at 16:9 is the kit's geometry: no 16:9 lens fixes it short of a
  look-down or moving the displays. It is registered as a 747 K-item for Jason's
  look.
- **The HUD never meets itself.** The tapes' top stays at least 70 px under the
  top band down to the stylesheet's smallest window (820 x 650), and at least
  124 px under it at 21:9.

**The hybrid lens (the PM's decision).**
`cockpitHorizontalFieldOfViewForAspect(override, aspect)` in
`src/render/cameraPresentation.ts`:
- **Up to 16:9** it returns the 75 degree lens, the same number, so no 16:9 frame
  moves.
- **Wider**, it holds the 16:9 vertical field (46.69 degrees) and grows sideways:
  90.4 degrees at 21:9, 91.3 at 2560 x 1080, 91.8 at 3440 x 1440. Every display then
  shows at 21:9 exactly the rows it shows at 16:9.
- **The perf rig's lens is an override** and never changes.

The renderer resolves it every frame from the canvas's CSS size, the window shape
the HUD's stylesheet reads too. It does not use the render raster: in the first
21:9 frame run the raster's rounding under a fractional render scale gave 91.325
degrees against the window's 91.309, and the frame tool refused it. The same
rounding could have put a 16:9 window past 16:9 and moved its 75 degrees. The
HUD's half is the stylesheet's `min(50vw, 88.889vh)` in the deck line and the
attitude clip; the markup is unchanged.

**What it costs.** At 2560 x 1080 the frustum is 1.333 times as wide and 1.333
times as tall as the plain lens there. **Its cross-section is 1.78 times the plain
lens's and 1.33 times 16:9 play's, so a 21:9 player pays roughly that in world
draw**: terrain, vegetation and cloud. 16:9 and narrower windows pay nothing. At
3440 x 1440 the factors are 1.81 and 1.34. These are geometry, not a measurement.

**Tests.**
- **`tests/render.cockpit-hybrid-lens.test.ts`** holds the lens:
  - exactly 75 on every 16:9 and narrower window;
  - the 16:9 vertical held from 1.78 up;
  - the breakpoint pinned from both sides;
  - the perf override untouched at every aspect.
- **Display shares** (same file): every display is at least as visible at 21:9 as
  at 16:9, with the same rows, from the kit constants. A positive control holds 25
  displays' top edges to the ray grid within 0.94 px at 1600 x 900 and 2560 x 1080.
  A CONTROL keeps the plain lens's 21:9 losses (F-16 0 %, 747 0 %, Global under
  15 %).
- **`tests/ui.hud-cockpit-layout.test.ts`** now reads the predicted deck row FROM
  THE STYLESHEET. Its camera (`tests/support/cockpitFootprints.ts`) sees each window
  through the aspect lens, at seven shapes including the three 21:9 ones. So a
  stylesheet that loses its 21:9 term, and a lens that moves its breakpoint, both
  fail on geometry.
- **Mutations: 14, all caught.**
  - The breakpoint moved to 1.7 or to 1.85, and `>=` at the breakpoint. The last is
    caught only because the formula's float at exactly 16:9 is not bit-equal to 75.
  - The perf override widened; the hybrid removed; the wrong vertical held; the
    infinite-aspect guard removed.
  - The renderer back on the fixed lens (caught by the source scan, since the
    renderer cannot run in Node).
  - The stylesheet's deck line without `min()`, or capped at 100vh; the attitude
    clip without `min()`; the layout module's row without the cap.
  - Both instruments mutated: the footprint camera on the fixed lens, and the model
    ignoring the cap.
- **`scripts/cockpit-frames.mts`** now expects the lens the renderer resolves for
  its window, so a 21:9 frame is asserted against 91.3 degrees rather than refused.

## Not addressed

- **Windows narrower than 820 px or shorter than 650 px.** The stylesheet's own
  breakpoints shrink the tapes, hide the strip and move things. The rule still holds
  there by construction, because the tape clamp uses the larger 170 px tape, but the
  footprint tests sample only the five shapes above.
- **The diagnostics overlay** is not in the footprint test. It is a debug view, off
  by default.
