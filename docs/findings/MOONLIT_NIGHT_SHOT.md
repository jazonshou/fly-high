# `night-moonlit` — shot definition for the PM to land

Insert immediately after the `night` block in `scripts/perf-capture.mts`.
`ceilings`, `drawCallCeiling` and `minMeanLuminance` are deliberately `null`
and get pinned from the R4 run, per your instruction.

```ts
  {
    name: "night-moonlit",
    description: "Approach pose at 23:45 solar time under a full moon 17.6 deg up",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    /**
     * **Day 179, not 171, and not 356.** The shipped `night` shot sits at day
     * 171, where the moon is 0.4985 lit and **0.62 deg above the horizon** --
     * essentially set. Its ground illuminance is 2.573e-4 lx against a
     * full-moon 0.267 lx: **1038x dimmer**, i.e. effectively moonless. Gate 7A
     * shipped the moon, scotopic vision and the star field validated against a
     * set with no moonlight in it.
     *
     * **The dimming is ALTITUDE, not phase, and the distinction is
     * actionable.** Decomposed: phase contributes ~10.8x, altitude ~88x. A fix
     * that chooses a fuller phase without checking altitude gains ~11x and
     * still ships a moonless frame -- a plausible fix that leaves the defect
     * standing. **The moon is above the horizon on only 188 of 365 days at
     * this solar time**, so choosing a night-shot day without an altitude
     * check is a coin flip, which is how the original shipped.
     *
     * Day 179: lit **1.000**, altitude **17.6 deg**, 7.094e-2 lx --
     * **276x brighter than the `night` shot** and 3.8x dimmer than a zenith
     * full moon.
     *
     * **Day 356 was rejected despite being the year's brightest (72.4 deg,
     * 1.00x full).** `dayOfYear` drives the snowline (R-13's seasonal
     * descent), the land-cover classification and ground-cover density, so at
     * latitude 45 day 356 is WINTER: the shot would differ from `night` in
     * **two** variables and could not attribute an effect to moonlight, which
     * is the only reason it is being added. Day 179 holds the season eight
     * days away. Full-moon-on-snow is a real and untested case -- the hardest
     * one for the scotopic range's top end -- and is deferred to Phase 7 as a
     * deliberate two-variable shot with that purpose stated.
     *
     * Verify with `scripts/moon-night-shot-probe.mts`, which composes the
     * renderer's own call chain rather than re-deriving the astronomy.
     */
    clock: { dayOfYear: 179, solarTimeHours: 23.75 },
    // Same structural jitter as `night`: the scotopic pass half-saturates at
    // the scene's key luminance, so it applies a large gain to a dark image
    // and amplifies the cloud pass's temporal jitter along with it. A moonlit
    // frame is brighter and should be steadier, but the relaxation is carried
    // over rather than tightened on an assumption -- pin it from the R4 run.
    ssimThreshold: 0.96,
    minMeanLuminance: null,
    ceilings: null,
    drawCallCeiling: null,
    comparesToBaseline: false,
  },
```

## Two things that go with it

**1. Add `night-moonlit` to the flip list.** It is a sixth new shot, so
`scripts/r4-flip-compares-to-baseline.mts`'s `NEW_SHOTS` needs it or it stays
blind after promotion. I have NOT edited that file's list yet because the shot
is not landed; say the word and it is one line.

**2. The run count is 30 shots, and the blade analysis needs a SECOND short
run.** `VITE_PERF_HIDE_VEGETATION` and `VITE_PERF_REBASELINE` are **mutually
exclusive, thrown at import** (`tests/perf/perf-capture.test.ts:136`) -- a
vegetation-free frame is a diagnostic mask, never a baseline. `VITE_PERF_SHOTS`
is *also* mutually exclusive with rebaseline, but **not** with hide-vegetation.

So the host needs:

```bash
npm run perf:capture:candidate
```

then, at the same commit:

```bash
VITE_PERF_HIDE_VEGETATION=1 VITE_PERF_SHOTS=grove-forest-2m,grove-meadow-2m,ground-2m-lowsun npx vitest run tests/perf/perf-capture.test.ts
```

The second is three shots, not thirty. Without it `ab-shape.mts` has no mask
and the blade verification cannot run -- which would leave the one change
nobody has visually confirmed as the one change nobody visually confirms.
