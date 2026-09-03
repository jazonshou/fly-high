# What changed while you were away — 2026-09-01

**For Jason, returning cold.** What you asked for, whether you got it, and what is
still open. The crew resuming Phase 7 is served by `PHASE_7_EXECUTION_PLAN.md`, the
deviation log and `INSTRUMENT_FAILURES_2026_09_01.md` — this document is not for them.

**Provenance:** "verified here" = checked against the tree while writing. Everything
else is attributed. Tip at writing: `8abbf1f`.

---

## 1. Your four notes

| You said | State |
|---|---|
| **The dusk look** | **Landed.** Twilight gained a real sunset — a warm lobe and the Belt of Venus (`0823c90`), tuned across two measured rounds (`d728cbe`, `de0a896`). The moon now recedes through twilight rather than sitting there (`a3bdb23` — the cream crowns you were seeing *were* moonlight), the directional sun is gated at the geometric horizon (`cf1ad6b`), and dusk adaptation now follows the visual field rather than the ground (`f1888b7`). |
| **The runway lights blobbing** | **Landed.** Two separate causes. The bloom was too wide — sigma 2.0 → 1.0, intensity 0.08 → 0.05 (`0da1e98`). And light sprites and stars were being sized in the wrong units: they now size in **output pixels, as their own code already claimed they did** (`13c63db`). Star brightness was re-compensated for that fix (`8a03776`). |
| **The night sky gradient** | **Landed.** The sky now fades to black at the zenith (`801ebb5`), with the falloff tuned through its own measured compression rather than by eye (`ac041da`). |
| **The hangars — "thrown together with a semi circle and a square"** | **Landed, and more is coming.** They now have a segmental arch, a seeded crown and broken sequences (`45d4b7f`). **Verified here: `AirportSystem.ts` contains zero `CreateBox` calls** and the new geometry lives in `src/render/webgpu/airfield/`. Refinement is still in flight per the PM. |

**All four are things you can go and look at.** That matters more than the rest of this
document, and it is the only section written to be checked by eye.

---

## 2. What you did not ask for, but paid for in time

Three structural things, in descending order of how much they were costing you.

**The shadow cascades were never rendering.** From the depth-only shadow generator's
first landing until today, **only cascade 0 was ever drawn** — measured off Babylon's own
draw counter at `cascadesRendered = 1` for every `numCascades` from 1 to 4. So **88–94% of
each tier's shadow range was served by array layers no pass had ever written.** The cause
is worth knowing because it is not a typo: `RenderTargetTexture.render` renders one layer
per cascade only when `is2DArray` is true, and `is2DArray` reads the **colour** texture —
which the no-colour-attachment override sets to null. Cascade depth lives in the **depth**
texture, which is layered. **The gate was asking about the wrong texture entirely.** Fixed
in `034aedd`; tiers 2 and 3 were then cut to two cascades, because cascade counts had
stopped being inert and suddenly had to be affordable (`5b93d79`, `09ab15f`).

**The memory instrument was measuring the wrong width.** Inventory texel width was computed
from texture *type* alone; it now uses **format and type** (`4543b7e`). Two doctrines built
on the old numbers were struck rather than patched (`9329f8e`, `dcdb04c`), and the
estimate's re-pin trigger — which had **never once fired** — was given a real mechanism
(`0c8802e`).

**The guards were hardened against passing vacuously.** The boundary guards are now
anchored against an empty scan, so a guard that stops matching anything fails instead of
passing (`619bd98`); the capture gates collect-then-assert, so no gate can mask another
(`dbc0b59`); and draw-call coverage is coupled to probe status so a demotion cannot happen
silently (`a30fce5`).

---

## 3. What is still open

- **The hangar refinement continues** — the arch landed, texture and variety work has not
  finished.
- **Phase 7 proper has barely started.** Gate 7D — hangars, tower, furniture — is where the
  night's work went. The lighting engine (7-4, 7-5) is planned and not built.
- **QR-1 closed as a negative result**: tier 2 meets its 13.7 ms contract in **0 of 21**
  shot-configurations at 720p, and disabling the vegetation shadow caster does not fix it.
  The cliff is real, large, GPU-bound and **unexplained** — the one proposed mechanism was
  withdrawn for lack of measured support rather than kept because it sounded plausible.
- **The eroded world is still shelved** behind `?world=eroded`, per your call. See
  `PHASE_6_OUTCOME.md` for the reviver's reading list.

---

## 4. What the numbers do and do not establish

You will be told that **168 commits landed and the suite is green at 176 files / 1791
tests**. Both are true. **Neither is evidence that the renderer looks right**, and tonight
is the strongest demonstration of that this project has produced.

The shadow cascades were broken **from their first landing**, through every green suite in
between. The light sprites were sized in units their own code documented incorrectly. The
boundary guards would have passed while matching nothing. In each case the tests were
green, the numbers were confident, and the answer was **about a different question than the
one asked** — which is the finding `INSTRUMENT_FAILURES_2026_09_01.md` exists to record.

So: **the green suite establishes that nothing known-checkable regressed. It does not
establish that anything looks right.** The four items in §1 are the ones you can verify by
eye, and they are the ones worth your first ten minutes.

*(A count of "168" is itself contested — it is "since the Phase 6 plan commit"; a
calendar-day count gives 146. Two sessions declined to quote either without the question
attached, which was right, and it is why the number appears here only as something you will
be told rather than as a claim.)*
