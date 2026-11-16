import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import argon2 from "argon2";
import type WebSocket from "ws";
import { createApp } from "../../../src/server/app.js";
import { sealInvitationSecret } from "../../../src/access-control/invitation-envelope.js";
import { operationBinding } from "../../../src/collaboration/protocol.js";

const origin = "https://board.example.test";
const user = "00000000-0000-4000-8000-000000000001";
const team = "00000000-0000-4000-8000-000000000002";
const board = "00000000-0000-4000-8000-000000000003";
const note = "00000000-0000-4000-8000-000000000004";
const operationId = "00000000-0000-4000-8000-000000000005";
const invitationId = "00000000-0000-4000-8000-000000000006";
const key = "a".repeat(64);
const token = "invitation-secret-".repeat(4);
const digest = (s: string) => createHash("sha256").update(s).digest();
const headers = {
  origin,
  cookie: "commonfield_session=session",
  "x-csrf-token": "csrf",
};
const ok = (rows: object[] = []) => ({ rows, rowCount: rows.length });
type QueryReply = ReturnType<typeof ok>;
type Override = (
  sql: string,
  params: unknown[],
) => QueryReply | undefined | Promise<QueryReply | undefined>;
const apps: ReturnType<typeof createApp>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});
function invitation(overrides: Record<string, unknown> = {}) {
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  return {
    id: invitationId,
    team_id: team,
    email: "invitee@example.test",
    role: "member",
    status: "pending",
    expires_at: expiresAt,
    delivery_status: "not_requested",
    delivery_attempts: 0,
    team_name: "Team",
    inviter_name: "Owner",
    secret_envelope: sealInvitationSecret(
      token,
      {
        invitationId,
        teamId: team,
        email: "invitee@example.test",
        role: "member",
        expiresAt,
        canonicalOrigin: origin,
      },
      key,
    ),
    ...overrides,
  };
}
function harness(
  override: Override = () => undefined,
  options: Parameters<typeof createApp>[1] = {},
) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const custom = await override(sql, params);
    if (custom !== undefined) return custom;
    if (sql.startsWith("SELECT user_id,csrf_digest"))
      return ok(
        Buffer.isBuffer(params[0]) && params[0].equals(digest("session"))
          ? [{ user_id: user, csrf_digest: digest("csrf") }]
          : [],
      );
    if (sql.includes("FROM writer_epoch"))
      return ok([{ generation: "1", owner_nonce: "owner" }]);
    if (
      (sql.startsWith("SELECT 1 FROM sessions") &&
        sql.includes("revoked_at")) ||
      sql.startsWith("SELECT id_digest FROM sessions")
    )
      return ok([{ id_digest: digest("session") }]);
    if (sql.startsWith("SELECT 1 FROM boards")) return ok([{}]);
    if (sql.startsWith("SELECT GREATEST")) return ok([{ delay_ms: "60000" }]);
    if (sql.startsWith("SELECT 1 FROM memberships")) return ok([{}]);
    if (sql.startsWith("SELECT id FROM memberships"))
      return ok([{ id: "membership" }]);
    if (sql.startsWith("SELECT b.team_id")) return ok([{ team_id: team }]);
    if (sql.startsWith("SELECT b.id,b.team_id"))
      return ok([{ id: board, team_id: team, role: "administrator" }]);
    if (sql.startsWith("SELECT b.id,b.name"))
      return ok([{ id: board, name: "Team board" }]);
    if (sql.startsWith("SELECT u.id,u.email"))
      return ok([
        { id: user, email: "owner@example.test", role: "administrator" },
      ]);
    if (sql.startsWith("SELECT i.id")) return ok([invitation()]);
    if (sql.startsWith("SELECT id,team_id,email,role FROM invitations"))
      return ok([
        {
          id: invitationId,
          team_id: team,
          email: "invitee@example.test",
          role: "member",
        },
      ]);
    if (
      sql.startsWith("SELECT") ||
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
    )
      return ok();
    if (sql.startsWith("UPDATE") || sql.startsWith("INSERT"))
      return ok([{ id: invitationId, deadline_version: "2" }]);
    throw new Error("Unexpected SQL in test harness");
  });
  const release = vi.fn();
  const app = createApp(
    { query, connect: async () => ({ query, release }) } as never,
    {
      publicOrigin: origin,
      invitationEnvelopeKey: key,
      generateSecret: () => token,
      ...options,
    },
  );
  apps.push(app);
  const request = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    extraHeaders = headers,
  ) =>
    app.inject({
      method,
      url,
      headers: extraHeaders,
      ...(payload ? { payload } : {}),
    });
  return { app, request, query, release };
}

