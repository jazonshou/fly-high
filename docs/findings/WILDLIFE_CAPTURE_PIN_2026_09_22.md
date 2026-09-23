# Pinning the wildlife at each perf shot's time pin

**Status: merged into House-Keeping at `0449de2` (2026-09-23), after the harness
owner's review. Checked on captures 2026-09-23 on `bd7a584`: three full runs,
every prediction held; see "Capture-side check, measured" below.**

Registered as a follow-up in
[OCEAN_CASCADE_PIN_2026_09_22.md](OCEAN_CASCADE_PIN_2026_09_22.md), after the
ocean pin left birds as the largest history-dependent residue in a water shot.

## The defect

A shot's birds were wherever the run's earlier frames had flown them.

The wildlife system simulates its animals on the CPU at a fixed 1/30 s step,
fed by each render's delta. The perf harness renders every frame at 1/60 s, so
the simulation is deterministic frame by frame — but it runs through every
render of the run: every earlier shot's streaming, settle and measurement, and
this shot's own streaming, whose length is wall-clock paced. Two runs of
identical code therefore captured the birds at different places. On
pinned-ocean repeats with an identical sea, birds alone swung
`water-400ft-glitter`'s worst-tile SSIM against its baseline between 0.9784 and
0.9953, a larger swing on that gate metric than the ocean's own.

## Three pieces of history, not two

The registration said a clock pin alone would not do it, because the birds are
agent state integrated since spawn. Reading the simulation found a third piece
of history. All three must be reset:

1. **The agents.** Positions, velocities, headings and animation phases are
   integrated state. `reconcilePopulation` also KEEPS an existing agent across
   a population rebuild whenever its id is still wanted, so a rebuild alone
   does not reset it.
2. **The fixed-step clock's accumulator** (`FixedStepClock`). It decides which
   renders take a step, and the interpolation fraction between steps.
3. **The simulation's step count** (`WildlifeSimulation.stepIndex`, never
   reset). It picks which far birds and ground animals run their AI on a
   given step (`(stepIndex + updatePhase) % stride`), and it is the clock of
   every bird's wander term (`sin(stepIndex * dt * 0.83 + phase)`).

Measured, the clock matters less than the other two. Within one shot list the
pre-pin histories differ by multiples of 30 frames (the streaming loop exits
on `frame % 30 == 29`), and the 1/60 s renders step the 1/30 s clock in pairs,
so the accumulator sits at exactly 0 at the pin in every case tried
(1110/1260, 1110/1140, 14190/15060 frames). It diverges only across lists,
where the frame count can differ by an odd number: a `VITE_PERF_SHOTS` subset
against a full run. The respawn and the step count matter for every pair.

## The fix

The harness calls `renderer.pinWildlifeForCapture()` right after the ocean pin,
between the time pin and the settle. That reaches
`WildlifeSystem.respawnForCapture()`, which empties the population, clears the
population signature so the next update rebuilds it from the per-cell spawn
seeds, resets the clock, and calls `WildlifeSimulation.restartStepCountForCapture()`.
Spawning was already deterministic per cell (`wildlife/generation.ts`), so what
the capture sees is a function of the seed and the shot alone.

Production never calls it: mid-flight it would teleport every animal back to
its spawn point. Ground animals (deer, boar) are agents too, so they are pinned
by the same call. The harness comment that listed birds as unpinned history
now lists only foam and cloud jitter.

## Tests

`tests/render.wildlife-capture-pin.test.ts` (Node) drives the SHIPPED
`WildlifeSystem` under Babylon's `NullEngine`, so the thin-instance matrices it
hands the GPU are real, through the harness's own frame sequence (every render
at 1/60 s, the capture 395 renders after the pin; 1,019 on a motion shot).

- **Unpinned (the positive control):** five pre-pin histories give five
  different captures. The same bird sits metres apart, not rounding apart.
- **Pinned:** the same five histories give identical agent state (every field)
  and identical drawn matrices. The histories are own streaming of 1110 or
  1260 frames, an earlier shot elsewhere, an odd total as from another list,
  and none at all. A motion shot that flies on across cells for 1,019 frames
  stays identical too, while its unpinned twin does not.
