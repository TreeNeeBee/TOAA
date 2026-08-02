import type { Step } from './plan.js';

export function stepTransitivelyDependsOn(
  step: Step,
  targetId: string,
  byId: ReadonlyMap<string, Step>,
): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependency = byId.get(current);
    if (dependency) stack.push(...dependency.dependsOn);
  }
  return false;
}
