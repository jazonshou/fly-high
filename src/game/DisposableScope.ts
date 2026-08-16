export interface DisposableResource {
  dispose(): void;
}

/**
 * Owns partially constructed browser resources until startup commits. Disposal
 * is reverse-order, exception-safe, and idempotent so one broken destructor
 * cannot leak the resources acquired before it.
 */
export class DisposableScope {
  private readonly resources: DisposableResource[] = [];

  own<Resource extends DisposableResource>(resource: Resource): Resource {
    this.resources.push(resource);
    return resource;
  }

  release<Resource extends DisposableResource>(resource: Resource): Resource {
    const index = this.resources.lastIndexOf(resource);
    if (index >= 0) this.resources.splice(index, 1);
    return resource;
  }

  dispose(): void {
    while (this.resources.length > 0) {
      const resource = this.resources.pop();
      try {
        resource?.dispose();
      } catch {
        // Continue unwinding: cleanup failures must not leak sibling resources.
      }
    }
  }
}
