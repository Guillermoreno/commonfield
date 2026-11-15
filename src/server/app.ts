import { createHash, randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import argon2 from "argon2";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  normalizeEmail,
  validatePassword,
} from "../access-control/policies.js";
import { validateStickyText } from "../board-content/sticky-text.js";
import { operationBinding } from "../collaboration/protocol.js";
import { generateUniqueSecret } from "../access-control/unique-secret.js";
import {
  openInvitationSecret,
  sealInvitationSecret,
  type InvitationEnvelopeContext,
} from "../access-control/invitation-envelope.js";
import {
  buildInvitationMessage,
  deliveryRetryDecision,
} from "../access-control/delivery-policy.js";
import { buildInvitationUrl } from "../access-control/invitation-url.js";
import type { StructuredLogger } from "../shared/structured-logger.js";
import type { readinessResponse } from "./runtime-config.js";
import {
  GenerationDeliveryRegistry,
  type GenerationSubscription,
} from "../collaboration/generation-delivery.js";
import { fileURLToPath } from "node:url";
import {
  isRequestOriginAllowed,
} from "./public-origin.js";

const BOOTSTRAP = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    email: z
      .string()
      .trim()
      .pipe(z.email())
      .transform((value) => normalizeEmail(value)),
    teamName: z.string().trim().min(1).max(100),
    password: z.string().refine((value) => validatePassword(value).ok),
  })
  .strict();
const LOGIN = z.object({ email: z.email(), password: z.string() });
const MUTATION = z.object({
  operationId: z.uuid(),
  text: z.string(),
  expectedVersion: z.number().int().min(0),
});
const SPATIAL_MUTATION = MUTATION.extend({
  stickyId: z.uuid().optional(),
  operationKind: z.enum(["create", "text", "position", "color"]).optional(),
  color: z
    .enum(["yellow", "pink", "blue", "green", "orange", "purple"])
    .default("yellow"),
  x: z
    .number()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => Number.isInteger(value * 4)),
  y: z
    .number()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => Number.isInteger(value * 4)),
});
const INVITE = z.object({
  email: z.email(),
  role: z.enum(["administrator", "member"]),
});
const ACCEPT = z.object({
  token: z.string().min(32),
  email: z.email(),
  displayName: z.string().min(1).max(100).optional(),
  password: z.string().optional(),
});

function accessFailureStatus(code: string): 401 | 404 {
  return code === "authentication_required" ? 401 : 404;
}

function writerPermitExpired(
  permitGeneration: bigint | null | undefined,
  currentGeneration: bigint | null | undefined,
): boolean {
  return (
    permitGeneration !== undefined && currentGeneration !== permitGeneration
  );
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
    salt: randomBytes(16),
  });

type Auth = { userId: string; csrf: Buffer; sessionDigest: Buffer };
async function authenticate(
  request: FastifyRequest,
  pool: Pool,
): Promise<Auth | null> {
  const offered = request.headers["sec-websocket-protocol"];
  const cookieHeader = request.headers.cookie;
  const headerSession =
    typeof cookieHeader === "string"
      ? cookieHeader
          .split(";")
          .map((value) => value.trim())
          .find((value) => value.startsWith("commonfield_session="))
          ?.slice("commonfield_session=".length)
      : undefined;
  const raw =
    request.cookies?.["commonfield_session"] ??
    headerSession ??
    (typeof offered === "string" && offered.startsWith("commonfield-session.")
      ? offered.slice("commonfield-session.".length)
      : undefined);
  if (!raw) return null;
  const result = await pool.query<{ user_id: string; csrf_digest: Buffer }>(
    "SELECT user_id,csrf_digest FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now()",
    [digest(raw)],
  );
  if (!result.rows[0]) return null;
  return {
    userId: result.rows[0].user_id,
    csrf: result.rows[0].csrf_digest,
    sessionDigest: digest(raw),
  };
}
function protectedMutation(
  request: FastifyRequest,
  auth: Auth,
  canonicalOrigin: string,
): boolean {
  const origin = request.headers.origin;
  return (
    typeof origin === "string" &&
    isRequestOriginAllowed(origin, canonicalOrigin) &&
    typeof request.headers["x-csrf-token"] === "string" &&
    digest(request.headers["x-csrf-token"]).equals(auth.csrf)
  );
}

function protectedWebSocket(
  request: FastifyRequest,
  auth: Auth,
  canonicalOrigin: string,
): boolean {
  if (!isRequestOriginAllowed(request.headers.origin, canonicalOrigin))
    return false;
  const offered = request.headers["sec-websocket-protocol"];
  if (typeof offered !== "string") return false;
  const csrf = offered
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("commonfield-csrf."))
    ?.slice("commonfield-csrf.".length);
  return Boolean(csrf && digest(csrf).equals(auth.csrf));
}

type ManagedSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export function createApp(
  pool: Pool,
  options: {
    terminateSubscription?: (socket: ManagedSocket) => Promise<void>;
    isWriterReady?: () => boolean;
    writerGeneration?: () => bigint | null;
    writerNonce?: () => string | null;
    onAuthorityLoss?: (listener: () => void) => void;
    secureCookies?: boolean;
    beforeMutationCommit?: () => Promise<void>;
    generateSecret?: () => string;
    secretRetryAttempts?: number;
    readiness?: () =>
      | ReturnType<typeof readinessResponse>
      | Promise<ReturnType<typeof readinessResponse>>;
    logger?: StructuredLogger;
    webRoot?: string;
    publicOrigin?: string;
    invitationEnvelopeKey?: string | Buffer;
    deliveryTransport?: "local_capture" | "smtp";
    deliverInvitation?: (input: {
      messageId: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }) => Promise<"sent" | "failed" | "uncertain">;
  } = {},
) {
  const app = Fastify({ logger: false });
  const generateSecret =
    options.generateSecret ?? (() => randomBytes(32).toString("base64url"));
  const secretRetryAttempts = options.secretRetryAttempts ?? 4;
  const publicOrigin = options.publicOrigin ?? "http://127.0.0.1:4412";
  const beginAuthorityTransaction = async (client: PoolClient, permit?: {generation:bigint|null|undefined;nonce:string|null|undefined}) => {
    await client.query("BEGIN");
    const fenced = await lockWriterGeneration(
      client,
      permit ? permit.generation : options.writerGeneration?.(),
      permit ? permit.nonce : options.writerNonce?.(),
    );
    if (!fenced) await client.query("ROLLBACK");
    return fenced;
  };
  type InvitationRecord = {
    id: string;
    team_id: string;
    email: string;
    role: "member" | "administrator";
    status: "pending" | "accepted" | "revoked" | "expired";
    expires_at: Date | string;
    secret_envelope: Buffer | null;
    delivery_status:
      | "not_requested"
      | "queued"
      | "sent"
      | "failed"
      | "uncertain";
    delivery_attempts?: number;
    delivery_transport?: "local_capture" | "smtp" | null;
  };
  const invitationContext = (
    row: InvitationRecord,
    canonicalOrigin = publicOrigin,
  ): InvitationEnvelopeContext => ({
    invitationId: row.id,
    teamId: row.team_id,
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString(),
    canonicalOrigin,
  });
  const openRetainedInvitationSecret = (row: InvitationRecord): string => {
    if (!row.secret_envelope || !options.invitationEnvelopeKey)
      throw new Error("invitation_envelope_invalid");
    return openInvitationSecret(row.secret_envelope, invitationContext(row), options.invitationEnvelopeKey);
    throw new Error("invitation_envelope_invalid");
  };
  const invitationDto = (row: InvitationRecord) => {
    const expired =
      row.status === "pending" &&
      new Date(row.expires_at).getTime() <= Date.now();
    let invitationUrl: string | undefined;
    if (
      !expired &&
      row.status === "pending" &&
      row.secret_envelope &&
      options.invitationEnvelopeKey
    ) {
      try {
        invitationUrl = buildInvitationUrl(
          publicOrigin,
          openRetainedInvitationSecret(row),
        );
      } catch {
        // Old or unreadable envelopes remain visible without redisclosing a secret.
      }
    }
    return {
      invitationId: row.id,
      deliveryTransport: row.delivery_transport ?? null,
      email: row.email,
      role: row.role,
      lifecycleStatus: expired ? "expired" : row.status,
      deliveryStatus:
        row.delivery_status === "not_requested"
          ? "unsent"
          : row.delivery_status,
      ...(invitationUrl ? { invitationUrl } : {}),
    };
  };
  const deliveryAttemptConflict = (
    row: InvitationRecord | undefined,
    uncertainResendConfirmed: boolean,
  ) => {
    if (row?.status !== "pending" || !row.secret_envelope || new Date(row.expires_at).getTime() <= Date.now())
      return "invitation_not_deliverable";
    const decision = deliveryRetryDecision(
      row.delivery_status,
      uncertainResendConfirmed,
    );
    if (decision === "confirmation_required")
      return "uncertain_resend_confirmation_required";
    if (decision === "not_eligible") return "delivery_not_eligible";
    return undefined;
  };
  const uniqueSecret = (
    table: "sessions" | "invitations",
    client: Pick<Pool, "query"> | PoolClient = pool,
  ) =>
    generateUniqueSecret({
      attempts: secretRetryAttempts,
      generate: generateSecret,
      digestExists: async (candidate) =>
        Boolean(
          (
            await client.query(
              `SELECT 1 FROM ${table} WHERE ${table === "sessions" ? "id_digest" : "token_digest"}=$1`,
              [candidate],
            )
          ).rowCount,
        ),
    });
  type Subscription = {
    userId: string;
    sessionDigest: string;
    socket: ManagedSocket;
    generationSubscription?: GenerationSubscription;
  };
  const subscriptions = new Map<string, Set<Subscription>>();
  const deliveries = new GenerationDeliveryRegistry();
  options.onAuthorityLoss?.(() => {
    const generation = deliveries.currentGeneration();
    if (generation !== null) deliveries.lose(generation);
    for (const set of subscriptions.values())
      for (const subscription of set)
        subscription.socket.close(1013, "writer_ownership_lost");
    subscriptions.clear();
  });
  void app.register(cookie);
  void app.register(websocket);
  void app.register(fastifyStatic, {
    root:
      options.webRoot ??
      fileURLToPath(new URL("../../../web", import.meta.url)),
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?", 1)[0]!;
    const isSpaNavigation =
      request.method === "GET" &&
      !pathname.startsWith("/api/") &&
      !pathname.startsWith("/ws/") &&
      !pathname.split("/").at(-1)?.includes(".");
    return isSpaNavigation
      ? reply.type("text/html").sendFile("index.html")
      : reply.code(404).send({ code: "not_found" });
  });
  app.get("/api/ready", async (_request, reply) => {
    const state = await options.readiness?.();
    if (state) return state.ready ? state : reply.code(503).send(state);
    return options.isWriterReady && !options.isWriterReady()
      ? reply.code(503).send({ ready: false, code: "writer_ownership_lost" })
      : { ready: true };
  });
  app.post("/api/bootstrap", async (request, reply) => {
    if (!isRequestOriginAllowed(request.headers.origin, publicOrigin))
      return reply.code(403).send({ code: "request_protection_failed" });
    const parsed = BOOTSTRAP.safeParse(request.body);
    if (!parsed.success)
      return reply.code(422).send({ code: "invalid_bootstrap" });
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client)))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      const state = await client.query(
        "INSERT INTO bootstrap_state(singleton) VALUES(true) ON CONFLICT DO NOTHING RETURNING singleton",
      );
      if (!state.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "bootstrap_unavailable" });
      }
      const userId = randomUUID(),
        teamId = randomUUID(),
        boardId = randomUUID();
      const passwordHash = await hashPassword(parsed.data.password);
      await client.query(
        "INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)",
        [userId, parsed.data.email, parsed.data.displayName, passwordHash],
      );
      await client.query("INSERT INTO teams(id,name) VALUES($1,$2)", [
        teamId,
        parsed.data.teamName,
      ]);
      await client.query(
        "INSERT INTO memberships(id,team_id,user_id,role) VALUES($1,$2,$3,'administrator')",
        [randomUUID(), teamId, userId],
      );
      await client.query(
        "INSERT INTO boards(id,team_id,name) VALUES($1,$2,$3)",
        [boardId, teamId, "Team board"],
      );
      await client.query("COMMIT");
      options.logger?.event("bootstrap.completed", { result: "created" });
      return reply.code(201).send({ boardId, teamId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.post("/api/login", async (request, reply) => {
    const parsed = LOGIN.safeParse(request.body);
    if (!parsed.success)
      return reply.code(401).send({ code: "authentication_denied" });
    const result = await pool.query<{ id: string; password_hash: string }>(
      "SELECT id,password_hash FROM users WHERE email=$1",
      [normalizeEmail(parsed.data.email)],
    );
    if (
      !result.rows[0] ||
      !(await argon2.verify(result.rows[0].password_hash, parsed.data.password))
    ) {
      options.logger?.event("authentication.outcome", { result: "denied" });
      return reply.code(401).send({ code: "authentication_denied" });
    }
    const client = await pool.connect();
    let session: string;
    let csrf: string;
    let board: { rows: { id: string; team_id: string; role: string }[] };
    try {
      if (!(await beginAuthorityTransaction(client)))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      const generated = await uniqueSecret("sessions", client);
      session = generated.raw;
      csrf = randomBytes(32).toString("base64url");
      await client.query(
        "INSERT INTO sessions(id_digest,user_id,csrf_digest,absolute_expires_at,idle_expires_at) VALUES($1,$2,$3,now()+interval '12 hours',now()+interval '30 minutes')",
        [generated.digest, result.rows[0].id, digest(csrf)],
      );
      board = await client.query<{
        id: string;
        team_id: string;
        role: string;
      }>(
        "SELECT b.id,b.team_id,m.role FROM boards b JOIN memberships m ON m.team_id=b.team_id WHERE m.user_id=$1 AND m.status='active' ORDER BY b.created_at LIMIT 1",
        [result.rows[0].id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    reply.setCookie("commonfield_session", session, {
      httpOnly: true,
      sameSite: "lax",
      secure: options.secureCookies ?? false,
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    options.logger?.event("authentication.outcome", {
      result: "accepted",
      actorId: result.rows[0].id,
    });
    return {
      csrf,
      boardId: board.rows[0]?.id,
      teamId: board.rows[0]?.team_id,
      role: board.rows[0]?.role,
    };
  });
  app.post("/api/logout", async (request, reply) => {
    const auth = await authenticate(request, pool);
    if (!auth) return reply.code(401).send({ code: "authentication_required" });
    if (!protectedMutation(request, auth, publicOrigin))
      return reply.code(403).send({ code: "request_protection_failed" });
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client)))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      await client.query(
        "SELECT id_digest FROM sessions WHERE id_digest=$1 FOR UPDATE",
        [auth.sessionDigest],
      );
      await client.query(
        "UPDATE sessions SET revoked_at=now() WHERE id_digest=$1",
        [auth.sessionDigest],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const set of subscriptions.values())
      for (const subscription of set)
        if (subscription.sessionDigest === auth.sessionDigest.toString("hex")) {
          set.delete(subscription);
          if (subscription.generationSubscription)
            deliveries.unsubscribe(subscription.generationSubscription);
          subscription.socket.close(4401, "session_invalid");
        }
    reply.clearCookie("commonfield_session", { path: "/" });
    return reply.code(204).send();
  });
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/invitations",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      if (!protectedMutation(request, auth, publicOrigin))
        return reply.code(403).send({ code: "request_protection_failed" });
      const parsed = INVITE.safeParse(request.body);
      if (!parsed.success)
        return reply.code(422).send({ code: "invalid_invitation" });
      if (!options.invitationEnvelopeKey)
        return reply
          .code(503)
          .send({ code: "invitation_configuration_unavailable" });
      const admin = await pool.query(
        "SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active'",
        [request.params.teamId, auth.userId],
      );
      if (!admin.rowCount)
        return reply.code(404).send({ code: "team_not_found" });
      const email = normalizeEmail(parsed.data.email);
      const member = await pool.query(
        "SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND u.email=$2 AND m.status='active'",
        [request.params.teamId, email],
      );
      if (member.rowCount)
        return reply.code(409).send({ code: "already_member" });
      const invitationId = randomUUID();
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const client = await pool.connect();
      try {
        if (!(await beginAuthorityTransaction(client)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        await client.query(
          "SELECT id_digest FROM sessions WHERE id_digest=$1 FOR UPDATE",
          [auth.sessionDigest],
        );
        const currentAdmin = await client.query(
          "SELECT id FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active' FOR UPDATE",
          [request.params.teamId, auth.userId],
        );
        if (!currentAdmin.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ code: "team_not_found" });
        }
        const { raw: token, digest: tokenDigest } = await uniqueSecret(
          "invitations",
          client,
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${request.params.teamId}:${email}`],
        );
        await client.query(
          "UPDATE invitations SET status='revoked',revoked_at=now(),secret_envelope=NULL,delivery_status=CASE WHEN delivery_status='queued' THEN 'uncertain' ELSE delivery_status END WHERE team_id=$1 AND email=$2 AND status='pending'",
          [request.params.teamId, email],
        );
        const envelope = sealInvitationSecret(
          token,
          {
            invitationId,
            teamId: request.params.teamId,
            email,
            role: parsed.data.role,
            expiresAt: expiresAt.toISOString(),
            canonicalOrigin: publicOrigin,
          },
          options.invitationEnvelopeKey,
        );
        await client.query(
          "INSERT INTO invitations(id,team_id,email,role,token_digest,expires_at,secret_envelope) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            invitationId,
            request.params.teamId,
            email,
            parsed.data.role,
            tokenDigest,
            expiresAt,
            envelope,
          ],
        );
        await client.query("COMMIT");
        options.logger?.event("invitation.lifecycle", {
          result: "created",
          actorId: auth.userId,
          teamId: request.params.teamId,
          targetId: invitationId,
        });
        reply.headers({
          "cache-control": "no-store",
          pragma: "no-cache",
          "referrer-policy": "no-referrer",
        });
        return reply.code(201).send({
          ...invitationDto({
            id: invitationId,
            team_id: request.params.teamId,
            email,
            role: parsed.data.role,
            expires_at: expiresAt,
            secret_envelope: envelope,
            status: "pending",
            delivery_status: "not_requested",
          }),
          token,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.delete<{ Params: { teamId: string; invitationId: string } }>(
    "/api/teams/:teamId/invitations/:invitationId",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      if (!protectedMutation(request, auth, publicOrigin))
        return reply.code(403).send({ code: "request_protection_failed" });
      const admin = await pool.query(
        "SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active'",
        [request.params.teamId, auth.userId],
      );
      if (!admin.rowCount)
        return reply.code(404).send({ code: "invitation_not_found" });
      const client = await pool.connect();
      let revoked;
      try {
        if (!(await beginAuthorityTransaction(client)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        await client.query(
          "SELECT id_digest FROM sessions WHERE id_digest=$1 FOR UPDATE",
          [auth.sessionDigest],
        );
        await client.query(
          "SELECT id FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active' FOR UPDATE",
          [request.params.teamId, auth.userId],
        );
        revoked = await client.query(
          "UPDATE invitations SET status='revoked',revoked_at=COALESCE(revoked_at,now()),secret_envelope=NULL,delivery_status=CASE WHEN delivery_status='queued' THEN 'uncertain' ELSE delivery_status END WHERE id=$1 AND team_id=$2 AND status IN ('pending','revoked') RETURNING status",
          [request.params.invitationId, request.params.teamId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (!revoked.rowCount)
        return reply.code(409).send({ code: "invitation_terminal" });
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/invitations",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      const admin = await pool.query(
        "SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active'",
        [request.params.teamId, auth.userId],
      );
      if (!admin.rowCount)
        return reply.code(404).send({ code: "team_not_found" });
      const rows = await pool.query<InvitationRecord>(
        "SELECT i.id,i.team_id,i.email,i.role,i.status,i.expires_at,i.secret_envelope,i.delivery_status,a.transport delivery_transport FROM invitations i LEFT JOIN invitation_delivery_attempts a ON a.id=i.current_delivery_attempt_id WHERE i.team_id=$1 ORDER BY i.created_at,i.id",
        [request.params.teamId],
      );
      reply.headers({
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      });
      return { invitations: rows.rows.map(invitationDto) };
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/api/invitations/:invitationId/revoke",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      if (!protectedMutation(request, auth, publicOrigin))
        return reply.code(403).send({ code: "request_protection_failed" });
      const client = await pool.connect();
      let revoked;
      try {
        if (!(await beginAuthorityTransaction(client)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        await client.query(
          "SELECT id_digest FROM sessions WHERE id_digest=$1 FOR UPDATE",
          [auth.sessionDigest],
        );
        revoked = await client.query(
          "UPDATE invitations i SET status='revoked',revoked_at=COALESCE(i.revoked_at,now()),secret_envelope=NULL,delivery_status=CASE WHEN i.delivery_status='queued' THEN 'uncertain' ELSE i.delivery_status END FROM memberships m WHERE i.id=$1 AND m.team_id=i.team_id AND m.user_id=$2 AND m.role='administrator' AND m.status='active' AND i.status='pending' RETURNING i.id",
          [request.params.invitationId, auth.userId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (!revoked.rowCount)
        return reply.code(409).send({ code: "invitation_terminal" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/api/invitations/:invitationId/delivery-attempts",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      if (!protectedMutation(request, auth, publicOrigin))
        return reply.code(403).send({ code: "request_protection_failed" });
      if (!options.deliverInvitation || !options.invitationEnvelopeKey)
        return reply
          .code(503)
          .send({ code: "delivery_configuration_unavailable" });
      const confirmed = z
        .object({ uncertainResendConfirmed: z.boolean().default(false) })
        .strict()
        .safeParse(request.body);
      if (!confirmed.success)
        return reply.code(422).send({ code: "delivery_request_invalid" });
      const found = await pool.query<
        InvitationRecord & { team_name: string; inviter_name: string }
      >(
        "SELECT i.id,i.team_id,i.email,i.role,i.status,i.expires_at,i.secret_envelope,i.delivery_status,i.delivery_attempts,t.name team_name,u.display_name inviter_name FROM invitations i JOIN teams t ON t.id=i.team_id JOIN memberships m ON m.team_id=i.team_id AND m.user_id=$2 AND m.role='administrator' AND m.status='active' JOIN users u ON u.id=$2 WHERE i.id=$1",
        [request.params.invitationId, auth.userId],
      );
      const row = found.rows[0];
      const conflict = deliveryAttemptConflict(
        row,
        confirmed.data.uncertainResendConfirmed,
      );
      if (conflict) return reply.code(409).send({ code: conflict });
      const deliveryRow = row!;
      let invitationUrl: string;
      try {
        invitationUrl = buildInvitationUrl(
          publicOrigin,
          openRetainedInvitationSecret(deliveryRow),
        );
      } catch {
        return reply.code(409).send({ code: "invitation_secret_unavailable" });
      }
      const message = buildInvitationMessage({
        teamName: deliveryRow.team_name,
        inviterName: deliveryRow.inviter_name,
        role: deliveryRow.role,
        expiresAt: new Date(deliveryRow.expires_at).toISOString(),
        invitationUrl,
      });
      const attemptId = randomUUID();
      const attemptGeneration = (deliveryRow.delivery_attempts ?? 0) + 1;
      const deliveryPermit = {generation:options.writerGeneration?.(),nonce:options.writerNonce?.()};
      const claimClient = await pool.connect();
      try {
        if (!(await beginAuthorityTransaction(claimClient, deliveryPermit)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        const administrator = await claimClient.query(
          "SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2 AND role='administrator' AND status='active' FOR SHARE",
          [deliveryRow.team_id, auth.userId],
        );
        if (!administrator.rowCount) {
          await claimClient.query("ROLLBACK");
          return reply.code(404).send({ code: "team_not_found" });
        }
        await claimClient.query(
          "INSERT INTO invitation_delivery_attempts(id,invitation_id,generation,status,recipient_email,selected_role,transport) VALUES($1,$2,$3,'sending',$4,$5,$6)",
          [
            attemptId,
            deliveryRow.id,
            attemptGeneration,
            deliveryRow.email,
            deliveryRow.role,
            options.deliveryTransport ?? "local_capture",
          ],
        );
        const claimed = await claimClient.query(
          "UPDATE invitations SET delivery_status='queued',delivery_attempts=$3,current_delivery_attempt_id=$4 WHERE id=$1 AND status='pending' AND expires_at>now() AND delivery_status=$2 RETURNING id",
          [
            deliveryRow.id,
            deliveryRow.delivery_status,
            attemptGeneration,
            attemptId,
          ],
        );
        if (!claimed.rowCount) {
          await claimClient.query("ROLLBACK");
          return reply.code(409).send({ code: "delivery_not_eligible" });
        }
        await claimClient.query("COMMIT");
      } catch (error) {
        await claimClient.query("ROLLBACK");
        if ((error as {code?:string}).code === "23505")
          return reply.code(409).send({ code: "delivery_not_eligible" });
        throw error;
      } finally {
        claimClient.release();
      }
      let outcome: "sent" | "failed" | "uncertain";
      try {
        outcome = await options.deliverInvitation({
          messageId: attemptId,
          to: deliveryRow.email,
          ...message,
        });
      } catch {
        outcome = "uncertain";
      }
      const completionClient = await pool.connect();
      let completed;
      try {
        if (!(await beginAuthorityTransaction(completionClient, deliveryPermit)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        completed = await completionClient.query(
          "UPDATE invitations SET delivery_status=$3,last_delivery_at=now() WHERE id=$1 AND status='pending' AND current_delivery_attempt_id=$2 RETURNING id",
          [deliveryRow.id, attemptId, outcome],
        );
        await completionClient.query(
          "UPDATE invitation_delivery_attempts SET status=$2,outcome_code=$2,completed_at=now() WHERE id=$1 AND status='sending'",
          [attemptId, completed.rowCount ? outcome : "uncertain"],
        );
        await completionClient.query("COMMIT");
      } catch (error) {
        await completionClient.query("ROLLBACK");
        throw error;
      } finally {
        completionClient.release();
      }
      if (!completed.rowCount)
        return reply.code(409).send({ code: "invitation_terminal" });
      return { deliveryStatus: outcome, deliveryTransport: options.deliveryTransport ?? "local_capture" };
    },
  );
  app.post("/api/invitations/accept", async (request, reply) => {
    const parsed = ACCEPT.safeParse(request.body);
    if (!parsed.success)
      return reply.code(422).send({ code: "invitation_invalid" });
    const authenticated = await authenticate(request, pool);
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client)))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      const invitation = await client.query<{
        id: string;
        team_id: string;
        email: string;
        role: string;
      }>(
        "SELECT id,team_id,email,role FROM invitations WHERE token_digest=$1 AND status='pending' AND expires_at>now() FOR UPDATE",
        [digest(parsed.data.token)],
      );
      const row = invitation.rows[0];
      if (row?.email !== normalizeEmail(parsed.data.email)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "invitation_invalid" });
      }
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE email=$1",
        [row.email],
      );
      if (existing.rowCount) {
        if (authenticated?.userId !== existing.rows[0]!.id) {
          await client.query("ROLLBACK");
          return reply
            .code(401)
            .send({ code: "existing_identity_login_required" });
        }
        await client.query(
          "INSERT INTO memberships(id,team_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,user_id) WHERE status='active' DO NOTHING",
          [randomUUID(), row.team_id, authenticated.userId, row.role],
        );
        await client.query(
          "UPDATE invitations SET status='accepted',accepted_at=now(),secret_envelope=NULL,delivery_status=CASE WHEN delivery_status='queued' THEN 'uncertain' ELSE delivery_status END WHERE id=$1",
          [row.id],
        );
        await client.query("COMMIT");
        return reply.code(200).send({ userId: authenticated.userId });
      }
      if (
        !parsed.data.displayName ||
        !parsed.data.password ||
        !validatePassword(parsed.data.password).ok
      ) {
        await client.query("ROLLBACK");
        return reply.code(422).send({ code: "invitation_invalid" });
      }
      const userId = randomUUID();
      const { raw: session, digest: sessionDigest } = await uniqueSecret(
        "sessions",
        client,
      );
      const csrf = randomBytes(32).toString("base64url");
      await client.query(
        "INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)",
        [
          userId,
          row.email,
          parsed.data.displayName,
          await hashPassword(parsed.data.password),
        ],
      );
      await client.query(
        "INSERT INTO memberships(id,team_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), row.team_id, userId, row.role],
      );
      await client.query(
        "UPDATE invitations SET status='accepted',accepted_at=now(),secret_envelope=NULL,delivery_status=CASE WHEN delivery_status='queued' THEN 'uncertain' ELSE delivery_status END WHERE id=$1",
        [row.id],
      );
      await client.query(
        "INSERT INTO sessions(id_digest,user_id,csrf_digest,absolute_expires_at,idle_expires_at) VALUES($1,$2,$3,now()+interval '12 hours',now()+interval '30 minutes')",
        [sessionDigest, userId, digest(csrf)],
      );
      await client.query("COMMIT");
      reply.setCookie("commonfield_session", session, {
        httpOnly: true,
        sameSite: "lax",
        secure: options.secureCookies ?? false,
        path: "/",
        maxAge: 12 * 60 * 60,
      });
      return reply.code(201).send({ userId, csrf });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.delete<{ Params: { teamId: string; userId: string } }>(
    "/api/teams/:teamId/members/:userId",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      if (!protectedMutation(request, auth, publicOrigin))
        return reply.code(403).send({ code: "request_protection_failed" });
      const client = await pool.connect();
      try {
        if (!(await beginAuthorityTransaction(client)))
          return reply.code(503).send({ code: "writer_ownership_lost" });
        await client.query(
          "SELECT id_digest FROM sessions WHERE user_id IN ($1,$2) ORDER BY id_digest FOR UPDATE",
          [auth.userId, request.params.userId],
        );
        const memberships = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          "SELECT user_id,role,status FROM memberships WHERE team_id=$1 AND user_id IN ($2,$3) ORDER BY user_id FOR UPDATE",
          [request.params.teamId, auth.userId, request.params.userId],
        );
        const admin = memberships.rows.some(
          (row) =>
            row.user_id === auth.userId &&
            row.role === "administrator" &&
            row.status === "active",
        );
        if (!admin) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ code: "team_not_found" });
        }
        await client.query(
          "UPDATE memberships SET status='revoked',revoked_at=COALESCE(revoked_at,now()) WHERE team_id=$1 AND user_id=$2",
          [request.params.teamId, request.params.userId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      options.logger?.event("membership.revocation", {
        result: "committed",
        actorId: auth.userId,
        teamId: request.params.teamId,
        targetId: request.params.userId,
      });
      const affected = [...subscriptions.values()]
        .flatMap((set) => [...set])
        .filter(
          (subscription) => subscription.userId === request.params.userId,
        );
      for (const set of subscriptions.values())
        for (const subscription of affected) {
          set.delete(subscription);
          if (subscription.generationSubscription)
            deliveries.unsubscribe(subscription.generationSubscription);
        }
      try {
        await Promise.all(
          affected.map((subscription) =>
            options.terminateSubscription
              ? options.terminateSubscription(subscription.socket)
              : Promise.resolve(
                  subscription.socket.close(4403, "membership_revoked"),
                ),
          ),
        );
      } catch {
        return reply
          .code(503)
          .send({ code: "revocation_termination_pending", retryable: true });
      }
      return reply.code(204).send();
    },
  );
  app.get("/api/session", async (request, reply) => {
    const auth = await authenticate(request, pool);
    if (!auth) return reply.code(401).send({ code: "authentication_required" });
    const csrf = randomBytes(32).toString("base64url");
    const client = await pool.connect();
    let board: { rows: { id: string; team_id: string; role: string }[] };
    try {
      if (!(await beginAuthorityTransaction(client)))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      await client.query(
        "SELECT id_digest FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() FOR UPDATE",
        [auth.sessionDigest],
      );
      board = await client.query<{
        id: string;
        team_id: string;
        role: string;
      }>(
        "SELECT b.id,b.team_id,m.role FROM boards b JOIN memberships m ON m.team_id=b.team_id WHERE m.user_id=$1 AND m.status='active' ORDER BY b.created_at LIMIT 1 FOR UPDATE OF m",
        [auth.userId],
      );
      const renewed = await client.query(
        "UPDATE sessions SET csrf_digest=$2,last_seen_at=now(),idle_expires_at=LEAST(absolute_expires_at,now()+interval '30 minutes'),deadline_version=deadline_version+1 WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() RETURNING deadline_version",
        [auth.sessionDigest, digest(csrf)],
      );
      if (!renewed.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ code: "authentication_required" });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const teamId = board.rows[0]?.team_id;
    const members = teamId
      ? await pool.query<{ id: string; email: string; role: string }>(
          "SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY u.email,u.id",
          [teamId],
        )
      : { rows: [] };
    const invitationRows =
      teamId && board.rows[0]?.role === "administrator"
        ? await pool.query<InvitationRecord>(
            "SELECT i.id,i.team_id,i.email,i.role,i.status,i.expires_at,i.secret_envelope,i.delivery_status,a.transport delivery_transport FROM invitations i LEFT JOIN invitation_delivery_attempts a ON a.id=i.current_delivery_attempt_id WHERE i.team_id=$1 ORDER BY i.created_at,i.id",
            [teamId],
          )
        : { rows: [] };
    return {
      csrf,
      boardId: board.rows[0]?.id,
      teamId,
      role: board.rows[0]?.role,
      members: members.rows,
      invitations: invitationRows.rows.map(invitationDto),
      deliveryAvailable: Boolean(options.deliverInvitation),
      deliveryTransport: options.deliveryTransport ?? "local_capture",
    };
  });
  app.get<{ Params: { boardId: string } }>(
    "/api/boards/:boardId",
    async (request, reply) => {
      const auth = await authenticate(request, pool);
      if (!auth)
        return reply.code(401).send({ code: "authentication_required" });
      const result = await pool.query(
        "SELECT b.id,b.name FROM boards b JOIN memberships m ON m.team_id=b.team_id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1",
        [request.params.boardId, auth.userId],
      );
      if (!result.rows[0])
        return reply.code(404).send({ code: "board_not_found" });
      const row = result.rows[0];
      const notes = await pool.query(
        "SELECT id,text,x,y,color,version FROM stickies WHERE board_id=$1 ORDER BY updated_at,id",
        [request.params.boardId],
      );
      const stickies = notes.rows.map((note) => ({
        ...note,
        x: Number(note.x),
        y: Number(note.y),
        color: note.color,
        version: Number(note.version),
      }));
      return {
        id: row.id,
        name: row.name,
        stickies,
        sticky: stickies[0] ?? null,
      };
    },
  );
  app.post<{ Params: { boardId: string } }>(
    "/api/boards/:boardId/stickies",
    async (request, reply) => spatialMutation(request, reply, true),
  );
  app.patch<{ Params: { boardId: string; stickyId: string } }>(
    "/api/boards/:boardId/stickies/:stickyId",
    async (request, reply) => spatialMutation(request, reply, false),
  );
  async function prepareSpatialMutation(
    request: FastifyRequest<{ Params: { boardId: string; stickyId?: string } }>,
    reply: FastifyReply,
  ) {
    if (options.isWriterReady && !options.isWriterReady()) {
      reply.code(503).send({ code: "writer_ownership_lost" });
      return null;
    }
    const permitGeneration = options.writerGeneration?.();
    if (permitGeneration !== undefined && permitGeneration !== null)
      deliveries.activate(permitGeneration);
    const auth = await authenticate(request, pool);
    if (!auth) {
      reply.code(401).send({ code: "authentication_required" });
      return null;
    }
    if (!protectedMutation(request, auth, publicOrigin)) {
      reply.code(403).send({ code: "request_protection_failed" });
      return null;
    }
    const body = request.body as { stickyId?: string };
    const parsed = SPATIAL_MUTATION.safeParse({
      ...body,
      stickyId: request.params.stickyId ?? body.stickyId,
    });
    if (!parsed.success) {
      reply.code(422).send({ code: "invalid_mutation" });
      return null;
    }
    const valid = validateStickyText(parsed.data.text);
    if (!valid.ok) {
      reply.code(422).send({ code: valid.code });
      return null;
    }
    return { auth, data: parsed.data, text: valid.value, permitGeneration };
  }

  async function spatialMutation(
    request: FastifyRequest<{ Params: { boardId: string; stickyId?: string } }>,
    reply: FastifyReply,
    creating: boolean,
  ) {
    const prepared = await prepareSpatialMutation(request, reply);
    if (!prepared) return;
    const { auth, data, text, permitGeneration } = prepared;
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client))) {
        return reply.code(503).send({ code: "writer_ownership_lost" });
      }
      const access = await spatialAccess(client, auth, request.params.boardId);
      if (access.code) {
        await client.query("ROLLBACK");
        return reply
          .code(accessFailureStatus(access.code))
          .send({ code: access.code });
      }
      const id = creating
        ? (data.stickyId ?? randomUUID())
        : request.params.stickyId!;
      const current = await client.query<{
        text: string;
        x: number;
        y: number;
        color: string;
        version: string;
      }>(
        "SELECT text,x,y,color,version FROM stickies WHERE id=$1 AND board_id=$2 FOR UPDATE",
        [id, request.params.boardId],
      );
      const operationKind =
        data.operationKind ?? (creating ? "create" : "text");
      if (!validOperationKind(creating, operationKind)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "operation_conflict" });
      }
      const binding = operationBinding({
        actorId: auth.userId,
        teamId: access.teamId!,
        boardId: request.params.boardId,
        stickyId: id,
        text: `${operationKind}\u0000${text}\u0000${data.x}\u0000${data.y}\u0000${data.color}`,
        expectedVersion: String(data.expectedVersion),
      });
      const receipt = await spatialReceipt(
        client,
        data.operationId,
        binding,
        operationKind,
      );
      if (receipt.state === "conflict") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "operation_conflict" });
      }
      if (receipt.state === "replay") {
        await client.query("COMMIT");
        return receipt.outcome;
      }
      const version = current.rows[0] ? Number(current.rows[0].version) : 0;
      const conflict = spatialVersionConflict(
        current.rows[0],
        creating,
        data.expectedVersion,
        id,
      );
      if (conflict !== undefined) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          code: "version_conflict",
          canonical: conflict,
        });
      }
      const next = version + 1;
      await persistSpatialSticky(client, creating, {
        id,
        boardId: request.params.boardId,
        text,
        x: data.x,
        y: data.y,
        color: data.color,
        version: next,
      });
      await client.query(
        "INSERT INTO operation_receipts(operation_id,actor_id,team_id,board_id,sticky_id,request_digest,committed_version,committed_text,committed_x,committed_y,committed_color,operation_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          data.operationId,
          auth.userId,
          access.teamId!,
          request.params.boardId,
          id,
          Buffer.from(binding, "hex"),
          next,
          text,
          data.x,
          data.y,
          data.color,
          operationKind,
        ],
      );
      await options.beforeMutationCommit?.();
      const renewed = await client.query(
        "UPDATE sessions SET last_seen_at=now(),idle_expires_at=LEAST(absolute_expires_at,now()+interval '30 minutes'),deadline_version=deadline_version+1 WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() RETURNING deadline_version",
        [auth.sessionDigest],
      );
      if (!renewed.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ code: "authentication_required" });
      }
      await client.query("COMMIT");
      const outcome = {
        id,
        text,
        x: data.x,
        y: data.y,
        color: data.color,
        version: next,
      };
      if (writerPermitExpired(permitGeneration, options.writerGeneration?.()))
        return reply.code(503).send({ code: "writer_ownership_lost" });
      deliverCommittedSticky(request.params.boardId, permitGeneration, outcome);
      return reply.code(creating ? 201 : 200).send(outcome);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function prepareLegacyMutation(
    request: FastifyRequest<{ Params: { boardId: string } }>,
    reply: FastifyReply,
  ) {
    if (options.isWriterReady && !options.isWriterReady()) {
      reply.code(503).send({ code: "writer_ownership_lost" });
      return null;
    }
    const permitGeneration = options.writerGeneration?.();
    if (permitGeneration !== undefined && permitGeneration !== null)
      deliveries.activate(permitGeneration);
    const auth = await authenticate(request, pool);
    if (!auth) {
      reply.code(401).send({ code: "authentication_required" });
      return null;
    }
    if (!protectedMutation(request, auth, publicOrigin)) {
      reply.code(403).send({ code: "request_protection_failed" });
      return null;
    }
    const parsed = MUTATION.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ code: "invalid_mutation" });
      return null;
    }
    const validation = validateStickyText(parsed.data.text);
    if (!validation.ok) {
      reply.code(422).send({ code: validation.code });
      return null;
    }
    return {
      auth,
      parsed: parsed.data,
      text: validation.value,
      permitGeneration,
    };
  }

  function deliverCommittedSticky(
    boardId: string,
    permitGeneration: bigint | null | undefined,
    outcome: { id: string; text: string; version: number },
  ) {
    const message = JSON.stringify({
      type: "sticky.committed",
      sticky: outcome,
    });
    if (permitGeneration === undefined) {
      for (const subscription of subscriptions.get(boardId) ?? [])
        subscription.socket.send(message);
      return;
    }
    if (permitGeneration !== null)
      deliveries.deliver(permitGeneration, message, () => {});
  }

  app.put<{ Params: { boardId: string } }>(
    "/api/boards/:boardId/sticky",
    async (request, reply) => {
      const prepared = await prepareLegacyMutation(request, reply);
      if (!prepared) return;
      const { auth, parsed, text, permitGeneration } = prepared;
      const client = await pool.connect();
      try {
        const outcome = await mutate(client, reply, {
          userId: auth.userId,
          boardId: request.params.boardId,
          operationId: parsed.operationId,
          text,
          expectedVersion: parsed.expectedVersion,
          writerGeneration: permitGeneration,
          writerNonce: options.writerNonce?.(),
          sessionDigest: auth.sessionDigest,
          beforeCommit: options.beforeMutationCommit,
        });
        if (outcome && "version" in outcome) {
          if (
            permitGeneration !== undefined &&
            options.writerGeneration?.() !== permitGeneration
          )
            return reply.code(503).send({ code: "writer_ownership_lost" });
          deliverCommittedSticky(
            request.params.boardId,
            permitGeneration,
            outcome,
          );
          options.logger?.event("mutation.committed", {
            result: "delivered",
            operationId: parsed.operationId,
            actorId: auth.userId,
            targetId: outcome.id,
            committedVersion: outcome.version,
            ...(permitGeneration !== undefined && permitGeneration !== null
              ? { authorityGeneration: permitGeneration.toString() }
              : {}),
          });
        }
        return outcome;
      } finally {
        client.release();
      }
    },
  );
  async function closeInactiveSubscription(
    socket: { close(code: number, reason: string): void },
    subscription: Subscription,
    set: Set<Subscription>,
    auth: Auth,
    boardId: string,
  ): Promise<void> {
    const activeSession = await pool.query(
      "SELECT 1 FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now()",
      [auth.sessionDigest],
    );
    if (!activeSession.rowCount) {
      set.delete(subscription);
      socket.close(4401, "session_invalid");
      return;
    }
    const activeMembership = await pool.query(
      "SELECT 1 FROM memberships m JOIN boards b ON b.team_id=m.team_id WHERE m.user_id=$1 AND m.status='active' AND b.id=$2",
      [auth.userId, boardId],
    );
    if (!activeMembership.rowCount) {
      set.delete(subscription);
      socket.close(4403, "membership_revoked");
    }
  }

  async function answerSocketMessage(
    socket: {
      close(code: number, reason: string): void;
      send(value: string): void;
    },
    request: FastifyRequest<{ Params: { boardId: string } }>,
  ): Promise<void> {
    const current = await authenticate(request, pool);
    if (!current) {
      socket.close(4401, "session_invalid");
      return;
    }
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client))) {
        socket.close(1013, "writer_ownership_lost");
        return;
      }
      const session = await client.query(
        "SELECT id_digest FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() FOR UPDATE",
        [current.sessionDigest],
      );
      if (!session.rowCount) {
        await client.query("ROLLBACK");
        socket.close(4401, "session_invalid");
        return;
      }
      const membership = await client.query(
        "SELECT 1 FROM boards b JOIN memberships m ON m.team_id=b.team_id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1 FOR UPDATE OF m",
        [request.params.boardId, current.userId],
      );
      if (!membership.rowCount) {
        await client.query("ROLLBACK");
        socket.close(4403, "membership_revoked");
        return;
      }
      await client.query(
        "UPDATE sessions SET last_seen_at=now(),idle_expires_at=LEAST(absolute_expires_at,now()+interval '30 minutes'),deadline_version=deadline_version+1 WHERE id_digest=$1 RETURNING deadline_version",
        [current.sessionDigest],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    socket.send(JSON.stringify({ type: "session.pong" }));
  }

  async function transitionExpiredSession(
    auth: Auth,
    subscription: Subscription,
    set: Set<Subscription>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      if (!(await beginAuthorityTransaction(client))) {
        subscription.socket.close(1013, "writer_ownership_lost");
        return;
      }
      const session = await client.query<{
        expired: boolean;
      }>(
        "SELECT LEAST(absolute_expires_at,idle_expires_at)<=now() AS expired FROM sessions WHERE id_digest=$1 FOR UPDATE",
        [auth.sessionDigest],
      );
      if (!session.rows[0]?.expired) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(
        "UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id_digest=$1",
        [auth.sessionDigest],
      );
      await client.query("COMMIT");
      set.delete(subscription);
      if (subscription.generationSubscription)
        deliveries.unsubscribe(subscription.generationSubscription);
      subscription.socket.close(4401, "session_invalid");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function scheduleSessionExpiry(
    auth: Auth,
    subscription: Subscription,
    set: Set<Subscription>,
  ): Promise<ReturnType<typeof setTimeout>> {
    const deadline = await pool.query<{ delay_ms: string }>(
      "SELECT GREATEST(0,EXTRACT(EPOCH FROM (LEAST(absolute_expires_at,idle_expires_at)-now()))*1000)::bigint AS delay_ms FROM sessions WHERE id_digest=$1",
      [auth.sessionDigest],
    );
    const delay = Math.min(
      Number(deadline.rows[0]?.delay_ms ?? 0),
      2_147_483_647,
    );
    return setTimeout(() => {
      void transitionExpiredSession(auth, subscription, set).catch(() =>
        subscription.socket.close(1013, "database_unavailable"),
      );
    }, delay);
  }

  app.after(() => {
    app.get<{ Params: { boardId: string } }>(
      "/ws/boards/:boardId",
      { websocket: true },
      async (socket, request) => {
        const auth = await authenticate(request, pool);
        if (!auth) {
          socket.close(4401, "session_invalid");
          return;
        }
        if (!protectedWebSocket(request, auth, publicOrigin)) {
          socket.close(4403, "request_protection_failed");
          return;
        }
        const allowed = await pool.query(
          "SELECT 1 FROM boards b JOIN memberships m ON m.team_id=b.team_id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1",
          [request.params.boardId, auth.userId],
        );
        if (!allowed.rowCount) {
          socket.close(1008, "board_not_found");
          return;
        }
        const set = subscriptions.get(request.params.boardId) ?? new Set();
        const subscription: Subscription = {
          userId: auth.userId,
          sessionDigest: auth.sessionDigest.toString("hex"),
          socket,
        };
        set.add(subscription);
        subscriptions.set(request.params.boardId, set);
        const sessionExpiryTimer = await scheduleSessionExpiry(
          auth,
          subscription,
          set,
        );
        const expiryTimer = setInterval(() => {
          void closeInactiveSubscription(
            socket,
            subscription,
            set,
            auth,
            request.params.boardId,
          ).catch(socket.close.bind(socket, 1013, "database_unavailable"));
        }, 500);
        const generation = options.writerGeneration?.();
        if (generation !== undefined && generation !== null) {
          deliveries.activate(generation);
          subscription.generationSubscription = deliveries.subscribe(
            generation,
            (message) => socket.send(message),
          );
        }
        socket.send(JSON.stringify({ type: "subscription.ready" }));
        options.logger?.event("subscription.lifecycle", {
          result: "opened",
          actorId: auth.userId,
          targetId: request.params.boardId,
        });
        socket.on("message", () => {
          void answerSocketMessage(socket, request).catch(
            socket.close.bind(socket, 1013, "database_unavailable"),
          );
        });
        socket.on("close", () => {
          clearInterval(expiryTimer);
          clearTimeout(sessionExpiryTimer);
          set.delete(subscription);
          if (subscription.generationSubscription)
            deliveries.unsubscribe(subscription.generationSubscription);
          if (set.size === 0) subscriptions.delete(request.params.boardId);
          options.logger?.event("subscription.lifecycle", {
            result: "closed",
            actorId: auth.userId,
            targetId: request.params.boardId,
          });
        });
      },
    );
  });
  return app;
}

async function spatialAccess(
  client: PoolClient,
  auth: Auth,
  boardId: string,
): Promise<{
  teamId?: string;
  code?: "authentication_required" | "board_not_found";
}> {
  const activeSession = await client.query(
    "SELECT 1 FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() FOR UPDATE",
    [auth.sessionDigest],
  );
  if (!activeSession.rowCount) return { code: "authentication_required" };
  const access = await client.query<{ team_id: string }>(
    "SELECT b.team_id FROM boards b JOIN memberships m ON m.team_id=b.team_id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1 FOR SHARE OF m",
    [boardId, auth.userId],
  );
  return access.rows[0]
    ? { teamId: access.rows[0].team_id }
    : { code: "board_not_found" };
}

async function persistSpatialSticky(
  client: PoolClient,
  creating: boolean,
  values: {
    id: string;
    boardId: string;
    text: string;
    x: number;
    y: number;
    color: string;
    version: number;
  },
) {
  if (creating) {
    await client.query(
      "INSERT INTO stickies(id,board_id,text,x,y,color,version) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        values.id,
        values.boardId,
        values.text,
        values.x,
        values.y,
        values.color,
        values.version,
      ],
    );
    return;
  }
  await client.query(
    "UPDATE stickies SET text=$2,x=$3,y=$4,color=$5,version=$6,updated_at=now() WHERE id=$1",
    [values.id, values.text, values.x, values.y, values.color, values.version],
  );
}

const validOperationKind = (creating: boolean, kind: string) =>
  creating ? kind === "create" : kind !== "create";

async function spatialReceipt(
  client: PoolClient,
  operationId: string,
  binding: string,
  operationKind: string,
) {
  const receipt = await client.query<{
    request_digest: Buffer;
    committed_text: string;
    committed_version: string;
    sticky_id: string;
    committed_x: number;
    committed_y: number;
    operation_kind: string;
    committed_color: string;
  }>(
    "SELECT request_digest,committed_text,committed_version,sticky_id,committed_x,committed_y,committed_color,operation_kind FROM operation_receipts WHERE operation_id=$1 FOR UPDATE",
    [operationId],
  );
  const row = receipt.rows[0];
  if (!row) return { state: "none" as const };
  if (
    row.request_digest.toString("hex") !== binding ||
    row.operation_kind !== operationKind
  )
    return { state: "conflict" as const };
  return {
    state: "replay" as const,
    outcome: {
      id: row.sticky_id,
      text: row.committed_text,
      x: Number(row.committed_x),
      y: Number(row.committed_y),
      color: row.committed_color,
      version: Number(row.committed_version),
    },
  };
}

function spatialVersionConflict(
  current:
    | { text: string; x: number; y: number; color: string; version: string }
    | undefined,
  creating: boolean,
  expectedVersion: number,
  id: string,
) {
  const version = current ? Number(current.version) : 0;
  if (
    (creating && current) ||
    (!creating && !current) ||
    version !== expectedVersion
  )
    return current
      ? {
          id,
          text: current.text,
          x: Number(current.x),
          y: Number(current.y),
          color: current.color,
          version,
        }
      : null;
  return undefined;
}

type LegacyMutation = {
  userId: string;
  boardId: string;
  operationId: string;
  text: string;
  expectedVersion: number;
  writerGeneration: bigint | null | undefined;
  writerNonce: string | null | undefined;
  sessionDigest: Buffer;
  beforeCommit: (() => Promise<void>) | undefined;
};

async function lockWriterGeneration(
  client: PoolClient,
  writerGeneration?: bigint | null,
  writerNonce?: string | null,
): Promise<boolean> {
  if (writerGeneration === undefined) return true;
  if (writerGeneration === null) return false;
  await client.query("SELECT pg_advisory_xact_lock_shared($1)", [741922]);
  const epoch = await client.query<{
    generation: string;
    owner_nonce: string | null;
  }>("SELECT generation,owner_nonce FROM writer_epoch WHERE singleton=true");
  return (
    BigInt(epoch.rows[0]!.generation) === writerGeneration &&
    (writerNonce === undefined || writerNonce === epoch.rows[0]!.owner_nonce)
  );
}

async function mutate(
  client: PoolClient,
  reply: FastifyReply,
  mutation: LegacyMutation,
) {
  const {
    userId,
    boardId,
    operationId,
    text,
    expectedVersion,
    writerGeneration,
    writerNonce,
    sessionDigest,
    beforeCommit,
  } = mutation;
  await client.query("BEGIN");
  try {
    if (!(await lockWriterGeneration(client, writerGeneration, writerNonce))) {
      await client.query("ROLLBACK");
      return reply.code(503).send({ code: "writer_ownership_lost" });
    }
    const session = await client.query(
      "SELECT id_digest FROM sessions WHERE id_digest=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND idle_expires_at>now() FOR UPDATE",
      [sessionDigest],
    );
    if (!session.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(401).send({ code: "authentication_required" });
    }
    const access = await client.query<{ team_id: string }>(
      "SELECT b.team_id FROM boards b JOIN memberships m ON m.team_id=b.team_id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1 FOR UPDATE OF m",
      [boardId, userId],
    );
    if (!access.rows[0]) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ code: "board_not_found" });
    }
    const sticky = await client.query<{
      id: string;
      text: string;
      version: string;
    }>("SELECT id,text,version FROM stickies WHERE board_id=$1 FOR UPDATE", [
      boardId,
    ]);
    const stickyId = sticky.rows[0]?.id ?? randomUUID();
    const binding = operationBinding({
      actorId: userId,
      teamId: access.rows[0].team_id,
      boardId,
      stickyId,
      text,
      expectedVersion: String(expectedVersion),
    });
    const receipt = await client.query<{
      request_digest: Buffer;
      committed_text: string;
      committed_version: string;
      sticky_id: string;
    }>(
      "SELECT request_digest,committed_text,committed_version,sticky_id FROM operation_receipts WHERE operation_id=$1 FOR UPDATE",
      [operationId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_digest.toString("hex") !== binding) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "operation_conflict" });
      }
      await client.query("COMMIT");
      return {
        id: receipt.rows[0].sticky_id,
        text: receipt.rows[0].committed_text,
        version: Number(receipt.rows[0].committed_version),
      };
    }
    const current = sticky.rows[0] ? Number(sticky.rows[0].version) : 0;
    if (current !== expectedVersion) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        code: "version_conflict",
        canonical: sticky.rows[0]
          ? {
              id: sticky.rows[0].id,
              text: sticky.rows[0].text,
              version: current,
            }
          : null,
      });
    }
    const version = current + 1;
    if (sticky.rows[0])
      await client.query(
        "UPDATE stickies SET text=$2,version=$3,updated_at=now() WHERE id=$1",
        [stickyId, text, version],
      );
    else
      await client.query(
        "INSERT INTO stickies(id,board_id,text,version) VALUES($1,$2,$3,$4)",
        [stickyId, boardId, text, version],
      );
    await client.query(
      "INSERT INTO operation_receipts(operation_id,actor_id,team_id,board_id,sticky_id,request_digest,committed_version,committed_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        operationId,
        userId,
        access.rows[0].team_id,
        boardId,
        stickyId,
        Buffer.from(binding, "hex"),
        version,
        text,
      ],
    );
    await beforeCommit?.();
    await client.query("COMMIT");
    return { id: stickyId, text, version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
