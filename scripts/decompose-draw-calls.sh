#!/bin/bash
# Measure ONE feature's per-shot draw-call cost, so its owner can declare a real
# `DRAW_CALL_RAISES` entry instead of sharing a bundled one.
#
# WHY THIS SHAPE. The raise mechanism is per-FEATURE and carries a `commit`
# field, and `DRAW_CALL_RAISES`' own docblock warns that creep does not look
# like creep -- one entry covering four features is indistinguishable in form
# from four features' worth of drift. So attribution has to be per commit, and
# the cheapest honest way to attribute a commit is to capture at that commit and
# at its parent and difference them.
#
# IT TOUCHES NO SOURCE. Suppression flags would mean editing the very files
# their owners are working in, and mesh-name grouping does not separate features
# cleanly (AirfieldFurniture builds no meshes of its own; its geometry lands in
# meshes named for the hangars). Two worktrees and a subtraction avoid both.
#
# USAGE
#   scripts/decompose-draw-calls.sh <commit> [shot,shot,...]
#
#   <commit>  the feature's commit. Its PARENT is the baseline.
#   [shots]   optional VITE_PERF_SHOTS filter. Omit for the full set, which is
#             what a raise needs -- a raise names shots, and this growth is NOT
#             uniform, so a subset cannot stand in for the list.
#
# COST: two full captures plus two discarded warm-ups, ~20 minutes on a quiet
# host. Announce before running; the host is shared.
#
# THE WARM-UP IS NOT OPTIONAL. A first run after a tree change has produced
# 136-vs-157 draw calls, a 465,406-pixel phantom, and a 69.64% frame difference
# against an identical code state. Three sessions have been bitten. Each arm
# here runs twice and keeps the second.
set -u
COMMIT="${1:?usage: decompose-draw-calls.sh <commit> [shots]}"
SHOTS="${2:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(git -C "$REPO" rev-parse --short "${COMMIT}^")"
HEAD_SHA="$(git -C "$REPO" rev-parse --short "$COMMIT")"
WORK="${TMPDIR:-/tmp}/decompose-$HEAD_SHA"
rm -rf "$WORK"; mkdir -p "$WORK"

capture() { # <sha> <outdir>
  local sha="$1" out="$2" wt="$WORK/wt-$1"
  git -C "$REPO" worktree add -f "$wt" "$sha" >/dev/null 2>&1
  ln -s "$REPO/node_modules" "$wt/node_modules"
  mkdir -p "$out"
  for pass in warmup keep; do
    ( cd "$wt" && VITE_PERF_SHOTS="$SHOTS" \
        npx vitest run --config vitest.perf.config.ts >/dev/null 2>&1 )
    [ "$pass" = keep ] && cp "$wt/tests/perf/artifacts/report.json" "$out/report.json"
  done
  git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
}

echo "baseline  $BASE"; capture "$BASE" "$WORK/base"
echo "feature   $HEAD_SHA"; capture "$HEAD_SHA" "$WORK/feat"

python3 - "$WORK/base/report.json" "$WORK/feat/report.json" "$HEAD_SHA" <<'PY'
import json, sys
base = {s["name"]: s["drawCalls"] for s in json.load(open(sys.argv[1]))["shots"]}
feat = {s["name"]: s["drawCalls"] for s in json.load(open(sys.argv[2]))["shots"]}
shared = sorted(set(base) & set(feat))
deltas = {n: feat[n] - base[n] for n in shared}
moved = {n: d for n, d in deltas.items() if d != 0}
print(f"\n=== {sys.argv[3]} : per-shot draw-call delta ===")
for n in sorted(moved, key=lambda k: -moved[k]):
    print(f"  {n:32} {moved[n]:+4d}")
if not moved:
    print("  (no shot moved — this commit costs no draws)"); raise SystemExit
values = set(moved.values())
print(f"\nshots moved: {len(moved)} of {len(shared)}")
if len(values) == 1 and len(moved) == len(shared):
    print(f'DECLARE: kind "uniform", delta {values.pop()}, naming every shot with a previous ceiling.')
else:
    print(f"DECLARE: kind \"per-shot\" — deltas are {sorted(values)} and "
          f"{len(shared) - len(moved)} shot(s) did not move.")
    print("`whyNonUniform` is REQUIRED and is the whole justification: say what varies.")
PY
echo "artifacts under $WORK"
