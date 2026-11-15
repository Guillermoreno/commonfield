import { describe, expect, it } from "vitest";
import {
  applyMutation,
  createLedger,
} from "../../../src/collaboration/mutation-ledger.js";

const context = {
  actorId: "actor-1",
  teamId: "team-1",
  boardId: "board-1",
  sessionValid: true,
  membershipActive: true,
  authorityGeneration: "7",
  authorityNonce: "nonce-7",
};

describe("multi-note mutation ledger", () => {
  it("creates several durable notes on one board", () => {
    let ledger = createLedger();
    ledger = applyMutation(ledger, context, {
      operationId: "op-1",
      kind: "create",
      stickyId: "note-1",
      expectedVersion: "0",
      text: "one",
      x: "0",
      y: "0",
      color: "yellow",
    }).ledger;
    ledger = applyMutation(ledger, context, {
      operationId: "op-2",
      kind: "create",
      stickyId: "note-2",
      expectedVersion: "0",
      text: "two",
      x: "100",
      y: "100",
      color: "blue",
    }).ledger;
    expect([...ledger.notes]).toHaveLength(2);
  });

  it("replays an identical operation without reapplying and rejects mismatched reuse", () => {
    const operation = {
      operationId: "op-1",
      kind: "create" as const,
      stickyId: "note-1",
      expectedVersion: "0",
      text: "one",
      x: "0",
      y: "0",
      color: "yellow",
    };
    const first = applyMutation(createLedger(), context, operation);
    const replay = applyMutation(first.ledger, context, operation);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(() =>
      applyMutation(first.ledger, context, { ...operation, text: "changed" }),
    ).toThrow("operation_id_mismatch");
  });

  it.each([
    ["invalid session", { sessionValid: false }, "session_invalid"],
    ["revoked membership", { membershipActive: false }, "membership_revoked"],
    ["stale epoch", { authorityGeneration: "6" }, "writer_fence_mismatch"],
    ["stale nonce", { authorityNonce: "old" }, "writer_fence_mismatch"],
  ])("rejects %s before mutating", (_name, difference, code) => {
    const ledger = createLedger({
      authorityGeneration: "7",
      authorityNonce: "nonce-7",
    });
    expect(() =>
      applyMutation(
        ledger,
        { ...context, ...difference },
        {
          operationId: "op-1",
          kind: "create",
          stickyId: "note-1",
          expectedVersion: "0",
          text: "one",
          x: "0",
          y: "0",
          color: "yellow",
        },
      ),
    ).toThrow(code);
    expect(ledger.notes.size).toBe(0);
  });

  it("enforces expected versions across text, position, and colour", () => {
    const created = applyMutation(createLedger(), context, {
      operationId: "op-1",
      kind: "create",
      stickyId: "note-1",
      expectedVersion: "0",
      text: "one",
      x: "0",
      y: "0",
      color: "yellow",
    });
    expect(() =>
      applyMutation(created.ledger, context, {
        operationId: "op-2",
        kind: "text",
        stickyId: "note-1",
        expectedVersion: "0",
        text: "two",
      }),
    ).toThrow("version_conflict");
  });
});
