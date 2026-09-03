# Instruments that answered instead of failing — 2026-09-02

Companion to `INSTRUMENT_FAILURES_2026_09_01.md`, which catalogues the previous
day. It is a separate file rather than a section there because that document's
title carries its date, and extending it would have made the title lie — the
exact failure both documents exist to catalogue. Neither is renamed: the 09-01
file is cited from `WHAT_CHANGED_2026_09_01.md` and the Phase 7 plan, and a
rename breaks every citation to buy a title.

**Scope.** Everything below was measured first-hand by the Phase 7 Lead. Other
sessions produced instrument failures on the same day; they are theirs to write
and are not reproduced here, because a catalogue entry written from a relayed
summary is the thing this document warns about.

---

## 1. A step detector that was a derivative

A "4.1σ vertical seam at x=236 in `mountain-close`" was carried as a real,
unexplained defect for a day. **It does not exist.**

The column profile through it has no jump anywhere:

    65.59 66.13 66.72 67.28 67.94 68.53 69.18 69.88 70.55 71.10 71.65 72.15

That is a smooth ramp, 62 → 74.8 luma over about 40 px. The reported seam is its
steepest point.

**The detector compared `mean(x−W..x−1)` against `mean(x..x+W−1)`.** That is a
finite difference — a derivative. It peaks wherever the slope is steepest and
**cannot distinguish a ramp from a jump**, because a ramp separates two window
means exactly as well as a step does. It could not have failed.

**What distinguishes them:** fit a curve either side and measure the offset where
the two extrapolations meet. A ramp extrapolates through and gives ~0. Fit
*quadratics*, not lines — on a curved profile, straight-line fits manufacture an
offset at every x out of the curvature alone, which produced a forest of fake
"8–11σ seams" scattered across the frame on the first attempt.

**The significance figure lied in the same direction**, which is what made it
convincing. A residual-based denominator measures how *smooth* the profile is,
not how *noisy* the measurement is. On a smooth curve the residuals are tiny, so
an **0.069 luma offset scored 8.4σ**.

**The decisive test is location stability across window size.** A real edge sits
at the same column whether the window is 8 px or 26; an artefact moves with it.

| candidate | top-5 slots across five window sizes |
|---|---|
| x=236–239 — the recorded seam | **0 of 25** |
| x=64 — a replacement candidate | 4 of 5, then **0 of 25** on a wider region |

The second is the sharper lesson: x=64 sat 24 px from the edge of the analysis
region and was **the crop boundary itself**. It appeared immediately after a
finding had been lost, which is the hardest moment at which to stay sceptical.

**A positive control on the DETECTOR, not the data, is what separated the two
questions.** Injecting a known +0.600 luma step returned +0.7774 — read first as
a 30% error, then seen to be exact once the column's own +0.1774 offset was
accounted for. **The detector was sound and the feature was not**, and without
that control there was no way to tell which.

**The retraction reached no document.** The only `vertical seam` string in the
repo is an unrelated material-array tile-wrap guard at
`tests/render.webgpu-material-arrays.test.ts:271`. A near-miss that left no trace
is still worth recording: had it been written down, it would have needed striking
in place rather than deleting.

---

## 2. The crop created the defect the fleet then hunted

**The most expensive instrument failure of the day, and it was in an image rather
than in code.**

A 2× crop was published to show detail without blurring, built with
`sharp(...).resize(w*2, h*2, { kernel: "nearest" })`. **Nearest at exactly 2×
duplicates every source pixel into a 2×2 block**, which is a near-Nyquist
amplifier. Measured on one patch, native against the same patch through that
pipeline:

| | near-Nyquist power |
|---|---|
| native resolution | **×0.3** — below the band median |
| through the 2× nearest crop | **×2.0** |

**Sevenfold.** A "fine regular cross-hatch, 3–4 px in the crop, so 1.5–2 px in
the source" was then read off that image, described to the user, confirmed by the
user, and became the fleet's top item. **An FFT of the native frame finds no
near-Nyquist peak at all**; the real content is a broad bump at 4–7 px.

**The user's complaint was genuine and predated the crop. What the instrument
manufactured was the number — and the number defined the hunt for four hours.**

**Rules.**

- **Never magnify with `nearest` for an image anyone will reason about.** It is a
  frequency-domain edit disguised as a zoom.
- Judge fine structure on native pixels only: `sharp(f).extract(box).png()` and
  nothing else. No resize, no JPEG.
- **The same rule binds the "before" frame.** Both arms through the same
  non-pipeline, or the comparison is worthless.
- **A fix judged through the pipeline that set the target is unfalsifiable.** A
  7× amplification of exactly the frequencies in question will show whatever the
  viewer expects to see.

**The cheap tell: when the eye and the instrument disagree about a picture,
suspect the picture.** The FFT found nothing where the crop plainly showed
something, and that mismatch was the whole of the catch.

