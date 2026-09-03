# R4 rebaseline — review brief

Written before the captures exist, so the reviewer meets each expected change
rather than discovering it. **An expected change is not a finding. An
unexpected one is.** That asymmetry is the whole point of writing this first:
a reviewer who does not know what should move cannot be surprised, and a
candidate that passed every automated gate was correctly refused on visual
review earlier tonight (`grove-forest-2m`, a forest floor rendering as a
meadow). Numbers do not substitute for frames.

**R4 promotes three pixel-moving changes in ONE sanctioned pass**, per the
phase's rule that no capture may be promoted between them:

| change | commit | area |
|---|---|---|
| inverted winding, cards + shrubs | `bbf3d27` | mid-band canopy |
| inverted winding, dense crown / rocks / grass / moss | `ed5b703` | near canopy, ground cover |
| land-cover law (`6-13`) | this one | terrain materials, everywhere |

---

## What each change SHOULD have done

### 1 + 2. The winding fixes (`bbf3d27`, `ed5b703`)

**Expect: canopy substantially brighter, and the brightening is NOT uniform.**
Crown pixels moved ~6–9x on the earlier measurement. `canopy-1200ft` diverged
to SSIM **0.5246 on `bbf3d27` alone** — that is expected and is not failure.

**Do not judge these by a mean.** `canopy-1200ft` is a bimodal population — lit
ground plus dark crowns — and the mixing ratio varies row by row with closure.
The same two PNGs gave opposite verdicts depending only on the statistic:
sRGB mean said uniform (x1.28 / x1.25), linear median said selective
(x2.29 / x1.09). §6-12's fifth general form records this. **Judge the frames.**

**Should NOT move:** anything with no vegetation in it. Open ocean, sky-only
regions, the runway surface itself.

**The band names lie, and this will otherwise produce a false finding.**
`prototype.crown` is **byte-identical across the near and mid bands** (oak 80
tris, pine 64). `DETAIL_OPAQUE_CROWN` is a define on the *material*, while the
same dense-crown geometry is drawn in the mid band through `crownMaterial`. So
the "near crown" fix in `ed5b703` was **in scope for shots whose ground range
sits entirely beyond the 150 m near edge**. If a shot moved that you expected
to be inert, check this before recording it as unexplained — it is the most
likely cause and it is not a stray change.

**A negative `worstTileRgbSsim` can mean the image got BRIGHTER, not inverted.**
Measured on `reference-viewport` at `ed5b703`: the worst tile scored **−0.1076**
while its luminance went **40.4 → 84.1 (x2.08)**. SSIM's structure term
correlates deviations from the local mean, and the lit leaf faces went from
sparse minority to majority — so the deviation field swapped polarity while the
tile got strictly brighter. **The discriminator, if you meet another one:** a
surface genuinely lit *inversely* would show different silhouettes or brightened
gaps. Identical leaf shapes with the inter-leaf gaps still black in both frames
means back-facing leaves are now correctly front-facing, which is the fix.
`scripts/worst-tile-locate.mts` answers this in one command — **look at the
tile, do not infer from the number.**

### 3. The land-cover law (`6-13`)

Two independent halves, both in this change:

**Half A — closure is now a gate, not a gain.** Forest litter was painted where
there is no forest: ForestFloor was the dominant material on **57.72%** of land
in a frame with 0.171% tree pixels.

**Half B — the slope partition.** `gentle` is now the exact complement of
`steep`, closing a band at slope 0.24–0.26 where every climatic material fell
to ~0 and `Sand`'s constant `+0.02` won by default.

**Expect, measured over 13,685 land probes:**

| material | before | after | note |
|---|---|---|---|
| Grass | 13.34% | **57.60%** | the headline — this is Jason's *"grass should be noticeably grass"* |
| ForestFloor | 57.72% | **10.63%** | litter recedes to where canopy actually stands |
| Rock | 18.77% | **18.93%** | **0.16 pp — NOT a rock increase.** If the frames show materially more grey, that is a finding |
| DryGrass | 8.70% | 11.63% | |