- **Each part is needed:** four partial pins each leave a pair of histories
  different, and the shipped pin makes that same pair identical. The partial
  pins are the clock alone (the registered finding), the respawn and clock
  without the step count, the respawn and step count without the clock (on
  the odd pair, see above), and both clocks without a respawn.
- **Capture-only:**
  - The three names appear under `src/` only along the renderer → system →
    simulation chain, defined once and called once at each link.
  - Outside `src/` they appear in the perf harness alone.
  - The harness calls the pin exactly once, after the time pin and before
    the settle.
  - Every harness `renderer.render` passes `1 / 60`.
  - The `world-page-visibility` pass that steps the wildlife carries no
    `cadence` and no `enabled` predicate, and nothing returns early between
    the pass and the update. The frame graph's own frame index is not
    pinned, so a cadence would hand it back the history.

Nine mutations, each run against the file and restored; all were caught:

| mutation | tests that failed |
| --- | --- |
| the shipped pin resets only the clock | the pinned tests, the partial-pin pairs, the chain scan |
| no step-count restart | the pinned tests, the partial-pin pairs, the chain scan |
| no clock reset | the pinned tests (odd-total history), the partial-pin pairs |
| no respawn | the pinned tests, the partial-pin pairs |
| the harness never pins | harness-alone scan, harness-order scan |
| the harness pins before the time pin | harness-order scan |
| the streaming loop renders a wall-clock delta | fixed-delta scan |
| the visibility pass gains `cadence: 2` | fixed-delta scan |
| production calls the respawn inside `updateWorldVisibility` | chain scan |

## Which shots have birds

`scripts/wildlife-shot-birds.mts` predicts it in Node. For each canonical shot
it resolves the pose exactly as the harness does, with a mirror of
`resolvePlacement` that must follow the harness's. It then runs the shipped
system from a fresh population, which is what the pin leaves, through the
harness's frames. The probe asserts it steps 395 frames, or 1,019 on a motion
shot. Finally it projects every bird through the shot's camera. The capture
profile runs 48 animals; 38 of them are birds on every shot but
`cdlod-transition` (48).

Approximations, all on the side of reporting a bird:

- the camera is the rig's settled pose;
- terrain and cloud occlusion are ignored;
- bird shadows are not counted.

A bird counts at any size, since a sub-pixel bird still changes pixels. In
practice every in-frame bird is at least 2.6 px across (the drawn span is
2.76 m for a gull, 2.36 m for a hawk).

**Pinned, 24 of the 39 shots have birds in frame at capture** (count, largest):

- The approach-500ft pose and its seven re-lit twins show the same birds,
  because the wildlife does not read simulation time: 10 birds, 3.4 px, on
  `approach-500ft`, `winter-noon`, `night`, `night-moonlit`,
  `dusk-mesopic`, `golden-hour`, `blue-hour` and `night-beacon-offset`.
  `reference-viewport` shows the same 10 at 4.0 px.
- `hills-dusk-glint` 16 (11.0 px), `veg-seam-1600ft-oblique` 12 (5.3 px),
  `ground-2m-lowsun` 9 (6.0 px), `forest-line-highsun` 9 (9.5 px), `water-3m` 9
  (4.8 px), `water-400ft-glitter` 9 (4.8 px), `canopy-1200ft` 7 (11.4 px),
  `apron-hangar-variety` 6 (5.0 px), `sunset-sunward` 6 (5.9 px),
  `canopy-backlit-lowsun` 5 (4.9 px), `approach-lights-outboard` 4 (3.1 px),
  `forest-500ft-sunbehind` 3 (9.5 px), `page-thrash-turn` 1 (2.6 px),
  `runway-on-approach` 1 (3.5 px), `grove-meadow-2m` 1 (11.2 px).

**Unpinned, six more can have them.** Flying the same flocks on for 200 s and
sampling every 0.5 s gives the share of instants with a bird in frame:

- `horizon-shadow-far-annulus` 59 %;
- `water-25ft` 37 %;
- `grove-forest-2m` 23 %;
- `cliff-60m` 14 %;
- `motion-banked-turn` 3 %;
- `mountain-close` 2 %.