// Characterization of the public Fastify handlers against a deterministic DB boundary.
// These tests intentionally pass against existing behavior, not invented bug REDs.
describe("portable application routes", () => {
  it("serves readiness and preserves unavailable readiness details", async () => {
    expect((await harness().request("GET", "/api/ready")).json()).toEqual({
      ready: true,
    });
    const a = harness(() => undefined, {
      readiness: () => ({ ready: false, code: "database_unavailable" }),
    });
    expect((await a.request("GET", "/api/ready")).statusCode).toBe(503);
    expect(
      (
        await harness(() => undefined, { isWriterReady: () => false }).request(
          "GET",
          "/api/ready",
        )
      ).json().code,
    ).toBe("writer_ownership_lost");
  });
  it.each(["/api/missing", "/ws/missing", "/missing.js"])(
    "does not serve the SPA for %s",
    async (url) => {
      const r = await harness().request("GET", url);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ code: "not_found" });
    },
  );
  it.each([
    ["POST", "/api/logout"],
    ["POST", `/api/teams/${team}/invitations`],
    ["DELETE", `/api/teams/${team}/invitations/${invitationId}`],
    ["GET", `/api/teams/${team}/invitations`],
    ["POST", `/api/invitations/${invitationId}/revoke`],
    ["POST", `/api/invitations/${invitationId}/delivery-attempts`],
    ["DELETE", `/api/teams/${team}/members/${user}`],
    ["GET", "/api/session"],
    ["GET", `/api/boards/${board}`],
    ["POST", `/api/boards/${board}/stickies`],
    ["PUT", `/api/boards/${board}/sticky`],
  ] as const)("requires authentication for %s %s", async (method, url) => {
    const h = harness();
    const r = await h.request(
      method,
      url,
      {},
      { origin, cookie: "", "x-csrf-token": "csrf" },
    );
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("authentication_required");
    expect(h.release).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", "/api/logout"],
    ["POST", `/api/teams/${team}/invitations`],
    ["DELETE", `/api/teams/${team}/invitations/${invitationId}`],
    ["POST", `/api/invitations/${invitationId}/revoke`],
    ["POST", `/api/invitations/${invitationId}/delivery-attempts`],
    ["DELETE", `/api/teams/${team}/members/${user}`],
    ["POST", `/api/boards/${board}/stickies`],
    ["PUT", `/api/boards/${board}/sticky`],
  ] as const)(
    "protects mutation %s %s from foreign origins",
    async (method, url) => {
      const h = harness();
      const r = await h.request(
        method,
        url,
        {},
        { ...headers, origin: "https://foreign.example.test" },
      );
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe("request_protection_failed");
      expect(h.release).not.toHaveBeenCalled();
    },
  );
  it("rejects revoked or expired sessions", async () => {
    const r = await harness((sql) =>
      sql.startsWith("SELECT user_id") ? ok() : undefined,
    ).request("GET", "/api/session");
    expect(r.statusCode).toBe(401);
  });
  it("logs in with normalized identity and sends only an HttpOnly secure session cookie", async () => {
    const hash = await argon2.hash("correct horse battery");
    const h = harness(
      (sql) =>
        sql.startsWith("SELECT id,password_hash")
          ? ok([{ id: user, password_hash: hash }])
          : undefined,
      { secureCookies: true },
    );
    const r = await h.request("POST", "/api/login", {
      email: "Owner@Example.Test",
      password: "correct horse battery",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      boardId: board,
      teamId: team,
      role: "administrator",
      csrf: expect.any(String),
    });
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(r.headers["set-cookie"]).toContain("Secure");
    expect(r.body).not.toContain(token);
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE email=$1"),
      ["owner@example.test"],
    );
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([{}, { email: "unknown@example.test", password: "password" }])(
    "denies malformed or unknown login",
    async (payload) => {
      const r = await harness().request("POST", "/api/login", payload);
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe("authentication_denied");
    },
  );
  it("denies an incorrect password", async () => {
    const hash = await argon2.hash("correct horse battery");
    expect(
      (
        await harness((sql) =>
          sql.startsWith("SELECT id,password_hash")
            ? ok([{ id: user, password_hash: hash }])
            : undefined,
        ).request("POST", "/api/login", {
          email: "owner@example.test",
          password: "wrong",
        })
      ).statusCode,
    ).toBe(401);
  });
  it("revokes the current session and clears its cookie", async () => {
    const h = harness();
    const r = await h.request("POST", "/api/logout");
    expect(r.statusCode).toBe(204);
    expect(r.headers["set-cookie"]).toContain("Max-Age=0");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("SET revoked_at=now()"),
      [digest("session")],
    );
    expect(h.query).toHaveBeenCalledWith("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("renews CSRF and exposes only active team state", async () => {
    const h = harness();
    const r = await h.request("GET", "/api/session");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      boardId: board,
      teamId: team,
      role: "administrator",
      members: [
        { id: user, email: "owner@example.test", role: "administrator" },
      ],
      deliveryAvailable: false,
    });
    expect(r.json().invitations[0].invitationUrl).toContain(
      encodeURIComponent(token),
    );
    expect(r.json().csrf).not.toBe("csrf");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("csrf_digest=$2"),
      [digest("session"), expect.any(Buffer)],
    );
  });
  it("does not expose invitations to ordinary members or query a nonexistent team", async () => {
    for (const rows of [[{ id: board, team_id: team, role: "member" }], []]) {
      const h = harness((sql) =>
        sql.startsWith("SELECT b.id,b.team_id") ? ok(rows) : undefined,
      );
      const r = await h.request("GET", "/api/session");
      expect(r.statusCode).toBe(200);
      expect(r.json().invitations).toEqual([]);
      expect(
        h.query.mock.calls.some(([sql]) => sql.startsWith("SELECT i.id")),
      ).toBe(false);
    }
  });
  it("rolls back a session that expires during renewal", async () => {
    const h = harness((sql) =>
      sql.startsWith("UPDATE sessions SET csrf_digest") ? ok() : undefined,
    );
    expect((await h.request("GET", "/api/session")).statusCode).toBe(401);
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("returns numeric spatial coordinates and versions without leaking DB encodings", async () => {
    const h = harness((sql) =>
      sql.startsWith("SELECT id,text,x,y,color,version")
        ? ok([
            {
              id: note,
              text: "hello",
              x: "2.25",
              y: "-3.5",
              color: "pink",
              version: "7",
            },
          ])
        : undefined,
    );
    expect((await h.request("GET", `/api/boards/${board}`)).json()).toEqual({
      id: board,
      name: "Team board",
      stickies: [
        {
          id: note,
          text: "hello",
          x: 2.25,
          y: -3.5,
          color: "pink",
          version: 7,
        },
      ],
      sticky: {
        id: note,
        text: "hello",
        x: 2.25,
        y: -3.5,
        color: "pink",
        version: 7,
      },
    });
  });
  it("returns an empty board and hides inaccessible board existence", async () => {
    expect(
      (await harness().request("GET", `/api/boards/${board}`)).json().sticky,
    ).toBeNull();
    const r = await harness((sql) =>
      sql.startsWith("SELECT b.id,b.name") ? ok() : undefined,
    ).request("GET", `/api/boards/${board}`);
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("board_not_found");
  });
});

