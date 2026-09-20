# Ground up close: why descending added nothing, and what was done about it

The owner's third complaint in the 2026-09-19 wave:

> The current ground texture looks good from a distance. However, even when I
> zoom in, the ground still looks blurry and similar to what it looks like from
> a far distance. I'd like the ground texture to increase in fidelity up close
> so it looks less fake and plasticy.

This note records what that was, measured, and what landed against it. It
follows `GROUND_TEXTURE_W1.md` (the 3-150 m band) one band lower.

## 0. The tiling band (`D-0`)

Found on the way, and the first thing the eye finds on open ground: a sward
tile with power on the Fourier lines at |k| <= 4 cycles per tile draws its own
period across a field however the shader warps it. From 30 m above dry
grassland one dark feature of the DryGrass tile stood in a regular lattice of
identical stamps across half the frame.

`flattenLowFrequency` was supposed to own that band and cannot: a box high-pass
has its first null at 3 cycles per tile and gain at 4, so whatever a recipe
leaves there comes through. `suppressTilingBand` is an exact notch on those
lines, evaluated on a 64 x 64 box reduction (16 samples per cycle at k = 4), so
it is a few hundred thousand multiply-adds per channel rather than an FFT, and
it touches nothing at k >= 5, which is where the 5-50 cm content a sward is
made of lives. Applied to Grass and DryGrass after `flattenLowFrequency`,
keeping 0.3 of the band's amplitude.

Measured at seed "fly-high", edge 512, decoded linear luminance, absolute power
in the band: Grass 4.65e-5 to 4.27e-6, DryGrass 2.35e-5 to 2.13e-6, an 11-fold
cut on both, holding at a second seed and at the low tier's edge. No assertion
pinned the swards' band before; the only spectral pin in the suite was Rock's
crossed-fracture ceiling.

Synthesis runs in `materialSynthesis.worker.ts`, off the main thread, so the
notch is not on cold start's time-to-ready path: a sward tile takes about
170 ms to synthesise on this host with it in.
