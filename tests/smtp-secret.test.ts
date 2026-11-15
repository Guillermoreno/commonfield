import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
it("reports a stable email configuration reason without raw exception values", () => {
  const dir = mkdtempSync(join(tmpdir(), "commonfield-diagnostic-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {diagnostic} from './docker/diagnostic.mjs';class EmailConfigurationError extends Error{};await diagnostic('startup',new EmailConfigurationError('provider-secret-value'),'not_started',process.argv[1]);`,
        dir,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("email_configuration_invalid");
    const report = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(JSON.parse(report).reason).toBe("email_configuration_invalid");
    expect(report).not.toContain("provider-secret-value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("provisions only explicit SMTP secret files, refuses overwrite, emits sanitized diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "commonfield-secret-"));
  try {
    const run = (kind: string, input: string) =>
      spawnSync(process.execPath, ["docker/smtp-secret.mjs", kind], {
        env: { ...process.env, COMMONFIELD_SECRET_DIR: dir },
        input,
        encoding: "utf8",
      });
    expect(run("smtp_password", "private-value\n").status).toBe(0);
    expect(readFileSync(join(dir, "smtp_password"), "utf8")).toBe(
      "private-value",
    );
    const failed = run("smtp_password", "second-private");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("sanitized diagnostic:");
    const report = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    const data = readFileSync(join(dir, report), "utf8");
    expect(data).toContain("smtp_secret_setup");
    expect(data).not.toMatch(/private-value|second-private/);
    expect(run("invitation_key", "do-not-change").status).toBe(1);
    expect(readdirSync(dir)).not.toContain("invitation_key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