const inviteUrl = `/api/teams/${team}/invitations`;
const deliveryUrl = `/api/invitations/${invitationId}/delivery-attempts`;
describe("invitation inventory and delivery handlers", () => {
  it("creates a normalized invitation, retains an encrypted secret and returns no-cache headers", async () => {
    const h = harness();
    const r = await h.request("POST", inviteUrl, {
      email: "Invitee@Example.Test",
      role: "member",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      email: "invitee@example.test",
      role: "member",
      token,
      deliveryStatus: "unsent",
      lifecycleStatus: "pending",
    });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    const insert = h.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO invitations"),
    )!;
    expect(insert[1]![4]).toEqual(digest(token));
    expect(insert[1]![6]).toBeInstanceOf(Buffer);
    expect((insert[1]![6] as Buffer).toString()).not.toContain(token);
  });
  it.each([
    ["invalid", 422, "invalid_invitation"],
    ["configuration", 503, "invitation_configuration_unavailable"],
    ["admin", 404, "team_not_found"],
    ["member", 409, "already_member"],
    ["currentAdmin", 404, "team_not_found"],
  ])(
    "rejects invitation creation at %s boundary",
    async (which, status, code) => {
      const h = harness(
        (sql) => {
          if (which === "admin" && sql.startsWith("SELECT 1 FROM memberships"))
            return ok();
          if (which === "member" && sql.startsWith("SELECT 1 FROM users"))
            return ok([{}]);
          if (
            which === "currentAdmin" &&
            sql.startsWith("SELECT id FROM memberships")
          )
            return ok();
          return undefined;
        },
        which === "configuration" ? { invitationEnvelopeKey: "" } : {},
      );
      const r = await h.request(
        "POST",
        inviteUrl,
        which === "invalid"
          ? {}
          : { email: "invitee@example.test", role: "member" },
      );
      expect(r.statusCode).toBe(status);
      expect(r.json().code).toBe(code);
      expect(
        h.query.mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO invitations"),
        ),
      ).toBe(false);
    },
  );
  it.each([
    { status: "accepted" },
    { status: "revoked" },
    { expires_at: new Date(0) },
    { secret_envelope: Buffer.from("corrupt") },
    { secret_envelope: null },
  ])(
    "does not redisclose terminal, expired, absent or unreadable secrets: %j",
    async (changes) => {
      const h = harness((sql) =>
        sql.startsWith("SELECT i.id") ? ok([invitation(changes)]) : undefined,
      );
      const r = await h.request("GET", inviteUrl);
      expect(r.statusCode).toBe(200);
      expect(r.json().invitations[0].invitationUrl).toBeUndefined();
      if (changes.expires_at)
        expect(r.json().invitations[0].lifecycleStatus).toBe("expired");
    },
  );
  it("hides the inventory from nonadministrators", async () => {
    expect(
      (
        await harness((sql) =>
          sql.startsWith("SELECT 1 FROM memberships") ? ok() : undefined,
        ).request("GET", inviteUrl)
      ).statusCode,
    ).toBe(404);
  });
  it.each([
    `${inviteUrl}/${invitationId}`,
    `/api/invitations/${invitationId}/revoke`,
  ])("revokes only eligible invitation at %s", async (url) => {
    const method = url.endsWith("revoke") ? "POST" : "DELETE";
    const h = harness();
    expect((await h.request(method, url)).statusCode).toBe(204);
    expect(
      h.query.mock.calls.find(([sql]) =>
        sql.startsWith("UPDATE invitations"),
      )?.[0],
    ).toContain("secret_envelope=NULL");
    const denied = harness((sql) =>
      sql.startsWith("UPDATE invitations") ? ok() : undefined,
    );
    const r = await denied.request(method, url);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("invitation_terminal");
  });
  it.each(["sent", "failed", "uncertain", "throws"] as const)(
    "persists transport outcome %s after claiming delivery",
    async (outcome) => {
      const send = vi.fn(async () => {
        if (outcome === "throws") throw new Error("transport failed");
        return outcome;
      });
      const h = harness(() => undefined, { deliverInvitation: send });
      const r = await h.request("POST", deliveryUrl, {});
      const expected = outcome === "throws" ? "uncertain" : outcome;
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        deliveryStatus: expected,
        deliveryTransport: "local_capture",
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "invitee@example.test",
          text: expect.stringContaining(token),
          html: expect.stringContaining("Team"),
        }),
      );
      expect(h.query).toHaveBeenCalledWith(
        expect.stringContaining("last_delivery_at=now()"),
        [invitationId, expect.any(String), expected],
      );
      expect(h.release).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    ["missing", "invitation_not_deliverable"],
    ["expired", "invitation_not_deliverable"],
    ["revoked", "invitation_not_deliverable"],
    ["queued", "delivery_not_eligible"],
    ["uncertain", "uncertain_resend_confirmation_required"],
    ["corrupt", "invitation_secret_unavailable"],
  ])("does not send when delivery is %s", async (state, code) => {
    const send = vi.fn(async () => "sent" as const);
    const h = harness(
      (sql) =>
        sql.startsWith("SELECT i.id")
          ? ok(
              state === "missing"
                ? []
                : [
                    invitation(
                      state === "expired"
                        ? { expires_at: new Date(0) }
                        : state === "revoked"
                          ? { status: "revoked" }
                          : state === "corrupt"
                            ? { secret_envelope: Buffer.from("bad") }
                            : { delivery_status: state },
                    ),
                  ],
            )
          : undefined,
      { deliverInvitation: send },
    );
    const r = await h.request("POST", deliveryUrl, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe(code);
    expect(send).not.toHaveBeenCalled();
  });
  it("requires delivery configuration and a closed confirmation body", async () => {
    expect((await harness().request("POST", deliveryUrl, {})).statusCode).toBe(
      503,
    );
    expect(
      (
        await harness(() => undefined, {
          deliverInvitation: async () => "sent",
        }).request("POST", deliveryUrl, { unexpected: true })
      ).statusCode,
    ).toBe(422);
  });
  it.each(["admin", "claim", "unique", "completion"])(
    "does not report a successful delivery when %s loses a race",
    async (phase) => {
      const send = vi.fn(async () => "sent" as const);
      const h = harness(
        (sql) => {
          if (phase === "admin" && sql.startsWith("SELECT 1 FROM memberships"))
            return ok();
          if (
            phase === "claim" &&
            sql.startsWith("UPDATE invitations SET delivery_status='queued'")
          )
            return ok();
          if (
            phase === "unique" &&
            sql.startsWith("INSERT INTO invitation_delivery_attempts")
          )
            throw Object.assign(new Error("collision"), { code: "23505" });
          if (
            phase === "completion" &&
            sql.startsWith("UPDATE invitations SET delivery_status=$3")
          )
            return ok();
          return undefined;
        },
        { deliverInvitation: send },
      );
      const r = await h.request("POST", deliveryUrl, {});
      expect(r.statusCode).toBe(phase === "admin" ? 404 : 409);
      expect(send).toHaveBeenCalledTimes(phase === "completion" ? 1 : 0);
      expect(h.release).toHaveBeenCalledTimes(phase === "completion" ? 2 : 1);
      if (phase === "completion")
        expect(h.query).toHaveBeenCalledWith(
          expect.stringContaining("UPDATE invitation_delivery_attempts"),
          [expect.any(String), "uncertain"],
        );
    },
  );
  it("allows an explicitly confirmed uncertain SMTP resend", async () => {
    const h = harness(
      (sql) =>
        sql.startsWith("SELECT i.id")
          ? ok([invitation({ delivery_status: "uncertain" })])
          : undefined,
      { deliverInvitation: async () => "sent", deliveryTransport: "smtp" },
    );
    expect(
      (
        await h.request("POST", deliveryUrl, { uncertainResendConfirmed: true })
      ).json(),
    ).toEqual({ deliveryStatus: "sent", deliveryTransport: "smtp" });
  });
});

