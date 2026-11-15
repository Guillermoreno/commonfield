import type { Pool } from "pg";
/** Run only after acquiring writer ownership and before exposing its permit.
 * A prior worker may have transmitted DATA; never resend or declare failure. */
export async function recoverInvitationDeliveries(
  pool: Pool,
  generation: bigint | null,
  nonce: string | null,
): Promise<void> {
  if (generation === null || nonce === null)
    throw new Error("writer_ownership_lost");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared($1)", [741922]);
    const epoch = await client.query<{
      generation: string;
      owner_nonce: string;
    }>("SELECT generation,owner_nonce FROM writer_epoch WHERE singleton=true");
    if (
      epoch.rows[0]?.generation !== generation.toString() ||
      epoch.rows[0]?.owner_nonce !== nonce
    )
      throw new Error("writer_ownership_lost");
    await client.query(
      "UPDATE invitation_delivery_attempts SET status='uncertain',outcome_code='restart_uncertain',completed_at=now() WHERE status IN ('queued','sending')",
    );
    await client.query(
      "UPDATE invitations i SET delivery_status='uncertain' WHERE i.status='pending' AND i.delivery_status='queued' AND (i.current_delivery_attempt_id IS NULL OR EXISTS (SELECT 1 FROM invitation_delivery_attempts a WHERE a.id=i.current_delivery_attempt_id AND a.status='uncertain'))",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
