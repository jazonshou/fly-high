# Pinning the ocean's cascade cadence at each perf shot's time pin

**Status: built on `jazonshou/ocean-cascade-pin` from `8d31fd2`; harness-owner review approved 2026-09-22 (plane engineer); merge is the PM's.**

## The defect

A water shot's waves depended on how many frames every *earlier* shot of the
capture had streamed.

The ocean evolves each wave cascade only on the frames its cadence allows —
every 1, 1, 2 and 4 frames on tier 1 (`shouldUpdateOceanCascade`) — and counts
frames on a counter that one renderer carries across all 39 shots. The harness
already pins simulation *time* per shot, after streaming, so time was never the
problem. But the streaming loop before each shot is paced by wall-clock time, so
the *frame count* at a shot's capture varied between runs of identical code, and
its residue decided whether the every-4th-frame cascade (128-512 m waves) was
last evolved at the capture frame or two frames before it (streaming counts are
multiples of 30, so histories always differ by an even count).

Measured 2026-09-22: two phase classes per static water shot, 0.12-0.40/255
mean apart over 13-51 % of the near sea depending on the shot (`water-400ft-glitter`
at the low end, `water-3m` at the high), flipping between runs with no code
change and wholesale under `VITE_PERF_SHOTS`.
It tripped that day's water review, and the alpine-turf A/B attributed it to
glints "seeing the land through the reflection probe" — a probe that renders
only the sky.

## The fix

The frame counter became `OceanCascadeClock`, a small class beside
`shouldUpdateOceanCascade` in `nature/OceanConfig.ts`, which the ocean's compute
ticks. The harness calls `renderer.pinOceanCascadePhaseForCapture()` where it
already sets `simulationTime`, and that reaches `OceanCascadeClock.pinForCapture()`
through the ocean. Production never calls it: mid-flight it would dispatch the
slow cascades out of turn. A source-scan test holds that line.

**Foam is deliberately left alone.** It integrates — each derivation reads the
previous foam and decays it with a 2.8 s half-life — so about a fifth of its
pre-pin state survives the 6.6 s to capture. That is a named floor, not a
defect: on near water between captures whose *own* streaming counts differ, it
grows with that difference and was still rising at the largest gap seen (mean
|dL|/255 over `water-25ft`'s sea, x 0-1280, y 140-500: 0.0069 at 60 frames and
0.0116 at 150 from same-tree pairs; 0.0092 at 90 and 0.0130 at 240 from
cross-tree pairs of matching cascade state; worst pixel ~16/255, in the glitter
path). It is not the only history the settle leaves behind — see "State the pin
does not touch" below. The harness comment that claimed the settle "rebuilds
all temporal state (… foam decay)" now names all three.

## Tests

Each has its unpinned twin as the positive control, because a determinism test
that passes on the broken code is a test of nothing.

- **`tests/render.ocean-cascade-pin.test.ts`** (Node) drives the shipped clock
  through the harness's own frame sequence. Unpinned, it splits the six measured
  full-capture histories (run1-run4 and the alpine-turf OFF/ON pair) into
  exactly the two classes their pixels fell into, and a 2-frame
  history difference moves the every-4th cascade and no other. Pinned, every
  history on every cadence any tier runs gives one schedule. Source scans hold
  the pin to the renderer → ocean → clock chain under `src/`, to the perf harness
  alone outside it, and to its place after the time pin and before the settle.
  One more scan, added on the harness owner's review, holds the ocean's
  frame-graph pass to no `cadence` and no `enabled` predicate: either would let
  the frame graph's own frame index — unpinned, carrying every earlier shot's
  streaming — decide which frames tick the pinned clock, and every other test
  would stay green. Verified to fail with `cadence: 2` and with
  `enabled: () => true` added to the pass.
- **`tests/gpu/ocean-cascade-pin.test.ts`** (GPU) builds the shipped ocean, runs
  two pre-pin histories two frames apart, and reads every cascade back texel by
  texel. Unpinned, only the every-4th cascade's displacement differs. Pinned,
  displacement, slope, jacobian and slope moments are bit-identical on all four
  cascades, and foam is bounded at its measured floor (8.98e-3, 5.38e-3, 2.40e-3
  and 0 per cascade, identical over repeated runs; the 128-512 m cascade carries
  no foam because swells that long do not break).