describe("acceptance and membership handlers", () => {
  const payload = {
    token,
    email: "invitee@example.test",
    displayName: "Invitee",
    password: "correct horse battery",
  };
  it("creates an invited identity, membership and session in one transaction", async () => {
    const h = harness();
    const r = await h.request("POST", "/api/invitations/accept", payload);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      userId: expect.any(String),
      csrf: expect.any(String),
    });
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    const insert = h.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO users"),
    )!;
    expect(await argon2.verify(String(insert[1]![3]), payload.password)).toBe(
      true,
    );
    expect(h.query).toHaveBeenCalledWith("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([
    {},
    { ...payload, email: "wrong@example.test" },
    { ...payload, displayName: undefined },
    { ...payload, password: "short" },
  ])("rejects invalid acceptance without creating a user: %j", async (body) => {
    const h = harness();
    const r = await h.request("POST", "/api/invitations/accept", body);
    expect([409, 422]).toContain(r.statusCode);
    expect(
      h.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO users")),
    ).toBe(false);
  });
  it("requires existing identity login and accepts only that identity", async () => {
    for (const id of [user, "other-user"]) {
      const h = harness((sql) =>
        sql.startsWith("SELECT id FROM users") ? ok([{ id }]) : undefined,
      );
      const r = await h.request("POST", "/api/invitations/accept", payload);
      expect(r.statusCode).toBe(id === user ? 200 : 401);
      if (id === user) expect(r.json()).toEqual({ userId: user });
      else expect(r.json().code).toBe("existing_identity_login_required");
    }
  });
  it("revokes a member only when the actor is an active administrator", async () => {
    for (const role of ["administrator", "member"]) {
      const h = harness((sql) =>
        sql.startsWith("SELECT user_id,role,status")
          ? ok([{ user_id: user, role, status: "active" }])
          : undefined,
      );
      const r = await h.request("DELETE", `/api/teams/${team}/members/${user}`);
      expect(r.statusCode).toBe(role === "administrator" ? 204 : 404);
      expect(
        h.query.mock.calls.some(([sql]) =>
          sql.startsWith("UPDATE memberships"),
        ),
      ).toBe(role === "administrator");
      expect(h.release).toHaveBeenCalledOnce();
    }
  });
});

