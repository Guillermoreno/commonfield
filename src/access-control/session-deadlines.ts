export type SessionDeadlines = {
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  invalidatedAt: string | null;
};

export function createSessionDeadlines(issuedAt: Date): SessionDeadlines {
  return {
    absoluteExpiresAt: new Date(
      issuedAt.getTime() + 12 * 60 * 60 * 1000,
    ).toISOString(),
    idleExpiresAt: new Date(issuedAt.getTime() + 30 * 60 * 1000).toISOString(),
    invalidatedAt: null,
  };
}

export function renewSessionIdleDeadline(
  deadlines: SessionDeadlines,
  activityAt: Date,
): SessionDeadlines {
  const renewed = activityAt.getTime() + 30 * 60 * 1000;
  return {
    ...deadlines,
    idleExpiresAt: new Date(
      Math.min(renewed, Date.parse(deadlines.absoluteExpiresAt)),
    ).toISOString(),
  };
}

export function observeSession(
  deadlines: SessionDeadlines,
  now: Date,
):
  | { valid: true }
  | {
      valid: false;
      code:
        | "session_invalidated"
        | "session_absolute_expired"
        | "session_idle_expired";
    } {
  if (deadlines.invalidatedAt)
    return { valid: false, code: "session_invalidated" };
  if (now.getTime() >= Date.parse(deadlines.absoluteExpiresAt))
    return { valid: false, code: "session_absolute_expired" };
  if (now.getTime() >= Date.parse(deadlines.idleExpiresAt))
    return { valid: false, code: "session_idle_expired" };
  return { valid: true };
}
