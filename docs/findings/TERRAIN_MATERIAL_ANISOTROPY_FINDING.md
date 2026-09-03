# Grass and DryGrass synthesise axis-aligned normals

**Status: open latent defect. NOT the cause of the reptile-skin read at flight
range** — that hypothesis was tested and refuted by the minification table below,
in this same document, so it cannot be resurrected without meeting its own
refutation. It is a defect waiting for a viewing condition, not an explanation of
the current one.

## The claim

**`Grass` and `DryGrass` produce normal maps three and a half times more
axis-aligned than an isotropic field. `Rock` and `Gravel` are indistinguishable
from random.** Axis-aligned structure in two perpendicular directions is a weave.

## The measurement

Taken on the synthesised normal maps themselves — no render, no camera, no
projection. Screen-space anisotropy would prove nothing here, because an oblique
surface foreshortens an isotropic texture into an anisotropic one.

The statistic is `Σ| |nx| − |ny| |` over `Σ min(|nx|, |ny|)`: energy concentrated
on one axis over energy shared between them. Two synthetic controls calibrate it,
because a bare ratio has no scale.

| | axis:diag |
|---|---|
| CONTROL — isotropic random field | **1.412** |
| CONTROL — perfectly axis-aligned | ~1e14 |
| Rock | 1.409 / 1.417 |
| Gravel | 1.323 / 1.331 |
| **Grass** | **4.691 / 4.417** |
| **DryGrass** | **4.879 / 4.834** |

Two figures per material are two unrelated seeds. The values barely move, so this
is a property of those two recipes rather than a seed accident.

## Why it does not currently show

`mountain-close` sits at roughly **85 texels per pixel** — a 2.3 m `Grass` tile
spans about 6 px — so the surface arrives through heavy minification. The
alignment does not survive it:

| minification | 1× | 4× | 16× | 64× |
|---|---|---|---|---|
| Grass | 4.69 | 1.50 | 1.47 | 1.81 |
| DryGrass | 4.88 | 1.54 | 1.45 | 1.91 |
| Rock | 1.41 | 1.42 | 1.53 | 1.34 |

**By 4× it is 1.50 against a 1.412 isotropic control.** The weave is real in the
texture and erased before it reaches the eye at flight range. A residual of about
30% above Rock survives at 64×, which is not nothing but is nothing like a woven
read.

## When it starts to matter

Anything that renders these two materials at a small footprint: a ground-level
shot, a walk mode, a materially higher render scale, or a material contact sheet.
At 85 texels per pixel it is invisible; at 4 it would not be.

## How to re-measure it in seconds

`synthesizeSurfaceMaterial(id, seed, edge)` returns plain `Uint8Array`s and
`MaterialCanvas` is typed arrays rather than a DOM canvas, so **the whole
synthesis runs headless under `tsx` with no capture at all.** Recipe properties
should be measured there and not inferred from renders.

## What this does not say

It does not name the mechanism inside the recipes. The alignment is measured, not
explained, and the fix — if a viewing condition ever makes one necessary — is to
break the alignment in the recipe rather than to reduce the normal's amplitude.
Reducing amplitude would trade this defect for the one measured the same day:
that face carries only 6.96% spatial contrast to begin with.