const spatial = {
  operationId,
  stickyId: note,
  text: "hello",
  expectedVersion: 0,
  x: 2.25,
  y: -3.5,
  color: "pink",
};
describe("board mutation transaction boundaries", () => {
  it.each([true, false])(
    "persists a spatial %s creation flag and its receipt",
    async (creating) => {
      const h = harness((sql) =>
        !creating && sql.startsWith("SELECT text,x,y")
          ? ok([{ text: "old", x: 0, y: 0, color: "yellow", version: "1" }])
          : undefined,
      );
      const r = await h.request(
        creating ? "POST" : "PATCH",
        `/api/boards/${board}/stickies${creating ? "" : `/${note}`}`,
        { ...spatial, expectedVersion: creating ? 0 : 1 },
      );
      expect(r.statusCode).toBe(creating ? 201 : 200);
      expect(r.json()).toEqual({
        id: note,
        text: "hello",
        x: 2.25,
        y: -3.5,
        color: "pink",
        version: creating ? 1 : 2,
      });
      expect(
        h.query.mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO operation_receipts"),
        ),
      ).toBe(true);
      expect(h.query).toHaveBeenCalledWith("COMMIT");
      expect(h.release).toHaveBeenCalledOnce();
    },
  );
  it.each(["spatial", "legacy"])(
    "rejects invalid %s mutation inputs and unavailable writers",
    async (kind) => {
      const method = kind === "spatial" ? "POST" : "PUT";
      const url = `/api/boards/${board}/${kind === "spatial" ? "stickies" : "sticky"}`;
      for (const payload of [{}, { ...spatial, text: "x".repeat(10001) }])
        expect((await harness().request(method, url, payload)).statusCode).toBe(
          422,
        );
      expect(
        (
          await harness(() => undefined, {
            isWriterReady: () => false,
          }).request(method, url, spatial)
        ).statusCode,
      ).toBe(503);
    },
  );
  it.each([
    "session",
    "access",
    "renewal",
    "kind",
    "existing",
    "missing",
    "version",
    "receipt",
  ])("rolls back a spatial mutation at %s", async (failure) => {
    const h = harness((sql) => {
      if (failure === "session" && sql.startsWith("SELECT 1 FROM sessions"))
        return ok();
      if (failure === "access" && sql.startsWith("SELECT b.team_id"))
        return ok();
      if (
        failure === "renewal" &&
        sql.startsWith("UPDATE sessions SET last_seen")
      )
        return ok();
      if (
        ["existing", "version"].includes(failure) &&
        sql.startsWith("SELECT text,x,y")
      )
        return ok([
          { text: "canonical", x: 1, y: 2, color: "blue", version: "2" },
        ]);
      if (failure === "receipt" && sql.startsWith("SELECT request_digest"))
        return ok([
          {
            request_digest: Buffer.from("different"),
            operation_kind: "create",
          },
        ]);
      return undefined;
    });
    const patch = ["missing", "version"].includes(failure);
    const r = await h.request(
      patch ? "PATCH" : "POST",
      `/api/boards/${board}/stickies${patch ? `/${note}` : ""}`,
      { ...spatial, ...(failure === "kind" ? { operationKind: "text" } : {}) },
    );
    expect(r.statusCode).toBe(
      ["session", "renewal"].includes(failure)
        ? 401
        : failure === "access"
          ? 404
          : 409,
    );
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.query).not.toHaveBeenCalledWith("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
    if (failure === "existing" || failure === "version")
      expect(r.json().canonical).toMatchObject({
        id: note,
        text: "canonical",
        version: 2,
      });
    if (failure === "missing") expect(r.json().canonical).toBeNull();
  });
  it("replays a bound spatial operation without writing again", async () => {
    const binding = operationBinding({
      actorId: user,
      teamId: team,
      boardId: board,
      stickyId: note,
      text: "create\u0000hello\u00002.25\u0000-3.5\u0000pink",
      expectedVersion: "0",
    });
    const h = harness((sql) =>
      sql.startsWith("SELECT request_digest")
        ? ok([
            {
              request_digest: Buffer.from(binding, "hex"),
              operation_kind: "create",
              sticky_id: note,
              committed_text: "hello",
              committed_x: "2.25",
              committed_y: "-3.5",
              committed_color: "pink",
              committed_version: "1",
            },
          ])
        : undefined,
    );
    const r = await h.request("POST", `/api/boards/${board}/stickies`, spatial);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: note, version: 1, x: 2.25 });
    expect(
      h.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO stickies"),
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "creates or updates legacy sticky (existing=%s)",
    async (existing) => {
      const h = harness((sql) =>
        existing && sql.startsWith("SELECT id,text,version")
          ? ok([{ id: note, text: "old", version: "1" }])
          : undefined,
      );
      const r = await h.request("PUT", `/api/boards/${board}/sticky`, {
        ...spatial,
        expectedVersion: existing ? 1 : 0,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        text: "hello",
        version: existing ? 2 : 1,
      });
      expect(
        h.query.mock.calls.some(([sql]) =>
          sql.startsWith(existing ? "UPDATE stickies" : "INSERT INTO stickies"),
        ),
      ).toBe(true);
    },
  );
  it.each(["session", "access", "version", "receipt"])(
    "rolls back legacy %s conflicts",
    async (failure) => {
      const h = harness((sql) => {
        if (
          failure === "session" &&
          sql.startsWith("SELECT id_digest FROM sessions")
        )
          return ok();
        if (failure === "access" && sql.startsWith("SELECT b.team_id"))
          return ok();
        if (failure === "receipt" && sql.startsWith("SELECT request_digest"))
          return ok([{ request_digest: Buffer.from("different") }]);
        return undefined;
      });
      const r = await h.request("PUT", `/api/boards/${board}/sticky`, {
        ...spatial,
        expectedVersion: failure === "version" ? 3 : 0,
      });
      expect(r.statusCode).toBe(
        failure === "session" ? 401 : failure === "access" ? 404 : 409,
      );
      expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    },
  );
  it.each([null, 2n, 1n])(
    "fences writer epoch %s against the database",
    async (generation) => {
      const h = harness(() => undefined, {
        writerGeneration: () => generation,
        writerNonce: () => "owner",
      });
      const r = await h.request(
        "POST",
        `/api/boards/${board}/stickies`,
        spatial,
      );
      expect(r.statusCode).toBe(generation === 1n ? 201 : 503);
    },
  );
});

