# Visual Fix-Pack — Foliage, Terrain, Water, and the F-22

**Created:** 2026-08-25, from the user's four flight-test reports of the same date.
**Ground rule (user, verbatim intent):** performance is never sacrificed. The tier-1
delivery contract (≥60 raw fps, p95 ≤16.67 ms on the reference adapter — currently
~120 fps / p95 ≤9.5 ms with ~7 ms of headroom) is the hard gate for every item here.
**Verification:** same-host back-to-back `perf:capture` A/Bs per wave; PNGs reviewed
by eye (green suites have coexisted with black screens — see the Phase-4 close row in
ARCHITECTURE.md); one sanctioned rebaseline at the close; ARCHITECTURE.md decision-log
entries for every representational change.

## The four reports, root-caused

1. **"Trees/ground look like plastic/playdough."** Commit `6e13d6e` (the 60 fps
   push) deleted the 2-12 alpha-tested card crowns and substituted closed opaque
   hulls (80-tri icosphere / 4 stacked cones) for near AND mid bands, textured by a
   deliberately low-contrast (±0.13 value) dense layer, shaded by the smooth hull
   normal, with no cast shadows at tier 1 and impostors baked from the same hulls.
   The ground between sparse blade patches is the terrain albedo, which item 3's
   fade has already flattened. The swap was never recorded in ARCHITECTURE.md.
2. **"Water is great at distance, plastic up close."** Structural asymmetry in the
   2-8 Toksvig roughness fold: at mip 0 the moment texture holds exactly `s²`, so
   `variance = moment − fade²·s² = 0` and roughness collapses to the 0.065 floor —
   the probe reflects at mip 0 (glass). Distance recovers real variance through the
   mips (the sun glitter the user likes). Below the cascade-0 Nyquist (1.0 m at
   tier 1) no spectrum content exists at all, and rivers/lakes shade from three
   per-vertex sines on center-fan meshes — interpolated near-constant normals.
3. **"Mountains too smooth / plastic; occasional black lines."** ALL patterned
   material channels fade to per-material constants over a 0.5→2 m pixel footprint
   (`TerrainSurfacePlugin.ts:108`), keyed to the MAJOR anisotropic derivative axis —
   at flight grazing angles that is a few hundred metres of slant range. Beyond it
   the only signal is a scalar brightness wash; nothing occupies the 1–100 m band
   where real mountain texture lives. Black lines: the biplanar path drops the
   weakest projection plane discretely (C0 discontinuity along ridges) and the
   planar path amplifies detail normals by `1/max(nz,0.15)` (≤6.7×), which can push
   the shaded normal past 90° to the light. Anisotropy clamp 12 vs sampler 16.
4. **"F-22; jet further ahead at speed; bounce on release; drunk."** The jet is a
   generic single-fin sport jet. Chase distance speed term is capped at +2.2 m and
   the aim point is fixed `pos + forward·16`. Bounce: `DirectPitchRetention`
   freezes its target at the release instant while the airframe still carries pitch
   rate (input releases at 2.8/s, actuator at 7/s), so momentum overshoots the
   frozen target and the holder drags the nose back. Drunk: dutch roll at ζ≈0.11
   (yaw damping −0.38 scaled by b/2V against Cnβ 0.13 and Iyy 54,000) coupled into
   roll through Clβ 0.052, with zero stability augmentation in the default
   `unassisted` mode.

## Work order

### Wave T — terrain surface (mountains and ground)
- T1 Meso-band detail: extend the 3-4 macro wash from a scalar brightness into a
  vector term — hue tint, roughness delta, and a world-space normal perturbation in
  the 8–96 m band from the already-present `terrainSurfaceValue` noise, active
  regardless of `detailWeight`, slope-aligned banding on rock. ALU-only.
- T2 Micro fade re-key: fade on the anisotropy-limited (minor-axis-bounded)
  footprint and widen 0.5→2 m to ~1.5→10 m; all patterned channels keep fading
  together (the screen-door-mountain rule).
