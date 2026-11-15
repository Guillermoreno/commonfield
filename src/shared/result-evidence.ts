export type EvidenceStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
export type EvidenceRow = {
  check: string;
  status: EvidenceStatus;
  command: string | null;
  outcome: string | null;
};

const REQUIRED_CHECKS = [
  "PostgreSQL",
  "two browsers",
  "restart/reload",
  "access denial",
  "deduplication",
  "fencing",
  "lint",
  "format",
  "runtime",
] as const;

export function createUnitOneResultMatrix(): EvidenceRow[] {
  return REQUIRED_CHECKS.map((check) => ({
    check,
    status: "NOT RUN",
    command: null,
    outcome: null,
  }));
}
