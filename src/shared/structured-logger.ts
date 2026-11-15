export type LifecycleEvent =
  | "startup"
  | "bootstrap.completed"
  | "authentication.outcome"
  | "invitation.lifecycle"
  | "membership.revocation"
  | "mutation.committed"
  | "operation.replay"
  | "operation.conflict"
  | "subscription.lifecycle"
  | "ownership.transition"
  | "shutdown";

type Correlation = {
  result?: string;
  requestId?: string;
  operationId?: string;
  actorId?: string;
  teamId?: string;
  targetId?: string;
  committedVersion?: number;
  authorityGeneration?: string;
  errorCode?: string;
};

export class StructuredLogger {
  constructor(
    private readonly sink: (
      event: Record<string, unknown>,
    ) => void = console.log,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  event(event: LifecycleEvent, correlation: Correlation = {}): void {
    this.sink({ event, timestamp: this.now(), ...correlation });
  }
}
