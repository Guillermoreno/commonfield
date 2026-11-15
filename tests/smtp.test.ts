import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadEmailConfig,
  createInvitationDelivery,
} from "../src/access-control/email-delivery.js";

const dir = mkdtempSync(join(tmpdir(), "commonfield-smtp-"));
const password = "fixture-private-password";
const env = {
  EMAIL_MODE: "smtp",
  SMTP_HOST: "localhost",
  SMTP_PORT: "587",
  SMTP_TLS: "starttls",
  SMTP_USERNAME: "fixture",
  SMTP_PASSWORD_FILE: join(dir, "password"),
  SMTP_FROM: "invites@example.test",
  SMTP_CA_FILE: join(dir, "cert.pem"),
};
beforeAll(() => {
  writeFileSync(env.SMTP_PASSWORD_FILE, password);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const message = {
  to: "recipient@example.test",
  subject: "Invitation",
  text: "Accept https://example.test/invitations/accept#token=private-link",
  html: '<a href="https://example.test/invitations/accept#token=private-link">Accept</a>',
  messageId: "attempt-123",
};
async function fixture(options: SMTPServerOptions = {}) {
  const received: string[] = [];
  const server = new SMTPServer({
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
    logger: false,
    onAuth(auth, _session, cb) {
      cb(
        auth.username === "fixture" && auth.password === password
          ? null
          : new Error("private-auth-response"),
        { user: "fixture" },
      );
    },
    onData(stream, _session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => {
        received.push(data);
        cb();
      });
    },
    ...options,
  });
  server.on("error", () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as { port: number }).port;
  return {
    received,
    port,
    disconnect: () => {
      for (const connection of server.connections) connection.close();
    },
    close: () => new Promise<void>((r) => server.close(r)),
  };
}
describe("email configuration", () => {
  it("rejects an explicitly supplied empty CA file", async () => {
    writeFileSync(join(dir, "empty-ca.pem"), "");
    await expect(
      loadEmailConfig({ ...env, SMTP_CA_FILE: join(dir, "empty-ca.pem") }),
    ).rejects.toThrow("email_configuration_invalid");
  });
  it("defaults to capture and rejects unknown mode", async () => {
    expect((await loadEmailConfig({})).transport).toBe("local_capture");
    await expect(loadEmailConfig({ EMAIL_MODE: "typo" })).rejects.toThrow(
      "email_configuration_invalid",
    );
  });
  it("reads SMTP username from a private file when supplied", async () => {
    writeFileSync(join(dir, "username"), "fixture\n");
    const config = await loadEmailConfig({
      ...env,
      SMTP_USERNAME: undefined,
      SMTP_USERNAME_FILE: join(dir, "username"),
    });
    expect(config.transport === "smtp" && config.username).toBe("fixture");
  });
  it.each([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_TLS",
    "SMTP_USERNAME",
    "SMTP_PASSWORD_FILE",
    "SMTP_FROM",
  ])("fails closed without %s", async (key) => {
    const bad = { ...env };
    delete bad[key as keyof typeof bad];
    await expect(loadEmailConfig(bad)).rejects.toThrow(
      "email_configuration_invalid",
    );
  });
  it.each([
    { SMTP_TLS: "plain" },
    { SMTP_PORT: "0" },
    { SMTP_PORT: "587junk" },
    { SMTP_FROM: "x\r\nBcc:bad" },
    { SMTP_PASSWORD_FILE: "/missing" },
    { SMTP_CA_FILE: "/missing" },
  ])("rejects unsafe configuration %j", async (bad) => {
    await expect(loadEmailConfig({ ...env, ...bad })).rejects.toThrow(
      "email_configuration_invalid",
    );
  });
});
describe("real SMTP transport", () => {
  async function send(
    options: SMTPServerOptions,
    overrides: Record<string, string> = {},
  ) {
    const f = await fixture(options);
    try {
      const config = await loadEmailConfig({
        ...env,
        SMTP_PORT: String(f.port),
        ...overrides,
      });
      const delivery = createInvitationDelivery(config, { timeoutMs: 1500 });
      return { outcome: await delivery.send(message), received: f.received };
    } finally {
      await f.close();
    }
  }
  it.each([false, true])(
    "authenticates over required TLS (implicit=%s), sends MIME alternatives and stable identity",
    async (secure) => {
      const result = await send(
        { secure },
        { SMTP_TLS: secure ? "implicit" : "starttls" },
      );
      expect(result.outcome).toBe("sent");
      expect(result.received).toHaveLength(1);
      expect(result.received[0]).toContain("multipart/alternative");
      expect(result.received[0]).toContain("text/plain");
      expect(result.received[0]).toContain("text/html");
      expect(result.received[0]).toContain(
        "Message-ID: <attempt-123@example.test>",
      );
      expect(result.received[0]).toContain("private-link");
    },
  );
  it.each([false, true])(
    "refuses trusted TLS servers without AUTH before DATA (implicit=%s)",
    async (secure) => {
      const result = await send(
        { secure, disabledCommands: ["AUTH"], authOptional: true },
        { SMTP_TLS: secure ? "implicit" : "starttls" },
      );
      expect.soft(result.outcome).toBe("failed");
      expect(result.received).toHaveLength(0);
    },
  );
  it("rejects untrusted certificates without leaking secrets or links", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    try {
      const result = await send({}, { SMTP_CA_FILE: "" });
      expect(result.outcome).toBe("failed");
      expect(result.received).toHaveLength(0);
      expect(
        JSON.stringify([...log.mock.calls, ...error.mock.calls]),
      ).not.toMatch(/private|recipient|token=/);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
  it("refuses STARTTLS downgrade before authentication or content", async () => {
    const result = await send({ disabledCommands: ["STARTTLS"] });
    expect(result.outcome).toBe("failed");
    expect(result.received).toHaveLength(0);
  });
  it("marks deterministic authentication rejection failed", async () => {
    expect(
      (
        await send({
          onAuth(_a, _s, cb) {
            cb(new Error("private-provider-response"));
          },
        })
      ).outcome,
    ).toBe("failed");
  });
  it("marks explicit RCPT rejection failed", async () => {
    expect(
      (
        await send({
          onRcptTo(_a, _s, cb) {
            cb(
              Object.assign(new Error("private-provider-response"), {
                responseCode: 550,
              }),
            );
          },
        })
      ).outcome,
    ).toBe("failed");
  });
  it("marks explicit final DATA rejection failed", async () => {
    expect(
      (
        await send({
          onData(stream, _s, cb) {
            stream.resume();
            stream.on("end", () =>
              cb(
                Object.assign(new Error("private-provider-response"), {
                  responseCode: 554,
                }),
              ),
            );
          },
        })
      ).outcome,
    ).toBe("failed");
  });
  it("marks disconnect after complete DATA uncertain", async () => {
    const f = await fixture({
      onData(stream) {
        stream.resume();
        stream.on("end", () => f.disconnect());
      },
    });
    try {
      const delivery = createInvitationDelivery(
        await loadEmailConfig({ ...env, SMTP_PORT: String(f.port) }),
        { timeoutMs: 1500 },
      );
      expect(await delivery.send(message)).toBe("uncertain");
    } finally {
      await f.close();
    }
  });
  it("marks lost DATA acknowledgment uncertain, not retryable failure", async () => {
    expect(
      (
        await send({
          onData(stream) {
            stream.resume();
            stream.on("end", () => {
              /* no acknowledgement, client times out */
            });
          },
        })
      ).outcome,
    ).toBe("uncertain");
  });
});
