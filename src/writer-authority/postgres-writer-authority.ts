import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
export class PostgresWriterAuthority {
  private client: PoolClient | null = null;
  private currentGeneration: bigint | null = null;
  private currentNonce: string | null = null;
  private pid: number | null = null;
  private probe: NodeJS.Timeout | null = null;
  private lost = false;
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      lockKey: number;
      probeMs: number;
      probeTimeoutMs?: number;
      onLoss?: () => void;
    },
  ) {}
  async acquire(timeoutMs: number): Promise<boolean> {
    await this.close();
    const client = await this.pool.connect();
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() <= deadline) {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1) acquired",
          [this.options.lockKey],
        );
        if (lock.rows[0]?.acquired) {
          await client.query("BEGIN");
          try {
            await client.query("SELECT pg_advisory_xact_lock($1)", [
              this.options.lockKey + 1,
            ]);
            const ownerNonce = randomUUID();
            const epoch = await client.query<{ generation: string }>(
              "UPDATE writer_epoch SET generation=generation+1,owner_nonce=$1 WHERE singleton=true RETURNING generation",
              [ownerNonce],
            );
            await client.query("COMMIT");
            this.client = client;
            this.currentGeneration = BigInt(epoch.rows[0]!.generation);
            this.currentNonce = ownerNonce;
            this.pid = (
              await client.query<{ pid: number }>("SELECT pg_backend_pid() pid")
            ).rows[0]!.pid;
            this.lost = false;
            client.on("error", () => this.handleLoss());
            this.scheduleProbe();
            return true;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      client.release();
      return false;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  generation() {
    return this.currentGeneration;
  }
  nonce() {
    return this.currentNonce;
  }
  backendPid() {
    return this.pid;
  }
  private scheduleProbe() {
    this.probe = setInterval(() => {
      void this.prove();
    }, this.options.probeMs);
    this.probe.unref();
  }
  private handleLoss() {
    if (this.lost) return;
    this.lost = true;
    this.currentGeneration = null;
    this.currentNonce = null;
    this.pid = null;
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    const client = this.client;
    this.client = null;
    client?.release(true);
    this.options.onLoss?.();
  }
  private async prove() {
    if (!this.client || this.lost) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.query("SELECT 1"),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("writer_probe_timeout")),
            this.options.probeTimeoutMs ?? this.options.probeMs,
          );
          timeout.unref();
        }),
      ]);
    } catch {
      this.handleLoss();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async close() {
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    const client = this.client;
    this.client = null;
    this.currentGeneration = null;
    this.currentNonce = null;
    this.pid = null;
    if (client) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          this.options.lockKey,
        ]);
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
}
