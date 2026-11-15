import { describe, expect, it } from "vitest";
import {
  acceptInvitation,
  canRediscloseInvitation,
  completeDeliveryAttempt,
  createInvitation,
  queueDeliveryAttempt,
  revokeInvitation,
} from "../../../src/access-control/invitation-lifecycle.js";

const issuedAt = new Date("2026-11-13T00:00:00.000Z");

describe("invitation lifecycle and delivery", () => {
  it("creates a pending invitation with an exact 72-hour expiry and no delivery", () => {
    const invitation = createInvitation({
      id: "inv-1",
      teamId: "team-1",
      email: " Member@Example.test ",
      role: "member",
      issuedAt,
    });
    expect(invitation).toMatchObject({
      email: "member@example.test",
      lifecycle: "pending",
      delivery: "not_requested",
      expiresAt: "2026-11-16T00:00:00.000Z",
    });
  });

  it("permits redisclosure only while pending and before expiry", () => {
    const invitation = createInvitation({
      id: "inv-1",
      teamId: "team-1",
      email: "member@example.test",
      role: "administrator",
      issuedAt,
    });
    expect(
      canRediscloseInvitation(invitation, new Date("2026-11-15T23:59:59Z")),
    ).toBe(true);
    expect(
      canRediscloseInvitation(invitation, new Date("2026-11-16T00:00:00Z")),
    ).toBe(false);
    expect(
      canRediscloseInvitation(revokeInvitation(invitation), issuedAt),
    ).toBe(false);
  });

  it("accepts exactly once only for the matching normalized account", () => {
    const invitation = createInvitation({
      id: "inv-1",
      teamId: "team-1",
      email: "member@example.test",
      role: "member",
      issuedAt,
    });
    expect(() =>
      acceptInvitation(invitation, "other@example.test", issuedAt),
    ).toThrow("invitation_account_mismatch");
    const accepted = acceptInvitation(
      invitation,
      " MEMBER@example.test ",
      issuedAt,
    );
    expect(accepted.lifecycle).toBe("accepted");
    expect(() =>
      acceptInvitation(accepted, "member@example.test", issuedAt),
    ).toThrow("invitation_not_pending");
  });

  it("expires passively during acceptance", () => {
    const invitation = createInvitation({
      id: "inv-1",
      teamId: "team-1",
      email: "member@example.test",
      role: "member",
      issuedAt,
    });
    expect(() =>
      acceptInvitation(
        invitation,
        "member@example.test",
        new Date("2026-11-16T00:00:00Z"),
      ),
    ).toThrow("invitation_expired");
  });

  it("queues idempotent attempts independently from lifecycle", () => {
    const invitation = createInvitation({
      id: "inv-1",
      teamId: "team-1",
      email: "member@example.test",
      role: "member",
      issuedAt,
    });
    const first = queueDeliveryAttempt(invitation, "attempt-1");
    const replay = queueDeliveryAttempt(first.invitation, "attempt-1");
    expect(replay).toEqual(first);
    expect(first.invitation.lifecycle).toBe("pending");
    expect(first.invitation.delivery).toBe("queued");
  });

  it.each(["sent", "failed", "uncertain"] as const)(
    "records %s delivery without changing invitation lifecycle",
    (outcome) => {
      const invitation = createInvitation({
        id: "inv-1",
        teamId: "team-1",
        email: "member@example.test",
        role: "member",
        issuedAt,
      });
      const queued = queueDeliveryAttempt(invitation, "attempt-1");
      const completed = completeDeliveryAttempt(queued, outcome);
      expect(completed.invitation.lifecycle).toBe("pending");
      expect(completed.invitation.delivery).toBe(outcome);
      expect(completed.attempt.outcome).toBe(outcome);
    },
  );
});