async function connectSocket(
  h: ReturnType<typeof harness>,
  offered = "commonfield-csrf.csrf",
  cookieValue = headers.cookie,
  requestOrigin = origin,
) {
  await h.app.ready();
  const messages: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  const socket = await h.app.injectWS(
    `/ws/boards/${board}`,
    {
      headers: {
        origin: requestOrigin,
        cookie: cookieValue,
        "sec-websocket-protocol": offered,
      },
    },
    {
      onInit(ws) {
        ws.on("message", (data) => messages.push(data.toString()));
        ws.on("close", (code, reason) =>
          closed.push({ code, reason: reason.toString() }),
        );
      },
    },
  );
  sockets.push(socket);
  return { socket, messages, closed };
}

describe("live websocket authorization and lifecycle", () => {
  it("authenticates via cookie and renews the session on ping", async () => {
    const h = harness();
    const ws = await connectSocket(h);
    await vi.waitFor(() =>
      expect(ws.messages).toContain('{"type":"subscription.ready"}'),
    );
    ws.socket.send("ping");
    await vi.waitFor(() =>
      expect(ws.messages).toContain('{"type":"session.pong"}'),
    );
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("deadline_version=deadline_version+1"),
      [digest("session")],
    );
  });
  it.each([
    ["no-session", 4401, "session_invalid"],
    ["origin", 4403, "request_protection_failed"],
    ["csrf", 4403, "request_protection_failed"],
    ["membership", 1008, "board_not_found"],
  ] as const)(
    "denies %s websocket admission",
    async (failure, code, reason) => {
      const h = harness((sql) =>
        failure === "membership" && sql.startsWith("SELECT 1 FROM boards")
          ? ok()
          : undefined,
      );
      const ws = await connectSocket(
        h,
        failure === "csrf" ? "other-protocol" : undefined,
        failure === "no-session" ? "" : undefined,
        failure === "origin" ? "https://foreign.example.test" : undefined,
      );
      await vi.waitFor(() => expect(ws.closed).toEqual([{ code, reason }]));
      expect(ws.messages).toEqual([]);
    },
  );
  it.each(["authentication", "session", "membership", "authority", "database"])(
    "closes a ping when %s is lost",
    async (failure) => {
      let lost = false;
      const h = harness(
        (sql) => {
          if (!lost) return undefined;
          if (failure === "authentication" && sql.startsWith("SELECT user_id"))
            return ok();
          if (
            failure === "session" &&
            sql.startsWith("SELECT id_digest FROM sessions")
          )
            return ok();
          if (
            failure === "membership" &&
            sql.startsWith("SELECT 1 FROM boards")
          )
            return ok();
          if (
            failure === "database" &&
            sql.startsWith("SELECT id_digest FROM sessions")
          )
            throw new Error("database unavailable");
          return undefined;
        },
        failure === "authority"
          ? { writerGeneration: () => (lost ? null : 1n) }
          : {},
      );
      const ws = await connectSocket(h);
      await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
      lost = true;
      ws.socket.send("ping");
      const code =
        failure === "membership"
          ? 4403
          : ["authority", "database"].includes(failure)
            ? 1013
            : 4401;
      await vi.waitFor(() => expect(ws.closed[0]?.code).toBe(code));
      expect(ws.messages).not.toContain('{"type":"session.pong"}');
    },
  );
  it.each(["session", "membership", "database"])(
    "periodically terminates a %s-inactive subscription",
    async (failure) => {
      let lost = false;
      const h = harness((sql) => {
        if (!lost) return undefined;
        if (failure === "session" && sql.startsWith("SELECT 1 FROM sessions"))
          return ok();
        if (
          failure === "membership" &&
          sql.startsWith("SELECT 1 FROM memberships")
        )
          return ok();
        if (failure === "database" && sql.startsWith("SELECT 1 FROM sessions"))
          throw new Error("database unavailable");
        return undefined;
      });
      const ws = await connectSocket(h);
      await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
      lost = true;
      await vi.waitFor(() =>
        expect(ws.closed[0]?.code).toBe(
          failure === "session" ? 4401 : failure === "membership" ? 4403 : 1013,
        ),
      );
    },
  );
  it.each(["expired", "renewed", "database", "authority"])(
    "checks the actual session deadline for %s",
    async (state) => {
      const h = harness(
        (sql) => {
          if (sql.startsWith("SELECT GREATEST"))
            return ok([{ delay_ms: "25" }]);
          if (sql.startsWith("SELECT LEAST")) {
            if (state === "database") throw new Error("database unavailable");
            return ok([{ expired: state === "expired" }]);
          }
          return undefined;
        },
        state === "authority" ? { writerGeneration: () => null } : {},
      );
      const ws = await connectSocket(h);
      await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
      if (state === "renewed") {
        await vi.waitFor(() =>
          expect(
            h.query.mock.calls.some(([sql]) => sql.startsWith("SELECT LEAST")),
          ).toBe(true),
        );
        expect(ws.closed).toEqual([]);
        expect(h.query).toHaveBeenCalledWith("ROLLBACK");
      } else {
        await vi.waitFor(() =>
          expect(ws.closed[0]?.code).toBe(state === "expired" ? 4401 : 1013),
        );
        if (state === "expired")
          expect(h.query).toHaveBeenCalledWith(
            expect.stringContaining("revoked_at=COALESCE"),
            [digest("session")],
          );
      }
    },
  );
  it.each([undefined, 1n])(
    "delivers committed mutations to generation %s subscribers",
    async (generation) => {
      const h = harness(
        () => undefined,
        generation === undefined ? {} : { writerGeneration: () => generation },
      );
      const ws = await connectSocket(h);
      await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
      expect(
        (await h.request("POST", `/api/boards/${board}/stickies`, spatial))
          .statusCode,
      ).toBe(201);
      await vi.waitFor(() =>
        expect(ws.messages.map((s) => JSON.parse(s))).toContainEqual({
          type: "sticky.committed",
          sticky: {
            id: note,
            text: "hello",
            x: 2.25,
            y: -3.5,
            color: "pink",
            version: 1,
          },
        }),
      );
      ws.socket.close();
      await vi.waitFor(() => expect(ws.closed).toHaveLength(1));
    },
  );
  it("terminates all subscriptions on authority loss", async () => {
    let lose!: () => void;
    const h = harness(() => undefined, {
      writerGeneration: () => 1n,
      onAuthorityLoss: (listener) => {
        lose = listener;
      },
    });
    const ws = await connectSocket(h);
    await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
    lose();
    await vi.waitFor(() =>
      expect(ws.closed).toEqual([
        { code: 1013, reason: "writer_ownership_lost" },
      ]),
    );
  });
  it("closes the exact session's subscriptions on logout", async () => {
    const h = harness(() => undefined, { writerGeneration: () => 1n });
    const ws = await connectSocket(h);
    await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
    expect((await h.request("POST", "/api/logout")).statusCode).toBe(204);
    await vi.waitFor(() => expect(ws.closed[0]?.code).toBe(4401));
  });
  it.each([false, true])(
    "revokes live membership and reports termination failure=%s",
    async (fails) => {
      const terminate = vi.fn(
        async (socket: { close(code: number, reason: string): void }) => {
          if (fails) throw new Error("termination pending");
          socket.close(4403, "membership_revoked");
        },
      );
      const h = harness(
        (sql) =>
          sql.startsWith("SELECT user_id,role,status")
            ? ok([{ user_id: user, role: "administrator", status: "active" }])
            : undefined,
        { writerGeneration: () => 1n, terminateSubscription: terminate },
      );
      const ws = await connectSocket(h);
      await vi.waitFor(() => expect(ws.messages).toHaveLength(1));
      const r = await h.request("DELETE", `/api/teams/${team}/members/${user}`);
      expect(r.statusCode).toBe(fails ? 503 : 204);
      expect(terminate).toHaveBeenCalledOnce();
      if (fails)
        expect(r.json()).toEqual({
          code: "revocation_termination_pending",
          retryable: true,
        });
      else await vi.waitFor(() => expect(ws.closed[0]?.code).toBe(4403));
    },
  );
});

