import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { recoverInvitationDeliveries } from "../src/access-control/delivery-recovery.js";
const read = (p: string) => readFileSync(p, "utf8");
describe("SMTP wiring and fenced restart recovery", () => {
  it("persists selected transport and reads attempt metadata rather than relabeling history", () => {
    const app = read("src/server/app.ts");
    expect(app).toContain("deliveryTransport?:");
    expect(app).toContain("$5,$6)");
    expect(app).toContain('options.deliveryTransport ?? "local_capture"');
    expect(app).toContain("delivery_transport");
    expect(app).toContain("LEFT JOIN invitation_delivery_attempts");
    expect(app).toContain("messageId: attemptId");
    expect(app).not.toContain('outcome = "failed";');
  });
  it("validates configuration before connecting and recovers only after ownership acquisition", () => {
    const index = read("src/server/index.ts");
    expect(index.indexOf("await loadEmailConfig")).toBeGreaterThan(0);
    expect(index.indexOf("await loadEmailConfig")).toBeLessThan(
      index.indexOf("await connect("),
    );
    expect(index).toContain("await recoverInvitationDeliveries");
    expect(index).not.toContain("deliverToLocalCapture");
  });
  it("has explicit constrained transport migration without changing historical labels", () => {
    const sql = read("migrations/009_invitation_transport.sql");
    expect(sql).toContain("'local_capture','smtp'");
    expect(sql).not.toMatch(/UPDATE\s+invitation_delivery_attempts/i);
  });
  it.each([false, true])(
    "recovers only under the matching generation AND nonce (matching=%s)",
    async (matching) => {
      const query = vi.fn(async (sql: string) =>
        sql.includes("SELECT generation")
          ? {
              rows: [
                { generation: "7", owner_nonce: matching ? "owner" : "other" },
              ],
            }
          : { rows: [], rowCount: 1 },
      );
      const release = vi.fn();
      const pool = { connect: async () => ({ query, release }) };
      if (matching)
        await expect(
          recoverInvitationDeliveries(pool as never, 7n, "owner"),
        ).resolves.toBeUndefined();
      else
        await expect(
          recoverInvitationDeliveries(pool as never, 7n, "owner"),
        ).rejects.toThrow("writer_ownership_lost");
      const sql = query.mock.calls.map((c) => c[0]);
      expect(sql[0]).toBe("BEGIN");
      expect(sql[1]).toContain("pg_advisory_xact_lock_shared");
      const updates = sql.filter((s) => s.startsWith("UPDATE"));
      expect(updates.length).toBe(matching ? 2 : 0);
      if (matching) {
        expect(updates.join(" ")).toContain("status='uncertain'");
        expect(updates.join(" ")).toContain("status IN ('queued','sending')");
        expect(updates.join(" ")).toContain("i.status='pending'");
        expect(updates.join(" ")).toContain("current_delivery_attempt_id");
        expect(updates.join(" ")).not.toContain("='failed'");
      }
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
