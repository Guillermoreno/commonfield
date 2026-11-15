import { describe, expect, it } from "vitest";
import { validateStickyText } from "../../../src/board-content/sticky-text.js";
import {
  SessionPolicy,
  normalizeEmail,
  validatePassword,
} from "../../../src/access-control/policies.js";
import { WriterAuthority } from "../../../src/writer-authority/writer-authority.js";
import {
  isNewerVersion,
  operationBinding,
} from "../../../src/collaboration/protocol.js";

describe("BoardContent", () => {
  it.each([
    ["normalizes CRLF", "a\r\nb", "a\nb"],
    ["normalizes CR", "a\rb", "a\nb"],
    ["preserves whitespace", " x ", " x "],
    ["accepts tab and LF", "x\t\ny", "x\t\ny"],
    ["accepts emoji", "🟦", "🟦"],
  ])("%s", (_name, value, normalized) =>
    expect(validateStickyText(value)).toEqual({ ok: true, value: normalized }),
  );
  it.each([
    ["empty", "", "sticky_empty"],
    ["whitespace", " \t\n", "sticky_whitespace_only"],
    ["nul", "a\0", "sticky_forbidden_control"],
    ["del", "a\u007f", "sticky_forbidden_control"],
    ["control", "a\u0007", "sticky_forbidden_control"],
    ["unpaired high", "\ud800", "sticky_invalid_unicode"],
    ["unpaired low", "\udc00", "sticky_invalid_unicode"],
    ["too long", "x".repeat(2001), "sticky_too_long"],
  ])("rejects %s", (_name, value, code) =>
    expect(validateStickyText(value)).toEqual({ ok: false, code }),
  );
});

describe("AccessControl", () => {
  it("normalizes email", () =>
    expect(normalizeEmail("  A@Example.TEST ")).toBe("a@example.test"));
  it.each(["short", "x".repeat(129), "\ud800xxxxxxxxxxx"])(
    "rejects invalid password %j",
    (value) => expect(validatePassword(value).ok).toBe(false),
  );
  it("accepts 12 scalar password", () =>
    expect(validatePassword("12345678901🟦").ok).toBe(true));
  it("uses 12 hour absolute expiry", () =>
    expect(new SessionPolicy().absoluteLifetimeMs).toBe(12 * 60 * 60 * 1000));
  it("uses 30 minute idle expiry", () =>
    expect(new SessionPolicy().idleLifetimeMs).toBe(30 * 60 * 1000));
});

describe("WriterAuthority", () => {
  it("starts unavailable", () =>
    expect(new WriterAuthority().readiness()).toEqual({
      ready: false,
      code: "writer_ownership_unavailable",
    }));
  it("issues generation permit only when ready", () => {
    const a = new WriterAuthority();
    expect(a.permit()).toBeNull();
    a.acquire(4n);
    expect(a.permit()).toEqual({ generation: 4n });
  });
  it("invalidates permits on loss", () => {
    const a = new WriterAuthority();
    a.acquire(4n);
    a.lose();
    expect(a.permit()).toBeNull();
  });
  it("increments loss sequence once", () => {
    const a = new WriterAuthority();
    a.acquire(1n);
    a.lose();
    a.lose();
    expect(a.lossSequence).toBe(1);
  });
  it("never revives an old generation", () => {
    const a = new WriterAuthority();
    a.acquire(1n);
    a.lose();
    expect(() => a.acquire(1n)).toThrow("generation_must_advance");
  });
});

describe("Collaboration protocol", () => {
  it("accepts only newer versions", () => {
    expect(isNewerVersion(2, 1)).toBe(true);
    expect(isNewerVersion(1, 1)).toBe(false);
  });
  it("binds all operation inputs deterministically", () =>
    expect(
      operationBinding({
        actorId: "a",
        teamId: "t",
        boardId: "b",
        stickyId: "s",
        text: "x",
      }),
    ).toBe(
      operationBinding({
        actorId: "a",
        teamId: "t",
        boardId: "b",
        stickyId: "s",
        text: "x",
      }),
    ));
  it("changes binding with payload", () =>
    expect(
      operationBinding({
        actorId: "a",
        teamId: "t",
        boardId: "b",
        stickyId: "s",
        text: "x",
      }),
    ).not.toBe(
      operationBinding({
        actorId: "a",
        teamId: "t",
        boardId: "b",
        stickyId: "s",
        text: "y",
      }),
    ));
});
