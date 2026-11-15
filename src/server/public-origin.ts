/** One canonical origin: HTTPS on a server, HTTP on loopback only. */
export function isAllowedPublicOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return value === u.origin && !u.username && !u.password &&
      (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  } catch { return false; }
}
export function isRequestOriginAllowed(value: string | undefined, canonicalOrigin: string): boolean {
  return isAllowedPublicOrigin(canonicalOrigin) && value === canonicalOrigin;
}
