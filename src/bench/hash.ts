/**
 * FNV-1a, 32-bit, for the bench's fingerprints: the route, the quality
 * profiles and the settings key. Identity checks between two runs of the
 * same build, not security.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Fnv1a {
  private hash = FNV_OFFSET;

  /** Each UTF-16 code unit, low byte then high byte. */
  text(value: string): this {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      this.byte(unit & 0xff);
      this.byte(unit >>> 8);
    }
    return this;
  }

  /** A 32-bit integer, low byte first. Non-integers are truncated toward zero. */
  int(value: number): this {
    const bits = value | 0;
    this.byte(bits & 0xff);
    this.byte((bits >>> 8) & 0xff);
    this.byte((bits >>> 16) & 0xff);
    this.byte((bits >>> 24) & 0xff);
    return this;
  }

  /** Eight lowercase hex digits. */
  hex(): string {
    return (this.hash >>> 0).toString(16).padStart(8, "0");
  }

  private byte(value: number): void {
    this.hash = Math.imul(this.hash ^ value, FNV_PRIME) >>> 0;
  }
}

export function fnv1aHex(text: string): string {
  return new Fnv1a().text(text).hex();
}
