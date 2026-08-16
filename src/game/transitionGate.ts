/**
 * Latest-action-wins guard for UI transitions that wait on browser services
 * such as AudioContext.resume(). A later user action invalidates every token
 * issued before it, so an older promise cannot overwrite newer navigation.
 */
export interface TransitionGate {
  generation: number;
}

export function createTransitionGate(): TransitionGate {
  return { generation: 0 };
}

export function beginTransition(gate: TransitionGate): number {
  gate.generation += 1;
  return gate.generation;
}

export function invalidateTransitions(gate: TransitionGate): void {
  gate.generation += 1;
}

export function isCurrentTransition(gate: TransitionGate, token: number): boolean {
  return gate.generation === token;
}