These are 0 once pinned; the birds are just out of frame at the pinned instant.

**Never, pinned or not (9):** `slant-10km`, `high-10000ft-down`,
`cruise-horizon`, `cdlod-transition`, `cruise-sun-30`, `coast-10km-lowsun`,
`veg-seam-near-500ft`, `terrain-material-1600ft-down`, `lake-island-piercing`.
On `high-10000ft-down`, for example, the 48 nearest animals are selected, and
those birds sit 1.7-2.0 km straight below the aircraft (77-104 degrees
down). The 45-degree-down frame spans 28-62 degrees.

**Checked against the captures that exist.** The ocean pin's evidence arms are
the same three water shots captured three times on the pinned-ocean tree, with
the wildlife unpinned:

- `water-3m` and `water-400ft-glitter` differ above the sea only in small
  clusters that fall inside the probe's unpinned screen envelope: `water-3m`
  around (288, 128), glitter across x 640-832, y 64-192. A few tiles at
  `water-3m`'s horizon line (y 256-320) sit just below the envelope, and are
  left open.
- The two arms whose pre-pin histories matched (`water-25ft` streamed 1110 in
  both) are bit-identical on both shots, birds included.
- `water-25ft` showed no bird in any of the three, and it has a bird in frame
  at 37 % of unpinned instants.

This is consistency, not proof. The capture-side check below is the proof.

## The wildlife moves DRAW COUNTS too

Deer and boar draw their legs, antlers and tusks only at "near" LOD, within
460 m of the aircraft (`assignWildlifeLod`). Every wildlife batch is drawn
whether or not it is in frame (`alwaysSelectAsActiveMesh`), and casts shadows.
So which animals happen to be near decides the draw count, even on a shot
that shows no animal.

