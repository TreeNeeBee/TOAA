export type StateTransitions<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export class InvalidStateTransitionError<State extends string> extends Error {
  constructor(
    public readonly machine: string,
    public readonly entityId: string,
    public readonly from: State,
    public readonly to: State,
  ) {
    super(`Invalid ${machine} transition ${entityId}: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Shared transition guard for persisted state machines.
 *
 * Equal states are idempotent. Every actual state change must be declared by
 * the owning machine before the caller mutates its persisted object.
 */
export function assertStateTransition<State extends string>(
  machine: string,
  entityId: string,
  from: State,
  to: State,
  transitions: StateTransitions<State>,
  errorFactory: () => Error = () =>
    new InvalidStateTransitionError(machine, entityId, from, to),
): boolean {
  if (from === to) return false;
  if (!transitions[from].includes(to)) throw errorFactory();
  return true;
}