**Expect on the shipping path:** the bake was checked against the CPU law
directly (`tests/gpu/land-cover-bake-parity.test.ts`, reading `splatId` rather
than inferring from pixels): **82.97% agreement over 3,254 texels**, every
disagreement an adjacent-material boundary flip, ForestFloor **13.6%** baked.

**Flagged in advance — meet it, do not discover it:** the bake shows
**Sand 1.8%** where the CPU shows none, confined to low elevation. Almost
certainly the shore term `smoothstep(-1, 3, elevation)`, where the bake's own
height texels and the analytic field straddle the edge differently. Small, but
**inland Sand was the exact failure mode of half B**, so if the frames show
sand-coloured patches *away from the coast or above ~50 m*, that is a finding
and half B needs re-examining.

**Should NOT move:** the airport platform (paved materials are painted by the
SDF and are never climatic), open water, sky.

---

## SSIM has a noise floor of ±0.003 — do not read it as exact

Measured across the three R4 runs on an unchanged tree: **12 of 29 shots moved
their SSIM, up to 0.0028** (`cliff-60m` 0.7712/0.7712/0.7684). The cause is
mechanistic, not noise in the usual sense: **`residentTerrainPages` differs
between runs while `pendingTerrainPages` stays 0**, so the settled assertion
holds and what varies is *which* pages are resident. Residency is
path-dependent within a session.

**The discriminating detail: `approach-500ft` gained FOUR pages and moved
0.000000; `cliff-60m` gained one and moved most.** It is position in view, not
page count. So the renderer is deterministic given identical residency, and
residency is not identical.

Consequences for this review:
- **Do not quote SSIM to four decimals as though exact.**
- **Movement under ~0.003 is residency, not a finding.** A finding is movement
  materially above the floor.
- Delivery metrics still need ≥3 runs (host state). Pixel metrics need more
  than one run too — two runs agreeing is a sample of two, which is how this
  floor was missed in the first place.

## The canopy movement is NARROWED, not explained — do not file it either way

Resolved during R4, after two wrong hypotheses. Recording the conclusion **and
the two dead ends**, so nobody re-derives them.

**The impostor atlas is byte-identical across `bbf3d27` → `af6f6d8`.**
`planImpostorAtlas("phase1-perf-baseline")` at each commit, SHA256 over every
packed mip: albedo 9 levels / 4,893,336 B / `df2d6a13…`, normalDepth 9 /
4,893,336 B / `e3a03127…`, `layerCount=14`. Identical, not close — and it was
**predicted before it was measured**, from three properties of the rasterizer:
the barycentric coverage test divides by a *signed* area so a winding flip
negates numerator and denominator together; swapping `b`↔`c` swaps which weight
belongs to which vertex so interpolants are unchanged; and the one
winding-sensitive line, `layers[ia]`, reads the **first** index, which every
`(a,b,c) → (a,c,b)` reorder in `ed5b703` preserves.

**So: far-band sprites are unchanged. Any far-band movement comes from live
shading, not from the bake.**

**The live candidate is `twoSidedLighting` redistribution, and it needs only
one frame.** `crownMaterial` is `backFaceCulling = false, twoSidedLighting =
true`, so winding decides which fragments are back-facing and therefore which
get their shading normal flipped. `ed5b703` reversed the emitted index order on
crown hulls and conifer whorls, flipping that classification on a
**complementary subset** of fragments.

Binning `canopy-1200ft` by *prior* luminance: **dark ×1.294, lit ×0.831,
crossover ~0.045**; per channel R ×0.894, G ×0.897, B ×1.008 — direct-sun
channels down ~10%, ambient flat. **A shared factor would be flat across bins.**
It is a redistribution, not a shift.

**So expect vegetation to brighten in shadow and darken in sunlight IN THE SAME
FRAME, with terrain flat. File neither direction.**