Verified to bite: with the pin stubbed out, the pinned GPU test fails on
exactly cascade 3's displacement; with foam's decay disabled, the carried foam
grows 5.8x and the bound fails. (A 2.8 s half-life over 6.6 s leaves 0.196 of
the pre-pin difference, so full carry-over "should" be ~5.1x; disabling decay
also changes the pre-pin difference itself, so the match is only approximate.)
The foam bound is 0.014, set from measurement rather than headroom-by-eye: the
shipped floor is 8.98e-3, and the same test with the foam half-life at 1.5x
reads 1.54e-2, at 2x 2.03e-2. The bound sits geometrically midway between the
shipped floor and a doubled half-life, so it catches the doubling with 1.45x to
spare and passes the shipped ocean with 1.56x. The first bound, 0.03, let a
doubled half-life through while its comment said it would not; a stalled
reviewer was probing exactly that when it stopped.

Three things went wrong on the way, recorded because each would have produced
a misleading green:

1. A "the pin keeps each cascade's cadence" test passed with the pin stubbed
   out. The pin precedes the window, so it would pass for any pin, including
   none. It was removed.
2. The GPU test first hung on its first readback. Compute submissions and
   readbacks resolve at frame boundaries; it needed the house pattern of an
   empty render loop (as `ocean-slope-mips` does), not `beginFrame`/`endFrame`
   bracketing, which left the readback's copy unsubmitted.
3. Batching thirty ocean updates per engine frame kept the wave field
   bit-identical but made **foam** differ between two runs of the same test
   (cascade 2 read 2.82e-2 then 5.74e-3). One ocean frame per engine frame, as
   the harness renders them, made it stable and showed the true floor is about
   seven times smaller than the batched runs suggested.

## Evidence: filtered re-captures, pinned and unpinned

Captured 2026-09-22 on this M2 Pro with `VITE_PERF_UNPINNED_HOST=1`, unpinned
tree `8d31fd2` against pinned tree `83641a9`. Every arm wrote a fresh
`report.json` inside its own run window (the stale-report trap was guarded).

### Same list, repeated — the fair test

Shot list `water-25ft,water-3m,water-400ft-glitter`, captured three times on
each tree. The list fixes everything that crosses between shots, so only the
wall-clock streaming varies — and it did: `water-25ft` streamed 1170, 1020 and
1110 frames unpinned, 1260, 1110 and 1110 pinned. The cockpit water shots always
streamed exactly 360 frames of their own, so they carry no foam floor of their
own. The sky moved 0.0000-0.0013/255 in every pair, and that residue is BIRDS:
the one piece of global state that did differ, because the wildlife clock is not
pinned (see below).

| pair | histories | water-3m sea | water-400ft-glitter sea |
| --- | --- | ---: | ---: |
| unpinned, cross-class | differ by 2 mod 4 | **0.393 mean, 51 % moved** | **0.118, 13 %** |
| unpinned, same-class | differ by 0 mod 4 | 0.0000 | 0.0000 |
| **pinned, cross-class histories** | differ by 2 mod 4 | **0.0000** | **0.0000** |
| pinned, same-class | differ by 0 mod 4 | 0.0000 | 0.0000 |

Pinned captures whose histories land in opposite classes are bit-identical on
the sea; the unpinned pair with the same kind of history difference moves half
of it. "Identical" is to within a few dozen 1-LSB pixels on `water-3m` (about
0.01 % of the sea): the previous shot's foam floor, about 4 % of it surviving
this shot's own streaming and settle. `water-25ft`, whose own count differed
(1260 vs 1110), differs by 0.0116 — the foam floor at 150 frames — against
0.0069 at 60 frames unpinned.

An independent check drove the shipped clock through every arm's real streaming
counts: one starting value fits, and it predicts which of all 24 captures match
and which differ, including pinned-against-unpinned pairs not compared above.

### Different lists — not what the pin is for, and worth knowing

The first round compared two *different* lists: the three water shots alone,
against the same three after `approach-500ft,high-10000ft-down,night`. There the
pinned captures differed about as much as the unpinned ones (`water-3m` 0.44 vs
0.50 mean), because the **sky moved too** — 1.01-1.25/255 mean over the sky,
brighter under list B, and IDENTICALLY in both trees (it does not depend on the
pin or on streaming counts). That is state carried between shots (the preceding scenes, `night` among
them), not the ocean, and no ocean pin could remove it. It is the known result
that a shot arrives with a different history under a different list:
[PERFORMANCE.md](../PERFORMANCE.md) requires FULL captures for ceilings for
that reason, and [WATER_COLOUR_2026_09_17.md](WATER_COLOUR_2026_09_17.md)
measured a filtered water shot 0.5-0.8/255 away from its full-run frame.

**So the pin makes any run of a given list reproducible on the sea, apart from
the floors named here. It does not make a filtered run comparable to a full
one.** For full 39-shot runs this is predicted, not measured: no full capture
was taken on the pinned tree. It is the same mechanism with a longer list, and
the model above that predicts all 24 evidence captures says the same. Water
baselines must still come from full runs, as they always have.

## What merging does to the baselines — read this before any A/B

