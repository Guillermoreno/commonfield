import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AppOptions = {
  isWriterReady: () => boolean;
  writerGeneration: () => bigint | null;
  readiness: () => Promise<{ ready: boolean }>;
};

const state = vi.hoisted(() => ({
  generation: null as bigint | null,
  nonce: null as string | null,
  onLoss: undefined as (() => void) | undefined,
  appOptions: undefined as AppOptions | undefined,
  recover: vi.fn(),
  acquire: vi.fn(),
  close: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    query = vi.fn(async () => ({
      rows: [
        {
          current_user: this.role,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
        },
      ],
    }));
    role: string;
    constructor(options: { user: string }) {
      this.role = options.user;
    }
    end = vi.fn();
  },
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => "a".repeat(64) }));
vi.mock("../src/access-control/email-delivery.js", () => ({
  loadEmailConfig: async () => ({ transport: "local_capture" }),
  createInvitationDelivery: () => ({
    transport: "local_capture",
    send: vi.fn(),
  }),
}));
vi.mock("../src/access-control/delivery-recovery.js", () => ({
  recoverInvitationDeliveries: (...args: unknown[]) => state.recover(...args),
}));
vi.mock("../src/writer-authority/postgres-writer-authority.js", () => ({
  PostgresWriterAuthority: class {
    constructor(_pool: unknown, options: { onLoss: () => void }) {
      state.onLoss = options.onLoss;
    }
    generation = () => state.generation;
    nonce = () => state.nonce;
    acquire = state.acquire;
    close = state.close;
  },
}));
vi.mock("../src/server/app.js", () => ({
  createApp: (_pool: unknown, options: AppOptions) => {
    state.appOptions = options;
    return { listen: vi.fn(), close: vi.fn() };
  },
}));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const lose = () => {
  state.generation = null;
  state.nonce = null;
  state.onLoss!();
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let signals: NodeJS.SignalsListener[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.generation = null;
  state.nonce = null;
  state.appOptions = undefined;
  state.acquire.mockImplementation(async () => {
    state.generation = (state.generation ?? 0n) + 1n;
    state.nonce = "owner";
    return true;
  });
  state.close.mockImplementation(async () => {
    state.generation = null;
    state.nonce = null;
  });
  state.recover.mockResolvedValue(undefined);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    listener: NodeJS.SignalsListener,
  ) => {
    if (event === "SIGTERM") signals.push(listener);
    return process;
  }) as typeof process.on);
});
afterEach(() => {
  signals = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live startup authority recovery boundary", () => {
  it.each(["generation", "nonce"])(
    "recovers a changed %s without closing the replacement epoch",
    async (field) => {
      await import("../src/server/index.js");
      const pending = deferred();
      state.recover.mockImplementationOnce(() => pending.promise);
      lose();
      await flush();
      if (field === "generation") state.generation = 9n;
      else state.nonce = "replacement";
      pending.resolve();
      await flush();
      expect(state.appOptions!.isWriterReady()).toBe(false);
      expect(state.appOptions!.writerGeneration()).toBeNull();
      expect((await state.appOptions!.readiness()).ready).toBe(false);
      expect(state.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(state.acquire).toHaveBeenCalledTimes(2);
      expect(state.recover).toHaveBeenCalledTimes(3);
      expect(state.recover).toHaveBeenLastCalledWith(
        expect.anything(),
        state.generation,
        state.nonce,
      );
      expect(state.appOptions!.isWriterReady()).toBe(true);
    },
  );
  it("closes only its own epoch after a recovery query failure and retries with backoff", async () => {
    await import("../src/server/index.js");
    state.recover.mockRejectedValueOnce(new Error("database unavailable"));
    lose();
    await flush();
    expect(state.appOptions!.isWriterReady()).toBe(false);
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(state.acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.acquire).toHaveBeenCalledTimes(3);
    expect(state.appOptions!.isWriterReady()).toBe(true);
  });
  it("does not close a replacement epoch when the old recovery query fails", async () => {
    await import("../src/server/index.js");
    state.recover.mockImplementationOnce(async () => {
      state.nonce = "replacement";
      throw new Error("old query failed");
    });
    lose();
    await flush();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.appOptions!.isWriterReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(state.appOptions!.isWriterReady()).toBe(true);
    expect(state.acquire).toHaveBeenCalledTimes(2);
  });
  it("never publishes a permit when shutdown occurs during recovery", async () => {
    await import("../src/server/index.js");
    const pending = deferred();
    state.recover.mockImplementationOnce(() => pending.promise);
    lose();
    await flush();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    signals[0]!("SIGTERM");
    await flush();
    pending.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.acquire).toHaveBeenCalledTimes(2);
    expect(state.appOptions!.isWriterReady()).toBe(false);
    expect(state.appOptions!.writerGeneration()).toBeNull();
  });
  it("retries loss during recovery without publishing the dead permit", async () => {
    await import("../src/server/index.js");
    expect(state.appOptions!.isWriterReady()).toBe(true);
    const pending = deferred();
    state.recover.mockImplementationOnce(() => pending.promise);
    lose();
    await flush();
    expect(state.recover).toHaveBeenLastCalledWith(
      expect.anything(),
      1n,
      "owner",
    );
    lose(); // Nested loss callback while recoverAuthority is already running.
    pending.resolve();
    await flush();
    expect(state.appOptions!.isWriterReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(state.acquire).toHaveBeenCalledTimes(3);
    expect(state.recover).toHaveBeenCalledTimes(3);
    expect(state.appOptions!.isWriterReady()).toBe(true);
  });
});
