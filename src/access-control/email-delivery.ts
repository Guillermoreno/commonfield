import nodemailer from "nodemailer";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";

export class EmailConfigurationError extends Error {
  constructor() {
    super("email_configuration_invalid");
  }
}
export type EmailConfig =
  | { transport: "local_capture" }
  | {
      transport: "smtp";
      host: string;
      port: number;
      tls: "implicit" | "starttls";
      username: string;
      password: string;
      from: string;
      ca?: string;
    };
export type InvitationMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
};
export async function loadEmailConfig(
  env: Record<string, string | undefined>,
): Promise<EmailConfig> {
  if (!env.EMAIL_MODE || env.EMAIL_MODE === "capture")
    return { transport: "local_capture" };
  try {
    if (env.EMAIL_MODE !== "smtp") throw new EmailConfigurationError();
    if (env.SMTP_USERNAME_FILE) {
      if (env.SMTP_USERNAME) throw new EmailConfigurationError();
      env = {
        ...env,
        SMTP_USERNAME: (await readFile(env.SMTP_USERNAME_FILE, "utf8")).replace(
          /\r?\n$/,
          "",
        ),
      };
    }
    const required = [
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_TLS",
      "SMTP_USERNAME",
      "SMTP_PASSWORD_FILE",
      "SMTP_FROM",
    ];
    if (required.some((key) => !env[key]?.trim() || /[\r\n\0]/.test(env[key]!)))
      throw new EmailConfigurationError();
    const port = Number(env.SMTP_PORT);
    if (
      !/^\d+$/.test(env.SMTP_PORT!) ||
      port < 1 ||
      port > 65535 ||
      !["implicit", "starttls"].includes(env.SMTP_TLS!) ||
      !/^[a-zA-Z0-9.-]+$/.test(env.SMTP_HOST!) ||
      !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(
        env.SMTP_FROM!,
      )
    )
      throw new EmailConfigurationError();
    const password = (await readFile(env.SMTP_PASSWORD_FILE!, "utf8")).replace(
      /\r?\n$/,
      "",
    );
    if (!password || /[\r\n\0]/.test(password))
      throw new EmailConfigurationError();
    const ca = env.SMTP_CA_FILE
      ? await readFile(env.SMTP_CA_FILE, "utf8")
      : undefined;
    if (env.SMTP_CA_FILE) new X509Certificate(ca!);
    return {
      transport: "smtp",
      host: env.SMTP_HOST!,
      port,
      tls: env.SMTP_TLS as "implicit" | "starttls",
      username: env.SMTP_USERNAME!,
      password,
      from: env.SMTP_FROM!,
      ...(ca ? { ca } : {}),
    };
  } catch {
    throw new EmailConfigurationError();
  }
}

/** Never expose provider errors/responses: they can contain recipients and secrets.
 * Only an explicit negative SMTP reply or a known pre-DATA stage is retry-safe.
 * Unknown network failures, including ECONNECTION, remain uncertain. */
function classify(error: unknown): "failed" | "uncertain" {
  const e = error as {
    responseCode?: number;
    command?: string;
    code?: string;
    originalCode?: string;
  };
  if (e.responseCode && e.responseCode >= 400 && e.responseCode <= 599)
    return "failed";
  const certificateFailures = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]);
  if (
    certificateFailures.has(e.originalCode ?? "") ||
    e.code === "ETLS" ||
    e.code === "EAUTH" ||
    e.code === "EDNS" ||
    /^(EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO)$/.test(
      e.command ?? "",
    )
  )
    return "failed";
  return "uncertain";
}
export function createInvitationDelivery(
  config: EmailConfig,
  options: { timeoutMs?: number } = {},
) {
  const smtp = config.transport === "smtp";
  const timeout = options.timeoutMs ?? 15_000;
  const transport = nodemailer.createTransport({
    host: smtp ? config.host : "mailpit",
    port: smtp ? config.port : 1025,
    secure: smtp && config.tls === "implicit",
    requireTLS: smtp && config.tls === "starttls",
    ignoreTLS: !smtp,
    opportunisticTLS: false,
    forceAuth: smtp,
    ...(smtp ? { auth: { user: config.username, pass: config.password } } : {}),
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(smtp
        ? { servername: config.host, ...(config.ca ? { ca: config.ca } : {}) }
        : {}),
    },
    logger: false,
    debug: false,
    transactionLog: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const from = smtp ? config.from : "no-reply@commonfield.invalid";
  return {
    transport: config.transport,
    async send(
      message: InvitationMessage,
    ): Promise<"sent" | "failed" | "uncertain"> {
      if (
        !/^[a-zA-Z0-9-]+$/.test(message.messageId) ||
        /[\r\n\0]/.test(message.subject) ||
        !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(message.to)
      )
        return "failed";
      try {
        const result = await transport.sendMail({
          from: { name: "Commonfield", address: from },
          to: message.to,
          envelope: { from, to: [message.to] },
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: `<${message.messageId}@${from.split("@")[1]}>`,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return result.accepted?.length === 1 ? "sent" : "uncertain";
      } catch (error) {
        return classify(error);
      }
    },
  };
}
