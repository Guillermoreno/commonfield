import { operationBinding } from "./protocol.js";

type Note = {
  id: string;
  text: string;
  x: string;
  y: string;
  color: string;
  version: number;
};
type Operation = {
  operationId: string;
  kind: "create" | "text" | "position" | "color";
  stickyId: string;
  expectedVersion: string;
  text?: string;
  x?: string;
  y?: string;
  color?: string;
};
type Context = {
  actorId: string;
  teamId: string;
  boardId: string;
  sessionValid: boolean;
  membershipActive: boolean;
  authorityGeneration: string;
  authorityNonce: string;
};
type Receipt = { binding: string; result: Note };
export type MutationLedger = {
  notes: ReadonlyMap<string, Note>;
  receipts: ReadonlyMap<string, Receipt>;
  authorityGeneration?: string;
  authorityNonce?: string;
};

export function createLedger(authority?: {
  authorityGeneration: string;
  authorityNonce: string;
}): MutationLedger {
  return { notes: new Map(), receipts: new Map(), ...authority };
}

function assertMutationAuthority(ledger: MutationLedger, context: Context) {
  if (!context.sessionValid) throw new Error("session_invalid");
  if (!context.membershipActive) throw new Error("membership_revoked");
  if (
    (ledger.authorityGeneration &&
      ledger.authorityGeneration !== context.authorityGeneration) ||
    (ledger.authorityNonce && ledger.authorityNonce !== context.authorityNonce)
  )
    throw new Error("writer_fence_mismatch");
}

function applyOperation(current: Note | undefined, operation: Operation): Note {
  if (operation.kind === "create") {
    if (current || operation.expectedVersion !== "0")
      throw new Error("version_conflict");
    return {
      id: operation.stickyId,
      text: operation.text ?? "",
      x: operation.x ?? "0",
      y: operation.y ?? "0",
      color: operation.color ?? "yellow",
      version: 1,
    };
  }
  if (!current || String(current.version) !== operation.expectedVersion)
    throw new Error("version_conflict");
  return {
    ...current,
    ...(operation.kind === "text"
      ? { text: operation.text ?? current.text }
      : {}),
    ...(operation.kind === "position"
      ? { x: operation.x ?? current.x, y: operation.y ?? current.y }
      : {}),
    ...(operation.kind === "color"
      ? { color: operation.color ?? current.color }
      : {}),
    version: current.version + 1,
  };
}

export function applyMutation(
  ledger: MutationLedger,
  context: Context,
  operation: Operation,
): { ledger: MutationLedger; result: Note; replayed: boolean } {
  assertMutationAuthority(ledger, context);
  const binding = operationBinding({
    actorId: context.actorId,
    teamId: context.teamId,
    boardId: context.boardId,
    ...Object.fromEntries(
      Object.entries(operation).map(([key, value]) => [key, value ?? ""]),
    ),
  });
  const prior = ledger.receipts.get(operation.operationId);
  if (prior) {
    if (prior.binding !== binding) throw new Error("operation_id_mismatch");
    return { ledger, result: prior.result, replayed: true };
  }
  const notes = new Map(ledger.notes);
  const current = notes.get(operation.stickyId);
  const result = applyOperation(current, operation);
  notes.set(result.id, result);
  const receipts = new Map(ledger.receipts);
  receipts.set(operation.operationId, { binding, result });
  return {
    ledger: {
      notes,
      receipts,
      authorityGeneration: context.authorityGeneration,
      authorityNonce: context.authorityNonce,
    },
    result,
    replayed: false,
  };
}
