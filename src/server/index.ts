import { Pool } from "pg";
import { createApp } from "./app.js";
import { PostgresWriterAuthority } from "../writer-authority/postgres-writer-authority.js";
import { readinessResponse } from "./runtime-config.js";
import { StructuredLogger } from "../shared/structured-logger.js";
import {
  loadEmailConfig,
  createInvitationDelivery,
} from "../access-control/email-delivery.js";
import { recoverInvitationDeliveries } from "../access-control/delivery-recovery.js";
import { readFile } from "node:fs/promises";
import { isAllowedPublicOrigin } from "./public-origin.js";
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8080";
if (!isAllowedPublicOrigin(publicOrigin))
  throw new Error("configuration_invalid:PUBLIC_ORIGIN");
const host = "0.0.0.0";
const port = 4173;
const emailConfig = await loadEmailConfig(process.env);
const emailDelivery = createInvitationDelivery(emailConfig);
const secret = async (name: string) =>
  (await readFile(`/run/secrets/${name}`, "utf8")).trim();
const connect = async (role: string, passwordFile: string) => {
  const pool = new Pool({
    host: "postgres",
    database: "commonfield",
    user: role,
    password: await secret(passwordFile),
  });
  const result = await pool.query(
    "SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  const row = result.rows[0];
  if (
    row?.current_user !== role ||
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolbypassrls
  )
    throw new Error("database_role_not_least_privilege");
  return pool;
};
const pool = await connect("commonfield_app", "app_password");
const writerPool = await connect("commonfield_writer", "writer_password");
const invitationEnvelopeKey = await secret("invitation_key");
if (!/^[a-f0-9]{64}$/.test(invitationEnvelopeKey))
  throw new Error("invitation_key_invalid");
let lossListener: (() => void) | undefined;
let shuttingDown = false;
let recovering = false;
let ownershipWasLost = false;
let recoveredPermit: { generation: bigint; nonce: string } | null = null;
const hasPermit = (generation: bigint | null, nonce: string | null) =>
  generation !== null &&
  nonce !== null &&
  authority.generation() === generation &&
  authority.nonce() === nonce;
const isAuthorityReady = () =>
  !shuttingDown &&
  recoveredPermit !== null &&
  hasPermit(recoveredPermit.generation, recoveredPermit.nonce);
const logger = new StructuredLogger();
const completeRecovery = async (generation: bigint | null, nonce: string | null) => {
  await recoverInvitationDeliveries(pool, generation, nonce);
  // Recovery may commit after the lock connection dies. Expose only the
  // exact still-owned permit, never a replacement owner's epoch.
  if (shuttingDown || !hasPermit(generation, nonce)) return false;
  recoveredPermit = { generation: generation!, nonce: nonce! };
  return true;
};
const recoverAuthority = async () => {
  if (recovering || shuttingDown) return;
  recovering = true;
  try {
    while (!shuttingDown && !isAuthorityReady()) {
      let generation: bigint | null = null;
      let nonce: string | null = null;
      try {
        if (
          authority.generation() !== null ||
          (await authority.acquire(1000))
        ) {
          generation = authority.generation();
          nonce = authority.nonce();
          if (await completeRecovery(generation, nonce)) break;
        }
      } catch {
        // A failed old recovery must not close a replacement owner's epoch.
        if (hasPermit(generation, nonce)) await authority.close();
      }
      if (!shuttingDown)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    recovering = false;
  }
};
const authority = new PostgresWriterAuthority(writerPool, {
  lockKey: 741921,
  probeMs: 1000,
  onLoss: () => {
    recoveredPermit = null;
    ownershipWasLost = true;
    logger.event("ownership.transition", { result: "lost" });
    lossListener?.();
    void recoverAuthority();
  },
});
if (!(await authority.acquire(10_000)))
  throw new Error("writer_ownership_unavailable");
await recoverAuthority();
const app = createApp(pool, {
  webRoot: `${process.cwd()}/dist/web`,
  isWriterReady: isAuthorityReady,
  writerGeneration: () =>
    isAuthorityReady() ? recoveredPermit!.generation : null,
  writerNonce: () => (isAuthorityReady() ? recoveredPermit!.nonce : null),
  onAuthorityLoss: (listener) => {
    lossListener = listener;
  },
  readiness: async () => {
    try {
      await pool.query("SELECT 1");
    } catch {
      return readinessResponse({
        configurationValid: true,
        databaseAvailable: false,
        ownership: ownershipWasLost ? "lost" : "unavailable",
      });
    }
    const generation = authority.generation();
    let ownership: "ready" | "lost" | "unavailable" = "unavailable";
    if (isAuthorityReady()) ownership = "ready";
    else if (ownershipWasLost) ownership = "lost";
    return readinessResponse({
      configurationValid: true,
      databaseAvailable: true,
      ownership,
      ...(generation !== null ? { generation } : {}),
    });
  },
  logger,
  publicOrigin,
  secureCookies: publicOrigin.startsWith("https://"),
  invitationEnvelopeKey,
  deliveryTransport: emailDelivery.transport,
  deliverInvitation: (message) => emailDelivery.send(message),
});
const close = async () => {
  shuttingDown = true;
  logger.event("shutdown", { result: "started" });
  await app.close();
  await authority.close();
  await writerPool.end();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
await app.listen({ host, port });
logger.event("startup", {
  result: "ready",
  ...(authority.generation() !== null
    ? { authorityGeneration: authority.generation()!.toString() }
    : {}),
});