**And it generalises past crops** — to every chart, composite and rendered
comparison this fleet puts in front of anyone. *A picture nobody has checked
against the source is not evidence, however many people have looked at it.*

---

## 3. What an A/A control cannot do

An A/A floor of 0.000% was established and used to license pixel-channel work
across the fleet while the timing channel was untrustworthy. That split is
correct and stands. **The limit is narrower than it was first stated.**

**Reproducibility is a property of the capture; validity is a property of the
estimator.** The A/A speaks only to the first.

- It **does** license comparing two arms differing only by a deliberate
  treatment. When two frames differ by 0.44%, that 0.44% is the treatment,
  because nothing else varies.
- It **does not** license "my detector found a feature, the feature reproduces,
  therefore it is real." **A deterministic pipeline reproduces an artefact of the
  analysis exactly as faithfully as a real feature**, because the artefact is a
  function of the data and the data is identical.

Stated as "proves reproducibility and nothing about validity", it would have
invalidated every A/B on the fleet, including the ones it correctly licenses.
Both halves are needed.

---

## 4. An estimator's own parameter setting the answer — third instance

A spectrum of band energies carried a "hole at 1.6–13 m" conclusion. It had been
validated across three **resolutions**, and that was treated as robustness. It is
not: it tested one axis, and it was the axis that happened to come to mind.

| band (m) | cubic | lanczos3 | mitchell |
|---|---|---|---|
| 1.6–3.2 | 1.57% | 1.38% | 1.82% |
| 6.4–12.8 | 2.17% | 1.89% | 2.97% |
| 12.8–25.6 | 4.10% | 3.81% | 4.02% |

**Absolute levels move by up to 44% with the resampling kernel.** The conclusion
survived at a thinner margin than had been quoted — the deficit is 2.7× under
lanczos3, 2.5× under cubic and **1.9× under mitchell**. Quote the most
conservative legitimate estimator, not the friendliest.

**The transferable half: ratios survive estimator choice, absolute levels do
not.** The same before/after deltas held under every kernel, because the kernel
largely cancels in a ratio. So report the change, give it as a range across
estimators, and treat any absolute level as carrying about a fifth of slop.

**Excluding a degenerate estimator is legitimate; state the test.** `nearest`
point-samples and therefore cannot measure band energy at all — it returned 0.00%
for two bands. Excluded for being degenerate, not for disagreeing.

**Sweep the estimator's own free parameter**: kernel, window size, fit order, bin
edges. §1 above is the same failure with window size as the parameter.

---

## 5. A pre-registration whose branches made the same prediction

Pre-registered thresholds were used throughout the day and repeatedly did their
job — five of eight stated predictions missed and were reported as misses. **One
arm failed anyway, for a reason worth recording.**

Doubling a material's tiling period was registered as a discriminator: *doubling
names the tile repeat, unchanged names an internal cell grid.* The arm returned
rows unchanged at 4.41 → 4.27 px, columns moving 1.62×, and amplitude up 64%
which neither branch predicted. Reported as ambiguous, which a third registered
branch had provided for.

**The post-mortem: rescaling a tiling period magnifies the texture's CONTENT and
its REPEAT together, so both branches predicted the same measurement.** A
pre-registered threshold does not help when the branches are not actually
separated by the instrument — **and that is checkable at registration time,
before the capture is spent.**

---

## 6. What these cost, and what they bought

The seam consumed a day as an open item and was closed for good by one afternoon
of measurement. The crop consumed roughly four hours across two sessions and
redirected the user's own attention onto a number that did not exist.

Against that: **five families were eliminated by measurement** on the pattern the
user actually reported — screen-space causes, the splat, shading, the tile
repeat, and recipe anisotropy — with the phenomenon localised to the material
detail normal map and confirmed world-space by a resolution sweep. None of those
eliminations rests on an instrument in this catalogue.

**The pattern across all six entries: every one was caught by INTERROGATING the
instrument rather than by running it more carefully.** In these six the
interrogation happened to take the form of a control — a positive control on the
detector, a synthetic field through the same filter, the native frame against its
own crop, a second estimator, a second window size.

**The control is the subset, not the rule.** Checked against the same day's
findings from other sessions, the same pattern holds in forms that are not
controls at all: a gutter unit mismatch caught by reading atlas values directly
after five mechanisms had died; a confounded varying caught by reading Babylon's
source when a conclusion felt too exotic; a clamped output caught by reading what
the function actually does; a single-sample constant caught by sampling a second
seed. Adding a control, reading the source, measuring the artefact directly,
sampling a second axis — **all four are questioning the tool, and none is using it
better.** That is the general form; the six above are one branch of it.

**Running the instrument more carefully would have caught none of them.**