- T3 Anisotropy clamp 12 → 16 (match the sampler).
- T4 Black-line fixes per the artifact audit: smooth the biplanar weakest-plane
  drop; bound the planar `rise` amplification; clamp the composed normal against
  the geometric hemisphere.
- T5 Synthesis contrast: raise `LOW_FREQUENCY_KEEP` 0.28 → ~0.4 and rock/gravel
  RMS normal slopes; CPU-only re-synthesis.
- T6 Elevation-aware CDLOD distance: `distanceToNode` measures camera altitude
  above SEA LEVEL, so nodes under a 2,500 m peak never reach L0 — the mountains
  under-split exactly where the report looks. Use the already-measured slot
  min/max heights (`dy = cameraY − clamp(cameraY, minH, maxH)`), raw `cameraY`
  fallback for unmeasured pages.
- T7 Kernel micro-relief: 2–3 slope-gated lattices in the 5–40 m band added to
  the SHARED kernel table (TS source + WGSL transliteration together), so pages,
  physics and collision stay bit-identical by construction; parity re-verified on
  the adapter. Riskiest terrain item — lands last in the wave, measured alone.
- T8 Black-line/flash fixes, ranked by the artifact audit: slope-scaled CSM
  normal bias (fixed 0.035 m is under one cascade texel's slope error on
  mountainsides); force the whole corner-incident node set to `morphK 0` when any
  participant's parent page is missing (transient T-junction cracks while
  streaming); clamp the composed detail normal to the geometric hemisphere;
  smooth the biplanar weakest-plane drop; dither the 8-azimuth horizon-shadow
  terminator; defer material-array/atlas disposal by a frame (the recorded
  "used in submit while destroyed" black-frame class).

### Wave F — foliage
- F1 Crown shading: procedural per-texel normal perturbation in the
  `DETAIL_OPAQUE_CROWN` fragment path (leaf-cluster scale, ALU-only) + re-authored
  dense layers with real clump contrast; deepen baked occlusion beyond the vertical
  ramp.
- F2 Crown geometry: lumpier near hulls (subdivision-2 icosphere with hash
  displacement, deeper conifer whorls), per-instance vertex-hash deformation so
  identical prototypes stop reading as clones; restrained opaque-crown flutter.
- F3 Silhouette fringe: near-band-only alpha-tested card shell per family over the
  opaque core (depth pre-filled ⇒ bounded overdraw), using the dormant card
  materials and atlas layers; +draws measured against the 0.026 ms/draw law and the
  vegetation ceilings re-pinned as a recorded decision.
- F4 Ground cover: full-density share 0.2 → 0.35 and 1.5 m spacing inside ~40 m;
  litter/moss ramp near the camera.
- F5 Under-canopy darkening on terrain from the shared density-field include
  (dappled-light stand-in for the tier-1 no-shadows decision).

### Wave W — water
- W1 Sub-grid roughness tail: add the analytically-integrated unresolved-spectrum
  mean-square slope (CPU, function of wind) into the roughness fold — removes the
  mip-0 glass collapse everywhere, restores near-field sun behavior.
- W2 Procedural capillary detail normal: 2–3 octaves of wind-advected gradient
  noise (0.05–0.5 m), world-locked (the altitude/optical-flow cue), Nyquist-faded
  with energy folded into roughness; shared by ocean and hydrology.
- W3 Hydrology per-pixel waves: move the 3-sine normal from vertex to fragment and
  add W2's detail layer (fixes lake center-fan glass).
- W4 Near foam/contact: depth-band shore foam from the bathymetry already sampled.
- W5 Append a `water-25ft` capture shot (APPEND only — shot order pins temporal
  phase); re-pin the ocean WGSL SHA in the same commits.

