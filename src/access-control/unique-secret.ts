import { createHash } from "node:crypto";

export class SecretCollisionError extends Error {
  constructor() {
    super("secret_collision_budget_exhausted");
    this.name = "SecretCollisionError";
  }
}

export async function generateUniqueSecret(options: {
  attempts: number;
  generate: () => string;
  digestExists: (digest: Buffer) => Promise<boolean>;
}): Promise<{ raw: string; digest: Buffer }> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1)
    throw new RangeError("attempts must be a positive integer");
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const raw = options.generate();
    const digest = createHash("sha256").update(raw).digest();
    if (!(await options.digestExists(digest))) return { raw, digest };
  }
  throw new SecretCollisionError();
}
