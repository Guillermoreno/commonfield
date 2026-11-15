import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/server/app.js";

const origin = "https://board.example.test";
const validPayload = {
  displayName: "First Owner",
  email: "  Owner@Example.Test ",
  teamName: "Owner Team",
  password: "correct horse battery",
};

function bootstrapHarness() {
  let claimed = false;
  const writes: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      return { rowCount: null, rows: [] };
    if (sql.startsWith("INSERT INTO bootstrap_state")) {
      if (claimed) return { rowCount: 0, rows: [] };
      claimed = true;
      return { rowCount: 1, rows: [{ singleton: true }] };
    }
    writes.push({ sql, ...(params ? { params } : {}) });
    return { rowCount: 1, rows: [] };
  });
  const events: unknown[] = [];
  const app = createApp(
    {
      connect: async () => ({ query, release: vi.fn() }),
      query,
    } as never,
    {
      publicOrigin: origin,
      logger: { event: (...args: unknown[]) => events.push(args) } as never,
    },
  );
  return { app, writes, events };
}

describe("user-owned first bootstrap", () => {
  it("atomically creates the submitted normalized owner identity and hashes their password", async () => {
    const { app, writes, events } = bootstrapHarness();
    const response = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      headers: { origin },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(validPayload.password);
    const user = writes.find(({ sql }) => sql.startsWith("INSERT INTO users"));
    expect(user?.params?.slice(1, 3)).toEqual([
      "owner@example.test",
      "First Owner",
    ]);
    expect(user?.params?.[3]).not.toBe(validPayload.password);
    await expect(
      argon2.verify(String(user?.params?.[3]), validPayload.password),
    ).resolves.toBe(true);
    expect(
      writes.find(({ sql }) => sql.startsWith("INSERT INTO teams"))
        ?.params?.[1],
    ).toBe("Owner Team");
    expect(
      writes.find(({ sql }) => sql.startsWith("INSERT INTO memberships"))?.sql,
    ).toContain("'administrator'");
    expect(JSON.stringify(events)).not.toContain(validPayload.password);
    await app.close();
  });

  it("rejects foreign origin, malformed identity, and invalid passwords before writes", async () => {
    const { app, writes } = bootstrapHarness();
    for (const request of [
      { headers: { origin: "https://evil.example" }, payload: validPayload },
      { headers: { origin }, payload: { ...validPayload, email: "invalid" } },
      { headers: { origin }, payload: { ...validPayload, displayName: "" } },
      { headers: { origin }, payload: { ...validPayload, teamName: "" } },
      {
        headers: { origin },
        payload: { ...validPayload, password: "too short" },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bootstrap",
        ...request,
      });
      expect([403, 422]).toContain(response.statusCode);
    }
    expect(writes).toEqual([]);
    await app.close();
  });

  it("allows exactly one submitted owner across concurrent and replayed requests", async () => {
    const { app, writes } = bootstrapHarness();
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/bootstrap",
        headers: { origin },
        payload: validPayload,
      });
    const statuses = (await Promise.all([request(), request()]))
      .map(({ statusCode }) => statusCode)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect((await request()).statusCode).toBe(409);
    expect(
      writes.filter(({ sql }) => sql.startsWith("INSERT INTO users")),
    ).toHaveLength(1);
    expect(
      writes.filter(({ sql }) => sql.startsWith("INSERT INTO teams")),
    ).toHaveLength(1);
    await app.close();
  });
});