### Wave A — aircraft
- A1 F-22 airframe: rebuild `createJet` — chined flat-wide fuselage (superellipse
  loft sections), clipped-diamond wings, twin canted fins, full-span stabilators,
  twin rectangular nozzles, side intakes, bubble canopy, dark grey livery;
  contact points/gear repositioned from the built geometry; per-kind cockpit eye.
- A2 F-22 flight model: mass/wing/inertia/thrust in the real aircraft's class, a
  transonic wave-drag term (new per-aircraft datum, 0 for the trainer) so top
  speed lands near reality instead of 480 m/s; jet behavioral tests re-pinned
  deliberately.
- A3 Release bounce: capture a rate-led settle target
  (`noseVertical + q·authority·τ`) and ramp the hold authority in over ~0.5 s.
- A4 Dutch-roll SAS: washout-filtered yaw-rate damper + small roll-rate damper for
  the jet on pilot-neutral axes only (the DirectPitchRetention precedent keeps the
  direct-mode doctrine intact); target ζ≈0.5.
- A5 Chase camera: speed-based distance/aim-ahead/FOV growth for the jet
  (trainer numbers untouched — the capture shots fly the trainer).

### Close
- Full `npm run verify` + `npm run test:gpu` + full `perf:capture`; review every
  PNG; `perf:capture:candidate` → manual review → promote (one sanctioned
  rebaseline); ARCHITECTURE.md decision-log entries (opaque-hull record + each
  wave's representational change); PERFORMANCE.md tier-row updates; deviation log
  below.

## Deviation log

| # | Item | Deviation | Why | Date |
|---|---|---|---|---|
| D-1 | T5 | `LOW_FREQUENCY_KEEP` 0.28 → 0.32, not the planned ~0.4. | 0.38 pushed Rock's mip-4 crossed-fracture albedo power to 0.0342 against the 0.033 anti-moiré ceiling — a real quality guard, not a stale pin. | 2026-08-25 |
| D-2 | T7 | Kernel micro-relief octaves NOT landed. | After T1/T2/T6 the mountains carry meso normal/tone/strata structure and split to L0 near peaks; the shading band covers the visible gap at far lower risk than changing the height kernel (TS+WGSL transliteration, collision, parity suite, world-shape churn). Re-open if flown captures still read smooth up close. | 2026-08-25 |
| D-3 | F3 | Fringe cards resized 12/10 × 0.30–0.46 → 8/6 × 0.26–0.38. | Measured ~4 ms of p95 on forest shots at the planned size (two-sided alpha fragments outside the hull's early-Z shadow); the shipped size keeps the ragged silhouette at ~120 fps. | 2026-08-25 |
| D-4 | F5 | Under-canopy terrain darkening not landed. | The cluster shading + fringe carry the near-field look; F5 adds a cross-owner terrain↔vegetation coupling for a subtler win. Deferred with the tier-2 shadow question it belongs to. | 2026-08-25 |
| D-5 | W4 | Ocean shore/contact foam not landed. | The capillary band + roughness tail deliver the near-field realism the report asked for; foam is additive polish. | 2026-08-25 |
| D-6 | A2 | Transonic field is Mach-keyed (`transonicOnsetMach`), not TAS-keyed. | A monotonic TAS rise cannot satisfy ≤380 m/s at sea level and 425–470 m/s at 10 km simultaneously; the Mach hump with post-peak decay does. | 2026-08-25 |
| D-7 | A4 | Jet `yawDamping` −0.70 (not ~−0.55) and SAS k_r 0.20. | Yaw-rate feedback authority fades with q̄ exactly where dutch roll is worst (120 m/s); the ζ ≥ 0.45-at-120 floor binds before the 200 m/s target. | 2026-08-25 |
| D-8 | W5 | `water-25ft` baseline seeded by direct review-and-copy of its first capture. | A new shot has no committed PNG and the harness (correctly) refuses to run without one outside a rebaseline; promoting the reviewed first frame is exactly what candidate promotion does for a new shot. | 2026-08-25 |
