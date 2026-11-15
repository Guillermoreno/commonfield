import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  openInvitationSecret,
  sealInvitationSecret,
  type InvitationEnvelopeContext,
} from "../../../src/access-control/invitation-envelope.js";
import { PostgresWriterAuthority } from "../../../src/writer-authority/postgres-writer-authority.js";

const context: InvitationEnvelopeContext = {
  invitationId: "inv-1",
  teamId: "team-1",
  email: "member@example.test",
  role: "member",
  expiresAt: "2026-11-16T00:00:00.000Z",
  canonicalOrigin: "http://127.0.0.1:4412",
};

describe("invitation authenticated envelope", () => {
  it("round-trips only with the matching key and complete context", () => {
    const envelope = sealInvitationSecret(
      "secret-fragment",
      context,
      Buffer.alloc(32, 7),
    );
    expect(openInvitationSecret(envelope, context, Buffer.alloc(32, 7))).toBe(
      "secret-fragment",
    );
    expect(() =>
      openInvitationSecret(
        envelope,
        { ...context, role: "administrator" },
        Buffer.alloc(32, 7),
      ),
    ).toThrow();
    expect(() =>
      openInvitationSecret(envelope, context, Buffer.alloc(32, 8)),
    ).toThrow();
  });

  it("uses a fresh nonce for each envelope", () => {
    const key = Buffer.alloc(32, 7);
    expect(sealInvitationSecret("same", context, key)).not.toEqual(
      sealInvitationSecret("same", context, key),
    );
  });

  it.each([Buffer.alloc(0), Buffer.alloc(27)])(
    "rejects malformed envelopes before deciphering",
    (envelope) =>
      expect(() => openInvitationSecret(envelope, context, "key")).toThrow(
        "invitation_envelope_invalid",
      ),
  );
});

class FakeClient extends EventEmitter {
  release = vi.fn();
  query = vi.fn();
}

describe("PostgreSQL writer authority", () => {
  it("acquires, increments generation, exposes PID, and closes cleanly", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ generation: "9" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ pid: 123 }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const authority = new PostgresWriterAuthority(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      { lockKey: 41, probeMs: 60_000 },
    );
    await expect(authority.acquire(10)).resolves.toBe(true);
    expect(authority.generation()).toBe(9n);
    expect(authority.backendPid()).toBe(123);
    await authority.close();
    expect(client.release).toHaveBeenCalledWith();
    expect(authority.generation()).toBeNull();
  });

  it("rolls back and destroys the connection when epoch rotation fails", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("rotation failed"))
      .mockResolvedValueOnce({ rows: [] });
    const authority = new PostgresWriterAuthority(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      { lockKey: 41, probeMs: 100 },
    );
    await expect(authority.acquire(10)).rejects.toThrow("rotation failed");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("marks ownership lost once on connection error", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ generation: "2" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ pid: 77 }] });
    const onLoss = vi.fn();
    const authority = new PostgresWriterAuthority(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      { lockKey: 41, probeMs: 60_000, onLoss },
    );
    await authority.acquire(10);
    client.emit("error", new Error("closed"));
    client.emit("error", new Error("closed again"));
    expect(authority.generation()).toBeNull();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(onLoss).toHaveBeenCalledOnce();
  });
});
