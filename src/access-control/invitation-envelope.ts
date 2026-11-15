import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type InvitationEnvelopeContext = {
  invitationId: string;
  teamId: string;
  email: string;
  role: string;
  expiresAt: string;
  canonicalOrigin: string;
};

const keyBytes = (key: Buffer | string) =>
  Buffer.isBuffer(key)
    ? createHash("sha256").update(key).digest()
    : createHash("sha256").update(key, "utf8").digest();

const authenticatedData = (context: InvitationEnvelopeContext) =>
  Buffer.from(JSON.stringify({ version: 1, ...context }), "utf8");

export function sealInvitationSecret(
  secret: string,
  context: InvitationEnvelopeContext,
  key: Buffer | string,
): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), nonce);
  cipher.setAAD(authenticatedData(context));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function openInvitationSecret(
  envelope: Buffer,
  context: InvitationEnvelopeContext,
  key: Buffer | string,
): string {
  if (envelope.length < 29) throw new Error("invitation_envelope_invalid");
  const nonce = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), nonce);
  decipher.setAAD(authenticatedData(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(envelope.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