The pinned capture always lands on frame 395 after the pin, an odd frame, so its
cascade state is fixed at (every-frame, every-frame, every-2nd, every-4th)
staleness (0, 0, 1, 2). The committed baselines were captured unpinned, each in
whichever class its run happened to give it. So **merging this moves the sea in
water shots**: some committed baselines happen to sit in the pinned state
already, and for about half the pinned state is an ODD frame offset from both
unpinned classes, so the every-2nd-frame (32-128 m) cascade moves as well as the
every-4th. Measured on the evidence: an unpinned capture against a pinned one of
the same list differs by 0.373/255 over half of `water-3m`'s sea.

Two consequences:

1. **The first full capture after the merge is a re-baseline for water.** That
   is the intended end-of-wave re-baseline; this lands before it so those
   baselines are captured pinned.
2. **No A/B may straddle the merge.** A pinned arm against an unpinned arm shows
   a sea difference of 0.1-0.4/255 that has nothing to do with the change under
   test. Both arms must be on the same side.

## State the pin does not touch

- **Foam** — the named floor above.
- **Birds.** The wildlife system advances its own fixed-step clock on every
  render, streaming included (`FlightRenderer.ts` `wildlife.update`), so birds
  and their shadows sit elsewhere between runs. On pinned repeats with an
  identical sea they alone swing `water-400ft-glitter`'s worst-tile SSIM against
  its baseline between 0.9784 and 0.9953 — a bigger swing on that gate metric
  than the ocean's own same-class pair.
- **Cloud jitter.** The volumetric clouds' raymarch and shadow jitter index is
  that system's own frame count mod 4096, never reset. No sky change from it was
  measurable on these water shots (skies moved at most 0.0013/255 across runs
  whose counts differed, and that residue was birds).

## Not addressed, and why

- **Birds — registered follow-up (PM, 2026-09-22): pin the wildlife for
  captures.** Routed after the end-of-wave re-baseline, because its swing on
  `water-400ft-glitter` is bigger than the ocean's and will bite the
  promotion's reproduction check. Note for whoever builds it: pinning the
  clock alone will not do it. `WildlifeSystem`'s `FixedStepClock` only holds
  the step accumulator; the birds' positions are agent state integrated since
  each agent spawned, which is every frame of streaming. Spawning is already
  deterministic (seeded per cell in `wildlife/generation.ts`), so the likely
  shape is a capture-only respawn of the population plus a clock reset at the
  time pin — the same place and the same "capture only" rule as this pin.
- **Other frame counters.** The frame graph can gate passes on
  `frameIndex % cadence` and `runsEvery(interval)`, and the cloud runtime policy
  keeps its own frame index. Nothing currently uses the frame-graph cadence, and
  the six full captures showed skies and terrain bit-identical across runs, so
  neither is flipping anything visible today. Same shape of defect, latent.
- **Foam.** Left as the named floor above. Removing it would need a foam reset
  or a longer settle, both larger than the defect they would fix. It was still
  rising at a 240-frame own-count gap; under heavy machine contention a shot's
  own count can swing further.
- **Tier 2 and Ultra** (five cascades, an every-8th cadence) are covered by the
  Node schedule test only; the GPU and pixel evidence is tier 1.

## Review

An adversarial review ran four lenses (fix correctness, test quality, evidence,
harness-owner concerns) and a synthesis critic. All four lens reviewers stalled
and returned nothing, so the critic verified the change itself: no blockers; the
clock does exactly what the removed counter did, so production is unchanged;
the pin is placed once per shot between the time pin and the settle and nothing
after it can skip an ocean tick (395 frames for static shots, 1019 for motion
shots); the mechanism predicts all 24 captures; every pixel figure reproduced.
Its SHOULDs — the merge consequence, the birds and cloud jitter, and unsourced
foam-floor figures an earlier draft carried — are all addressed above. Before it
stalled, the test-quality reviewer re-ran the GPU test independently and
reproduced the foam floor exactly.

The harness owner (the plane engineer) then reviewed it independently from the
code and approved it. They re-derived the 395 and 1019 frame counts; confirmed
that every render ticks the clock exactly once (the ocean's pass has no cadence
and no enabled predicate, and the only per-frame skip, the budget probe's
override, is HUD-triggered and never called by the harness); confirmed that no
compute swap can land after a pin (the harness changes neither quality nor
rendering mode, and the ocean swaps its compute only on a topology change); and
checked the scotopic, resize and undrained capture modes. Their one
recommendation, a guard against the pass later gaining a cadence or an enabled
predicate, is the frame-graph scan under Tests. Their re-baseline runbook adds
a second full capture on the same tree as an A/A, which turns "full 39-shot
reproducibility is predicted, not measured" into a measured pinned noise floor
per shot.