The unpinned animals wander, so on four shots the near set changes with
history (the probe's last section):

- `terrain-material-1600ft-down`: its nearest animal is at 436 m, and the near
  set ran from none to six animals. This was MEASURED on the end-of-wave pair
  on `e9d902d`. The REBASELINE candidate drew 87 calls and the normal run 93,
  on one tree, with bit-identical pixels. It was the only shot of the 39
  whose draw count differed between the two.
- `mountain-close`: 0-4 deer near.
- `grove-forest-2m`: a deer at 455-490 m.
- `page-thrash-turn`: a boar near or not.

Draw-call ceilings are pinned from three IDENTICAL runs (`drawCallCeilingFrom`
throws otherwise), so on the unpinned tree these shots can refuse a re-pin for
no code reason. Pinned, each shot's near set is fixed. For example,
`terrain-material-1600ft-down` has three boar near at capture. So after the
merge the counts are deterministic, but may differ from any count pinned
before it. Draw ceilings for these four should be re-pinned from runs on the
pinned tip.

**The ages explain both measured counts.** `terrain-material-1600ft-down`'s
previous shot (`veg-seam-near-500ft`) is 9.4 km away, so its animals spawn
fresh when its own streaming starts, and are captured `own streaming + 395`
frames later. The probe gives the near set at each age:

| run | frames after spawn | near at capture | draws |
| --- | ---: | --- | ---: |
| REBASELINE candidate | 360 + 395 = 755 | 3 boar | 87 |
| normal run | 930 + 395 = 1,325 | 3 boar, 1 deer | 93 |
| pinned (every run) | 395 | 3 boar | predicted: 87 |

The six draws between them fit the deer's leg and antler batches in the main
pass and two shadow cascades. The nine earlier full captures read 93: a deer
had wandered near in each. **Prediction for the pinned tip:
`terrain-material-1600ft-down` draws 87 in all three runs**, 6 under its
current ceiling of 93.

## What merging does to the baselines

Merging moves the birds on every bird shot to their pinned positions: up to 30
shots, and the 24 above for certain. So the first full capture after the merge
is a re-baseline for those shots, and no A/B or A/A may straddle it.

The end-of-wave re-baseline running now is on the pre-pin tree, so its bird
shots carry unpinned birds. Its A/A floor on those shots includes bird noise
that this pin removes. After the merge, that floor should drop to the foam and
cloud-jitter residue.

## Capture-side check, measured (2026-09-23)

The churn window on `bd7a584` (House-Keeping with both pins) took a REBASELINE
candidate (`tests/perf/artifacts/rebaseline-candidates/2026-09-23T04-50-34.261Z/`
in the plane engineer's worktree) and two normal full runs on the same tree.

**The pin's floor.**
- **Runs agree.** The three runs agree to at most 0.003/255 mean on every shot.
- **No bird-scale change.** No bird-scale change repeats between runs. The few
  pixels over 8 levels that differ at all are sea glints and distant terrain,
  and on `forest-line-highsun` one normal run matches the candidate exactly.
- **Draw counts.** They are identical in all three runs on every shot, and
  `terrain-material-1600ft-down` draws 87 in all three, as predicted above.

**The birds sit where the probe puts them.** Each candidate was compared with
its committed baseline, in which the birds were unpinned:
- **Visible birds.** Every clearly visible bird is on its predicted pixel.
- **Faint birds.** Many birds are too faint to see one by one, so they were
  confirmed statistically. At the 188 predicted positions the candidate differs
  from the baseline, by at least 1 level, at **59 %** of spots, against **7 %**
  at control spots 15 px away:
  - far birds (700 m and more): 47 % against 2 %;
  - the approach pose and its seven re-lit twins: 44 % against 0 of 480.
- **Predicted birds that show nothing.** Each is one of:
  - a sub-pixel far bird that covers no samples;
  - a dark hawk on a dark sky (night, blue hour);
  - hidden: on `ground-2m-lowsun` the top of the frame is leaves beside the 2 m
    eye, and the probe ignores occlusion.

**The falsifier did not fire.** The falsifier is a new bird where the probe
predicts none. 37 strong unpredicted changes in smooth surroundings were flagged,
across every shot, and each was inspected in a magnified crop. None is a bird:
they are tree-crown texture, distant terrain faces and sea glints. One change on
a recent baseline is named rather than explained: `page-thrash-turn`'s 80 px
speck cluster at a forest edge, (803-835, 487-498). The probe puts that shot's
three near boar 55 px away, and this 60-degree-banked motion shot is where the
probe's chase-roll model is least exact.

**How to review a bird shot** (the standard since this check):
- **Threshold.** Work at **3 levels or more, not 8**. Light gulls against a
  light sky move pixels by 3-8 levels, and hawks 750 m or more away are about
  3 px across with sub-pixel wings. So a mask at more than 8 levels misses most
  birds; the first pass here did exactly that.
- **Faint birds.** Confirm them against controls 15 px away, as above, not one
  by one.
- **Falsifier candidates.** Inspect every one by crop. A smooth-surround test
  lets distant terrain faces, crowns and sea glints through as "new objects".

The tools are the probe (`scripts/wildlife-shot-birds.mts`) and the review
scripts from the check: change maps, per-shot counts, the 15 px control and
crop mosaics. The scripts are kept in the water engineer's session scratchpad,
not committed.

## Review

The harness owner approved it with nothing blocking, and checked it from the
code:

- All seven `renderer.render` calls in the harness pass `1 / 60`.
- The visibility pass has no cadence and no enabled predicate, and its one
  early return (`if (!state) return;`) cannot fire in a capture.
- The 1,019-frame motion model holds.
- The three resets are the complete set of history. The simulation holds no
  random source, the spatial hash is rebuilt every step, and the system's
  other fields are derived or statistics.

The probe's mirror of `resolvePlacement` stays for now. It throws on an
unmirrored mode but cannot see a change inside one. Extracting the harness's
pure core so both import it is the harness owner's follow-up. Their
expectation that draw counts are unaffected holds for the birds but not for
deer and boar; see above.

## Not addressed

- Bird shadows can fall into frame from birds outside it; the probe does not
  count them. They are pinned by the same call either way.
- Cloud jitter (`% 4_096` of the cloud system's own frame count) is still
  unpinned. It is the likeliest source of the scattered 1-4 px specks
  `high-10000ft-down` showed between two list-B captures whose frame counts
  differed, since no bird is in that frame.
