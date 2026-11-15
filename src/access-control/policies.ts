export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
function unicodeScalarLength(input: string): number | null {
  return /\p{Surrogate}/u.test(input) ? null : [...input].length;
}
export function validatePassword(input: string): { ok: boolean } {
  const length = unicodeScalarLength(input);
  return { ok: length !== null && length >= 12 && length <= 128 };
}
export class SessionPolicy {
  readonly absoluteLifetimeMs = 12 * 60 * 60 * 1000;
  readonly idleLifetimeMs = 30 * 60 * 1000;
}
