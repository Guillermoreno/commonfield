import { isAllowedPublicOrigin } from "../server/public-origin.js";

export function buildInvitationUrl(origin: string, secret: string): string {
  const parsed = new URL(origin);
  if (!isAllowedPublicOrigin(origin) || !secret)
    throw new Error("origin_invalid");
  return `${parsed.origin}/invitations/accept#token=${encodeURIComponent(secret)}`;
}

export function parseInvitationFragment(fragment: string): string | null {
  if (!fragment.startsWith("#token=")) return null;
  const encoded = fragment.slice(7);
  if (!encoded || encoded.includes("&")) return null;
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}