describe("transaction exceptions", () => {
  it.each([
    [
      "POST",
      "/api/bootstrap",
      {
        displayName: "Owner",
        email: "owner@example.test",
        teamName: "Team",
        password: "correct horse battery",
      },
      "INSERT INTO bootstrap_state",
    ],
    ["POST", "/api/logout", {}, "UPDATE sessions SET revoked_at"],
    [
      "POST",
      inviteUrl,
      { email: "invitee@example.test", role: "member" },
      "INSERT INTO invitations",
    ],
    ["DELETE", `${inviteUrl}/${invitationId}`, {}, "UPDATE invitations"],
    [
      "POST",
      `/api/invitations/${invitationId}/revoke`,
      {},
      "UPDATE invitations",
    ],
    [
      "POST",
      "/api/invitations/accept",
      {
        token,
        email: "invitee@example.test",
        displayName: "Invitee",
        password: "correct horse battery",
      },
      "INSERT INTO users",
    ],
    [
      "DELETE",
      `/api/teams/${team}/members/${user}`,
      {},
      "SELECT user_id,role,status",
    ],
    ["GET", "/api/session", {}, "UPDATE sessions SET csrf_digest"],
    ["POST", `/api/boards/${board}/stickies`, spatial, "INSERT INTO stickies"],
    ["PUT", `/api/boards/${board}/sticky`, spatial, "INSERT INTO stickies"],
    ["POST", deliveryUrl, {}, "INSERT INTO invitation_delivery_attempts"],
    ["POST", deliveryUrl, {}, "UPDATE invitations SET delivery_status=$3"],
  ] as const)(
    "rolls back and releases %s %s when %s fails",
    async (method, url, payload, prefix) => {
      const h = harness(
        (sql) => {
          if (sql.startsWith(prefix)) throw new Error("database unavailable");
          return undefined;
        },
        { deliverInvitation: async () => "sent" },
      );
      const r = await h.request(method, url, payload);
      expect(r.statusCode).toBe(500);
      expect(h.query).toHaveBeenCalledWith("ROLLBACK");
      expect(h.release).toHaveBeenCalled();
    },
  );
});
