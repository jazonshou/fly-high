/**
 * A ground-height sampler that asks its source once per lattice node and
 * interpolates between nodes: the walker's camera and feet ask for the ground
 * a dozen times a frame, and the renderer's analytic ground answers each in
 * microseconds, which a frame budget of 0.15 ms cannot spend. Nodes are kept
 * in a map keyed by their integer lattice coordinates and the whole map is
 * dropped when it grows past `capacity` (a walker crosses a 1 m lattice a node
 * or two at a time, so a refill is gradual).
 *
 * Bilinear between nodes, so it is exact on planes and within a few
 * centimetres on terrain that bends over metres. World coordinates in and out.
 */
export class LatticeHeightCache {
  private readonly nodes = new Map<number, number>();
  private readonly inverseSpacing: number;

  constructor(
    private readonly source: (x: number, z: number) => number,
    private readonly spacing = 1,
    private readonly capacity = 4_096,
  ) {
    this.inverseSpacing = 1 / spacing;
  }

  /** Drops every node: the ground changed (a terrain page, a road's earthworks). */
  clear(): void {
    this.nodes.clear();
  }

  get size(): number {
    return this.nodes.size;
  }

  sample(x: number, z: number): number {
    const gx = x * this.inverseSpacing;
    const gz = z * this.inverseSpacing;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const h00 = this.node(ix, iz);
    const h10 = this.node(ix + 1, iz);
    const h01 = this.node(ix, iz + 1);
    const h11 = this.node(ix + 1, iz + 1);
    const near = h00 + (h10 - h00) * fx;
    const far = h01 + (h11 - h01) * fx;
    return near + (far - near) * fz;
  }

  private node(ix: number, iz: number): number {
    // Exact for lattice coordinates within +-2^25 (33,000 km at 1 m).
    const key = (ix + 33_554_432) * 67_108_864 + (iz + 33_554_432);
    const cached = this.nodes.get(key);
    if (cached !== undefined) return cached;
    if (this.nodes.size >= this.capacity) this.nodes.clear();
    const height = this.source(ix * this.spacing, iz * this.spacing);
    this.nodes.set(key, height);
    return height;
  }
}
