import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { sealInvitationSecret } from "../src/access-control/invitation-envelope.js";
const origin = "https://board.example.test",
  key = "test-key";
function harness({
  expired = false,
  admin = true,
  claim = true,
  throws = false,
  duplicate = false,
  rotate = false,
} = {}) {
  let writerGeneration = 7n;
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    team_id: "22222222-2222-4222-8222-222222222222",
    email: "bound@example.test",
    role: "member",
    status: "pending",
    expires_at: new Date(
      Date.now() + (expired ? -60_000 : 3600_000),
    ).toISOString(),
    delivery_status: "not_requested",
    delivery_attempts: 0,
    team_name: "Team",
    inviter_name: "Owner",
    secret_envelope: Buffer.alloc(0),
  };
  row.secret_envelope = Buffer.from(
    sealInvitationSecret(
      "recipient-bound-invitation-secret",
      {
        invitationId: row.id,
        teamId: row.team_id,
        email: row.email,
        role: row.role,
        expiresAt: row.expires_at,
        canonicalOrigin: origin,
      },
      key,
    ),
  );
  const writes: { sql: string; params: unknown[] | undefined }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    writes.push({ sql, params });
    if (sql.startsWith("SELECT generation,owner_nonce"))
      return {
        rows: [
          { generation: writerGeneration.toString(), owner_nonce: "owner" },
        ],
        rowCount: 1,
      };
    if (duplicate && sql.startsWith("INSERT INTO invitation_delivery_attempts"))
      throw Object.assign(new Error("private-db-detail"), { code: "23505" });
    if (sql.startsWith("SELECT user_id,csrf_digest"))
      return {
        rows: [
          {
            user_id: "owner",
            csrf_digest: createHash("sha256").update("csrf").digest(),
          },
        ],
        rowCount: 1,
      };
    if (sql.startsWith("SELECT i.id")) return { rows: [row], rowCount: 1 };
    if (sql.startsWith("SELECT 1 FROM memberships"))
      return { rows: [], rowCount: admin ? 1 : 0 };
    if (sql.startsWith("UPDATE invitations SET delivery_status='queued'"))
      return { rows: claim ? [{ id: row.id }] : [], rowCount: claim ? 1 : 0 };
    return { rows: [{ id: row.id }], rowCount: 1 };
  });
  const send = vi.fn(async (message: { to: string; messageId: string }) => {
    void message;
    if (rotate) writerGeneration = 8n;
    if (throws) throw new Error("private-provider-response");
    return "sent" as const;
  });
  const app = createApp(
    { query, connect: async () => ({ query, release: vi.fn() }) } as never,
    {
      publicOrigin: origin,
      invitationEnvelopeKey: key,
      deliverInvitation: send,
      deliveryTransport: "smtp",
      ...(rotate
        ? {
            writerGeneration: () => writerGeneration,
            writerNonce: () => "owner",
          }
        : {}),
    },
  );
  const request = () =>
    app.inject({
      method: "POST",
      url: `/api/invitations/${row.id}/delivery-attempts`,
      headers: {
        origin,
        cookie: "commonfield_session=private-cookie",
        "x-csrf-token": "csrf",
      },
      payload: {},
    });
  return { app, request, send, writes };
}
describe("shared authorized invitation dispatch", () => {
  it("never lets a pre-loss callback complete under newly acquired writer authority", async () => {
    const h = harness({ rotate: true });
    try {
      expect((await h.request()).statusCode).toBe(503);
      expect(h.send).toHaveBeenCalledOnce();
      expect(
        h.writes.some((w) =>
          w.sql.startsWith("UPDATE invitations SET delivery_status=$3"),
        ),
      ).toBe(false);
    } finally {
      await h.app.close();
    }
  });
  it("maps concurrent attempt uniqueness loss to conflict without sending or leaking SQL", async () => {
    const h = harness({ duplicate: true });
    try {
      const r = await h.request();
      expect(r.statusCode).toBe(409);
      expect(r.body).not.toContain("private-db-detail");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
  it("refuses expired invitations before transport", async () => {
    const h = harness({ expired: true });
    try {
      expect((await h.request()).statusCode).toBe(409);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
  it("rechecks administrator membership under the claim transaction", async () => {
    const h = harness({ admin: false });
    try {
      expect((await h.request()).statusCode).toBe(404);
      expect(h.send).not.toHaveBeenCalled();
      expect(
        h.writes.some((w) =>
          w.sql.startsWith("INSERT INTO invitation_delivery_attempts"),
        ),
      ).toBe(false);
    } finally {
      await h.app.close();
    }
  });
  it("never sends after losing the atomic claim", async () => {
    const h = harness({ claim: false });
    try {
      expect((await h.request()).statusCode).toBe(409);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
  it("persists SMTP metadata, recipient binding and attempt identity", async () => {
    const h = harness();
    try {
      const response = await h.request();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        deliveryStatus: "sent",
        deliveryTransport: "smtp",
      });
      const insert = h.writes.find((w) =>
        w.sql.startsWith("INSERT INTO invitation_delivery_attempts"),
      )!;
      expect(insert.params?.[5]).toBe("smtp");
      expect(h.send.mock.calls[0]?.[0]).toMatchObject({
        to: "bound@example.test",
        messageId: insert.params?.[0],
      });
    } finally {
      await h.app.close();
    }
  });
  it("treats an unexpected transport throw as uncertain without leaking provider text", async () => {
    const h = harness({ throws: true });
    try {
      const response = await h.request();
      expect(response.json().deliveryStatus).toBe("uncertain");
      expect(response.body).not.toContain("private-provider-response");
    } finally {
      await h.app.close();
    }
  });
});
