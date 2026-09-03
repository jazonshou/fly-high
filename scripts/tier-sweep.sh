#!/usr/bin/env bash
# 6-11.1 — the four-tier x three-viewport delivery sweep, run so that thermal
# drift cannot masquerade as a tier cost.
#
# WHY THIS IS A SCRIPT AND NOT A SHELL LOOP
#
# The sweep's independent variable is TIER, and the sweep is itself a
# multi-hour continuous GPU workload. Run back to back in tier order, the host
# heats monotonically and tier 3 is measured on a hotter machine than tier 0 —
# so a thermal ramp would appear as "higher tiers cost more", which is the
# conclusion the sweep exists to produce. That is the most convincing wrong
# answer available and it is invisible in the resulting numbers.
#
# This host is known to move that far: it read min 117.73 fps this morning and
# min 38.7 fps after a day of captures, a 3x swing on identical code.
#
# Correlated drift is worse than noise because it does not average out. Three
# mechanisms below, in increasing order of how much I trust them:
#
#   1. BALANCED ORDER. Tiers are interleaved so each third of the run contains
#      each tier roughly once. A monotonic drift then lands on every tier
#      about equally instead of tracking one.
#   2. COOL-DOWN GAPS between configurations, so the run sheds heat rather
#      than accumulating it.
#   3. A REPEATED CONTROL, first / middle / last, of one fixed configuration.
#      This is the mechanism that actually makes the run auditable: if the
#      three control readings disagree materially, the sweep is VOID and the
#      data says so. Everything else reduces drift; only the control detects
#      it. It is the sweep-scale version of the same-tree control arm that
#      §1.2's A->B->A amendment made mandatory, and for the same reason.
#
# Usage:  scripts/tier-sweep.sh <output-dir> [cooldown-seconds]
#
# Run it on a COLD host. Read `tier-sweep-analyse.mjs` output before believing
# any tier row; it reports the control spread and refuses to summarise a run
# whose controls moved.

set -uo pipefail

OUT="${1:?usage: tier-sweep.sh <output-dir> [cooldown-seconds]}"
COOLDOWN="${2:-180}"
mkdir -p "$OUT"

# A subset chosen for delivery stress rather than coverage: the heaviest
# draw-call shots, one motion shot, one water shot, plus the canonical
# reference. The full 24 would triple the run and with it the thermal problem
# this script exists to manage.
SHOTS="reference-viewport,mountain-close,grove-meadow-2m,runway-on-approach,forest-500ft-sunbehind,water-3m,motion-banked-turn"

# The control: canonical tier 1 at the canonical viewport. Deliberately the
# shipping configuration, so a drifting control is also directly comparable to
# the standing gate's own numbers.
CONTROL_Q=medium; CONTROL_M=balanced; CONTROL_VP=1280x720

run_one() {         # tier quality mode viewport label
  local tier="$1" q="$2" m="$3" vp="$4" label="$5"
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[$(date -u +%H:%M:%S)] running ${label} (tier ${tier}, ${q}/${m}, ${vp})"
  VITE_PERF_SHOTS="$SHOTS" \
  VITE_PERF_QUALITY="$q" \
  VITE_PERF_MODE="$m" \
  VITE_PERF_VIEWPORT="$vp" \
    npx vitest run --config vitest.perf.config.ts > "${OUT}/${label}.log" 2>&1
  local rc=$?
  if [ -f tests/perf/artifacts/report.json ]; then
    cp tests/perf/artifacts/report.json "${OUT}/${label}.json"
    # Stamp the run's position in the sweep INTO the artifact. A tier row whose
    # thermal context has to be reconstructed from file mtimes is a tier row
    # nobody can audit later.
    node -e '
      const fs=require("fs"); const [f,label,order,stamp,rc]=process.argv.slice(1);
      const r=JSON.parse(fs.readFileSync(f,"utf8"));
      r.sweep={label,order:Number(order),startedAt:stamp,exitCode:Number(rc)};
      fs.writeFileSync(f,JSON.stringify(r,null,2));
    ' "${OUT}/${label}.json" "$label" "$ORDER" "$stamp" "$rc"
  fi
  ORDER=$((ORDER+1))
  echo "[$(date -u +%H:%M:%S)] ${label} exit=${rc}; cooling ${COOLDOWN}s"
  sleep "$COOLDOWN"
}

ORDER=0

# Control 1 of 3 — before anything else, on the coldest the host will be.
run_one 1 "$CONTROL_Q" "$CONTROL_M" "$CONTROL_VP" "control-a"

# Balanced order: tiers rotate within each viewport block, and the viewport
# blocks rotate their starting tier, so no tier clusters in one third of the run.
run_one 0 low     balanced 1280x720   "t0-1280x720"
run_one 2 high    balanced 1920x1080  "t2-1920x1080"
run_one 1 medium  balanced 2560x1440  "t1-2560x1440"
run_one 3 high    ultra    1280x720   "t3-1280x720"

# Control 2 of 3 — the middle of the run.
run_one 1 "$CONTROL_Q" "$CONTROL_M" "$CONTROL_VP" "control-b"

run_one 2 high    balanced 1280x720   "t2-1280x720"
run_one 0 low     balanced 1920x1080  "t0-1920x1080"
run_one 3 high    ultra    2560x1440  "t3-2560x1440"
run_one 1 medium  balanced 1920x1080  "t1-1920x1080"
run_one 3 high    ultra    1920x1080  "t3-1920x1080"
run_one 0 low     balanced 2560x1440  "t0-2560x1440"
run_one 2 high    balanced 2560x1440  "t2-2560x1440"
run_one 1 medium  balanced 1280x720   "t1-1280x720"

# Control 3 of 3 — last, on the hottest the host will be. The spread across
# the three controls is the sweep's own statement about whether it is sound.
run_one 1 "$CONTROL_Q" "$CONTROL_M" "$CONTROL_VP" "control-c"

echo "sweep complete -> ${OUT}"
echo "NOW RUN: node scripts/tier-sweep-analyse.mjs ${OUT}"
echo "Do not read the tier rows before the analyser reports the control spread."
