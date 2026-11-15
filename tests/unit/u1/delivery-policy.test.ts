import { describe, expect, it } from "vitest";
import {
  buildInvitationMessage,
  deliveryRetryDecision,
} from "../../../src/access-control/delivery-policy.js";

describe("invitation delivery policy", () => {
  it("builds semantic plain-text and HTML messages with the complete local link", () => {
    const message = buildInvitationMessage({
      teamName: "Design Team",
      inviterName: "Admin User",
      role: "member",
      expiresAt: "2026-11-16T00:00:00.000Z",
      invitationUrl: "http://127.0.0.1:4412/invitations/accept#token=secret",
    });
    expect(message.subject).toContain("Design Team");
    expect(message.text).toContain(
      "http://127.0.0.1:4412/invitations/accept#token=secret",
    );
    expect(message.html).toContain(
      '<a href="http://127.0.0.1:4412/invitations/accept#token=secret"',
    );
    expect(message.html).toContain("<time");
  });

  it("escapes untrusted names in HTML while preserving plain text", () => {
    const message = buildInvitationMessage({
      teamName: "<Team>",
      inviterName: "A & B",
      role: "administrator",
      expiresAt: "2026-11-16T00:00:00.000Z",
      invitationUrl: "http://127.0.0.1:4412/invitations/accept#token=abc",
    });
    expect(message.html).toContain("&lt;Team&gt;");
    expect(message.html).toContain("A &amp; B");
    expect(message.text).toContain("<Team>");
  });

  it.each([
    ["not_requested", false, "send"],
    ["failed", false, "retry"],
    ["uncertain", false, "confirmation_required"],
    ["uncertain", true, "resend"],
    ["sent", true, "not_eligible"],
  ] as const)(
    "maps %s with confirmation=%s to %s",
    (state, confirmed, action) => {
      expect(deliveryRetryDecision(state, confirmed)).toBe(action);
    },
  );
});
