import { Pool } from "pg";
import { createApp } from "./app.js";
import { PostgresWriterAuthority } from "../writer-authority/postgres-writer-authority.js";
import { readinessResponse } from "./runtime-config.js";
import { StructuredLogger } from "../shared/structured-logger.js";
import { deliverToLocalCapture } from "../access-control/local-smtp.js";
import { readFile } from "node:fs/promises";
import { isAllowedPublicOrigin } from "./public-origin.js";
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8080";
if (!isAllowedPublicOrigin(publicOrigin)) throw new Error("configuration_invalid:PUBLIC_ORIGIN");
const host = "0.0.0.0";
const port = 4173;
const secret = async (name: string) => (await readFile(`/run/secrets/${name}`, "utf8")).trim();
const connect = async (role: string, passwordFile: string) => {
  const pool = new Pool({host: "postgres", database: "commonfield", user: role, password: await secret(passwordFile)});
  const result = await pool.query("SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  const row = result.rows[0];
  if (!row || row.current_user !== role || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolbypassrls)
    throw new Error("database_role_not_least_privilege");
  return pool;
};
const pool = await connect("commonfield_app", "app_password");
const writerPool = await connect("commonfield_writer", "writer_password");
const invitationEnvelopeKey = await secret("invitation_key");
if (!/^[a-f0-9]{64}$/.test(invitationEnvelopeKey)) throw new Error("invitation_key_invalid");
let lossListener: (() => void) | undefined;
let shuttingDown = false;
let recovering = false;
let ownershipWasLost = false;
const logger = new StructuredLogger();
const recoverAuthority = async () => {
  if (recovering || shuttingDown) return;
  recovering = true;
  try {
    while (!shuttingDown && authority.generation() === null) {
      try {
        if (await authority.acquire(1000)) break;
      } catch {
        // PostgreSQL may still be unavailable; readiness remains terminally false.
      }
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
    ownershipWasLost = true;
    logger.event("ownership.transition", { result: "lost" });
    lossListener?.();
    void recoverAuthority();
  },
});
if (!(await authority.acquire(10_000)))
  throw new Error("writer_ownership_unavailable");
const app = createApp(pool, {
  webRoot: `${process.cwd()}/dist/web`,
  isWriterReady: () => authority.generation() !== null,
  writerGeneration: () => authority.generation(),
  writerNonce: () => authority.nonce(),
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
    if (generation !== null) ownership = "ready";
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
  deliverInvitation: (message) =>
    deliverToLocalCapture(message, { host: "mailpit", port: 1025 }),
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
