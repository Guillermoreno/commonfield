import { describe, expect, it } from "vitest";
import {
  createSessionDeadlines,
  observeSession,
  renewSessionIdleDeadline,
} from "../../../src/access-control/session-deadlines.js";

const issued = new Date("2026-11-13T00:00:00.000Z");

describe("absolute and idle session deadlines", () => {
  it("creates independent 12-hour absolute and 30-minute idle deadlines", () => {
    expect(createSessionDeadlines(issued)).toEqual({
      absoluteExpiresAt: "2026-11-13T12:00:00.000Z",
      idleExpiresAt: "2026-11-13T00:30:00.000Z",
      invalidatedAt: null,
    });
  });

  it("renews idle activity without extending absolute expiry", () => {
    const deadlines = createSessionDeadlines(issued);
    expect(
      renewSessionIdleDeadline(deadlines, new Date("2026-11-13T11:50:00Z")),
    ).toEqual({
      ...deadlines,
      idleExpiresAt: "2026-11-13T12:00:00.000Z",
    });
  });

  it.each([
    ["idle", "2026-11-13T00:30:00Z", "session_idle_expired"],
    ["absolute", "2026-11-13T12:00:00Z", "session_absolute_expired"],
  ])("passively observes %s expiry at the boundary", (_name, at, code) => {
    expect(
      observeSession(createSessionDeadlines(issued), new Date(at)),
    ).toEqual({
      valid: false,
      code,
    });
  });

  it("gives explicit invalidation precedence", () => {
    expect(
      observeSession(
        {
          ...createSessionDeadlines(issued),
          invalidatedAt: "2026-11-13T00:10:00.000Z",
        },
        new Date("2026-11-13T12:00:00Z"),
      ),
    ).toEqual({ valid: false, code: "session_invalidated" });
  });
});