**Status: NARROWED, not explained.** Attribution to `ed5b703` specifically
still rests on `prior/canopy-1200ft.png`'s provenance; a controlled same-session
A/B is settling that. **A cross-shot "sign inversion" claim was retracted** —
`prior/veg-seam-1600ft-oblique.png` turned out to be a vegetation-HIDDEN
capture, so that comparison put bare terrain against vegetation at vegetation
pixels. There is one measurement, not two.

**Two dead hypotheses, recorded so they are not revisited:**
1. **A shared multiplicative occlusion term** (`surfaceAlbedo * mix(0.42, 1.0,
   detailOcclusionDecoded)` arriving because `occlusionCompute` began running).
   Dead twice over: a shared multiplier **cannot change sign** between frames,
   and the proposed trigger — `ComputeBudget.take()`'s zero-cost branch — is
   **unreachable** in a capture, since GPU timing is off by default,
   `observeDispatchCostMs` discards non-positive samples, and no caller submits
   a zero cost.
2. **The winding fix changing the impostor bake.** Dead by the byte-identity
   above.

**A measurement trap that produced the second one, and would bite this review
too:** classifying pixels into mid vs impostor band by **ray-marched terrain
range** is wrong, because the march ignores vegetation and trees have height. A
mid-band tree at 1,100 m occludes a pixel whose terrain ray runs on to 1,300 m,
and the pixel is filed as "impostor". The error is systematic and
one-directional near the boundary. **Do not classify vegetation pixels by
terrain range.**

## Refusal criteria

A candidate is **not** promotable if any of these appear, regardless of gates:

1. **Grey/rock where the terrain is not steep.** Rock moved 0.16 pp; a visibly
   rockier world means half B's partition is wrong.
2. **Sand inland or above the shore band.** See the flag above.
3. **A material boundary that is a hard cut line rather than an ecotone.** The
   original defect was hard-edged blobs; if the edges are still hard, the
   closure gate fixed *which* material wins without fixing *how* it hands off.
4. **Canopy that is brighter but flat** — the winding fix should restore shape,
   not just level. A uniformly bright canopy is a different defect.
5. **Any movement on a shot with no vegetation and no terrain material in
   frame.** That is unexplained by all three changes and must be traced.

---

## Mechanics

**The shot set is 31, of which 8 carry `comparesToBaseline: false`:**
`motion-banked-turn`, `page-thrash-turn`, `cdlod-transition`, `water-3m`,
`veg-seam-1600ft-oblique`, `veg-seam-near-500ft`,
`terrain-material-1600ft-down`, `horizon-shadow-far-annulus`.

**The last four are the new P0/diagnostic shots and MUST flip to
`comparesToBaseline: true` in the same commit that promotes their baselines**,
or the set stays fatal-free but blind — it would pass forever while showing
nothing. The first four are pre-existing and their status is a separate
decision, not R4's to change silently.

**Floor re-pin: ≥3 clean runs, not one.** A single cool-host run samples the
favourable end of a ~20% thermal band, which was measured, not assumed. The
judgement about whether the host was clean enough is **not delegable** — the
same-tree spread on `reference-viewport` was 74.0 → 115.1 → 120.1 fps within
one session, so a two-run comparison can and did produce a −4.27% reading on an
unchanged tree.

**Ignore delivery numbers from any warm-host run.** R4's pixel questions
tolerate a warm host; its *floor* questions do not.

---

## Pins already moved by `6-13`, for whoever re-pins

| test | pin | moved by |
|---|---|---|
| `canopy-handoff` | absent-channel digest | **slope half only** — verified by reverting the slope change alone; the gate leaves it byte-identical |
| `canopy-handoff` | channel-live digest | both halves |
| `canopy-handoff` | movement bound 0.35 → 0.40 | both; measured 35.7% of probes change dominant material |
| `talus-scree` | three digests | slope half |
| `talus-scree` | rock counts 114/113/53 → 108/106/52 | slope half — **falling**, budget-safe |
| `talus-scree` | `midBand` 9 → **10** | slope half — **a COUNT, not a digest.** Inside the test's real invariant (< pre-6-7's 14) and every budget guard, and a boundary redistribution rather than a new rock regime — but flagged, not absorbed |
