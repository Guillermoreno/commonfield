import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  generateUniqueSecret,
  SecretCollisionError,
} from "../../../src/access-control/unique-secret.js";
import {
  buildInvitationUrl,
  parseInvitationFragment,
} from "../../../src/access-control/invitation-url.js";
import { readinessResponse } from "../../../src/server/runtime-config.js";
import { createUnitOneResultMatrix } from "../../../src/shared/result-evidence.js";

describe("secret allocation boundary", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid allocation budget %s before generating",
    async (attempts) => {
      const generate = vi.fn();
      const digestExists = vi.fn();
      await expect(
        generateUniqueSecret({ attempts, generate, digestExists }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(generate).not.toHaveBeenCalled();
      expect(digestExists).not.toHaveBeenCalled();
    },
  );
  it("retries collisions and returns the digest of the exact fresh secret", async () => {
    const generate = vi
      .fn()
      .mockReturnValueOnce("collision")
      .mockReturnValueOnce("fresh");
    const digestExists = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      generateUniqueSecret({ attempts: 2, generate, digestExists }),
    ).resolves.toEqual({
      raw: "fresh",
      digest: createHash("sha256").update("fresh").digest(),
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(digestExists).toHaveBeenNthCalledWith(
      1,
      createHash("sha256").update("collision").digest(),
    );
  });
  it("stops at the collision budget without returning an allocated secret", async () => {
    const generate = vi.fn(() => "collision");
    await expect(
      generateUniqueSecret({
        attempts: 2,
        generate,
        digestExists: async () => true,
      }),
    ).rejects.toMatchObject({
      name: "SecretCollisionError",
      message: "secret_collision_budget_exhausted",
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(new SecretCollisionError()).toBeInstanceOf(Error);
  });
  it("propagates storage failures rather than assuming a digest is unused", async () => {
    const failure = new Error("storage unavailable");
    await expect(
      generateUniqueSecret({
        attempts: 2,
        generate: () => "candidate",
        digestExists: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});
describe("invitation link grammar", () => {
  it("roundtrips URL-reserved characters only through the fragment", () => {
    const secret = "secret /+?&%#✓";
    const url = new URL(
      buildInvitationUrl("https://board.example.test", secret),
    );
    expect(url.pathname).toBe("/invitations/accept");
    expect(url.search).toBe("");
    expect(parseInvitationFragment(url.hash)).toBe(secret);
  });
  it.each([
    "",
    "token=x",
    "#other=x",
    "#token=",
    "#token=x&next=y",
    "#token=%ZZ",
    "#token=%E0%A4",
  ])("refuses malformed fragment %s", (fragment) =>
    expect(parseInvitationFragment(fragment)).toBeNull(),
  );
  it.each([
    ["https://board.example.test", ""],
    ["http://board.example.test", "secret"],
    ["https://user:pass@board.example.test", "secret"],
  ])("refuses an unsafe invitation origin or absent secret", (origin, secret) =>
    expect(() => buildInvitationUrl(origin!, secret!)).toThrow(),
  );
});
describe("runtime readiness and evidence", () => {
  it.each([
    [
      {
        configurationValid: false,
        databaseAvailable: true,
        ownership: "ready",
      },
      "configuration_invalid",
    ],
    [
      {
        configurationValid: true,
        databaseAvailable: false,
        ownership: "ready",
      },
      "database_unavailable",
    ],
    [
      {
        configurationValid: true,
        databaseAvailable: true,
        ownership: "unavailable",
      },
      "writer_ownership_unavailable",
    ],
    [
      { configurationValid: true, databaseAvailable: true, ownership: "lost" },
      "writer_ownership_lost",
    ],
  ] as const)(
    "does not expose readiness until every prerequisite is satisfied",
    (state, code) =>
      expect(readinessResponse(state)).toEqual({ ready: false, code }),
  );
  it("serializes bigint generations for JSON readiness consumers", () => {
    expect(
      readinessResponse({
        configurationValid: true,
        databaseAvailable: true,
        ownership: "ready",
        generation: 9n,
      }),
    ).toEqual({ ready: true, generation: "9" });
    expect(
      readinessResponse({
        configurationValid: true,
        databaseAvailable: true,
        ownership: "ready",
      }),
    ).toEqual({ ready: true, generation: undefined });
  });
  it("starts every acceptance check as explicitly not run and returns independent records", () => {
    const matrix = createUnitOneResultMatrix();
    expect(matrix.map((row) => row.check)).toEqual([
      "PostgreSQL",
      "two browsers",
      "restart/reload",
      "access denial",
      "deduplication",
      "fencing",
      "lint",
      "format",
      "runtime",
    ]);
    for (const row of matrix)
      expect(row).toMatchObject({
        status: "NOT RUN",
        command: null,
        outcome: null,
      });
    matrix[0]!.status = "FAIL";
    expect(createUnitOneResultMatrix()[0]!.status).toBe("NOT RUN");
    expect(matrix[1]!.status).toBe("NOT RUN");
  });
});
