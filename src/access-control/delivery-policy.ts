type DeliveryState =
  | "not_requested"
  | "queued"
  | "sent"
  | "failed"
  | "uncertain";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function buildInvitationMessage(input: {
  teamName: string;
  inviterName: string;
  role: "member" | "administrator";
  expiresAt: string;
  invitationUrl: string;
}): { subject: string; text: string; html: string } {
  const url = new URL(input.invitationUrl);
  if (
    !isAllowedPublicOrigin(url.origin) ||
    url.pathname !== "/invitations/accept" ||
    url.search ||
    !url.hash.startsWith("#token=")
  )
    throw new Error("invitation_url_invalid");
  const role = input.role === "administrator" ? "administrator" : "member";
  return {
    subject: `Invitation to ${input.teamName}`,
    text: `${input.inviterName} invited you to ${input.teamName} as a ${role}.\n\nAccept: ${input.invitationUrl}\nExpires: ${input.expiresAt}`,
    html: `<main><h1>Invitation to ${escapeHtml(input.teamName)}</h1><p>${escapeHtml(input.inviterName)} invited you as a ${role}.</p><p><a href="${escapeHtml(input.invitationUrl)}">Accept invitation</a></p><p>Expires <time datetime="${escapeHtml(input.expiresAt)}">${escapeHtml(input.expiresAt)}</time></p></main>`,
  };
}

export function deliveryRetryDecision(
  state: DeliveryState,
  uncertainResendConfirmed: boolean,
): "send" | "retry" | "confirmation_required" | "resend" | "not_eligible" {
  if (state === "not_requested") return "send";
  if (state === "failed") return "retry";
  if (state === "uncertain")
    return uncertainResendConfirmed ? "resend" : "confirmation_required";
  return "not_eligible";
}
import { isAllowedPublicOrigin } from "../server/public-origin.js";
