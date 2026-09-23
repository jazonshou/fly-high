# The 2D HUD in cockpit view: keeping it off the instruments

**Status: built on `jazonshou/cockpit-hud-layout` from `de91cef`. Node tests and a
Chromium check of the real stylesheet are green; the in-game frames wait for a GPU
window.**

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
resize with no script.

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
- **F-16: no change.** The 2D attitude symbology sits inside the real HUD frame.

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

## Corrections to the survey

The survey said the F-16's 2D symbology fits between the HUD frame's uprights (the
90 px ladder line). The horizon itself (`.attitude__horizon`) is 300 px wide, so it
crosses each upright by about 20 px, faded by the attitude box's radial mask. The
live F2 frame shows exactly that. The decision (no change) stands.

## Not addressed

- **Windows narrower than 820 px or shorter than 650 px.** The stylesheet's own
  breakpoints shrink the tapes, hide the strip and move things. The rule still holds
  there by construction, because the tape clamp uses the larger 170 px tape, but the
  footprint tests sample only the five shapes above.
- **The diagnostics overlay** is not in the footprint test. It is a debug view, off
  by default.
- **Frames.** One per deck at 16:9, and the F-16 at 21:9, wait for a GPU window.
