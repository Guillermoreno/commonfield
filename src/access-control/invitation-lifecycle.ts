import { normalizeEmail } from "./policies.js";

export type Invitation = {
  id: string;
  teamId: string;
  email: string;
  role: "member" | "administrator";
  issuedAt: string;
  expiresAt: string;
  lifecycle: "pending" | "accepted" | "revoked";
  delivery: "not_requested" | "queued" | "sent" | "failed" | "uncertain";
  lastAttemptId?: string;
};

export type DeliveryProjection = {
  invitation: Invitation;
  attempt: {
    id: string;
    outcome: "queued" | "sent" | "failed" | "uncertain";
  };
};

export function createInvitation(input: {
  id: string;
  teamId: string;
  email: string;
  role: Invitation["role"];
  issuedAt: Date;
}): Invitation {
  return {
    id: input.id,
    teamId: input.teamId,
    email: normalizeEmail(input.email),
    role: input.role,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(
      input.issuedAt.getTime() + 72 * 60 * 60 * 1000,
    ).toISOString(),
    lifecycle: "pending",
    delivery: "not_requested",
  };
}

export function canRediscloseInvitation(
  invitation: Invitation,
  now: Date,
): boolean {
  return (
    invitation.lifecycle === "pending" &&
    now.getTime() < Date.parse(invitation.expiresAt)
  );
}

export function revokeInvitation(invitation: Invitation): Invitation {
  if (invitation.lifecycle !== "pending")
    throw new Error("invitation_not_pending");
  return { ...invitation, lifecycle: "revoked" };
}

export function acceptInvitation(
  invitation: Invitation,
  accountEmail: string,
  now: Date,
): Invitation {
  if (invitation.lifecycle !== "pending")
    throw new Error("invitation_not_pending");
  if (now.getTime() >= Date.parse(invitation.expiresAt))
    throw new Error("invitation_expired");
  if (normalizeEmail(accountEmail) !== invitation.email)
    throw new Error("invitation_account_mismatch");
  return { ...invitation, lifecycle: "accepted" };
}

export function queueDeliveryAttempt(
  invitation: Invitation,
  attemptId: string,
): DeliveryProjection {
  if (invitation.lifecycle !== "pending")
    throw new Error("invitation_not_pending");
  if (invitation.lastAttemptId === attemptId)
    return {
      invitation,
      attempt: {
        id: attemptId,
        outcome:
          invitation.delivery as DeliveryProjection["attempt"]["outcome"],
      },
    };
  return {
    invitation: { ...invitation, delivery: "queued", lastAttemptId: attemptId },
    attempt: { id: attemptId, outcome: "queued" },
  };
}

export function completeDeliveryAttempt(
  projection: DeliveryProjection,
  outcome: "sent" | "failed" | "uncertain",
): DeliveryProjection {
  if (projection.attempt.outcome !== "queued")
    throw new Error("delivery_attempt_not_queued");
  return {
    invitation: { ...projection.invitation, delivery: outcome },
    attempt: { ...projection.attempt, outcome },
  };
}
