import { createConnection } from "node:net";

export type LocalInvitationMessage = {
  to: string;
  subject: string;
  text: string;
};

const safeHeader = (value: string) => {
  if (/[\r\n]/.test(value)) throw new Error("smtp_header_invalid");
  return value;
};

export async function deliverToLocalCapture(
  message: LocalInvitationMessage,
  options: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<"sent" | "uncertain"> {
  const host = options.host ?? "mailpit";
  const port = options.port ?? 1025;
  if (host !== "mailpit" || port !== 1025)
    throw new Error("smtp_capture_target_refused");
  const body = [
    "From: Commonfield <no-reply@commonfield.invalid>",
    `To: ${safeHeader(message.to)}`,
    `Subject: ${safeHeader(message.subject)}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.text.replaceAll("\r\n", "\n").replaceAll("\n.", "\n.."),
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const commands = [
      "EHLO commonfield.invalid\r\n",
      "MAIL FROM:<no-reply@commonfield.invalid>\r\n",
      `RCPT TO:<${safeHeader(message.to)}>\r\n`,
      "DATA\r\n",
      `${body}\r\n.\r\n`,
      "QUIT\r\n",
    ];
    let step = -1;
    let accepted = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      if (accepted) resolve("uncertain");
      else reject(new Error("smtp_capture_timeout"));
    }, options.timeoutMs ?? 3000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const lines = chunk.toString().trimEnd().split("\r\n");
      const final = lines.at(-1) ?? "";
      if (!/^2\d\d /.test(final) && !/^3\d\d /.test(final)) return;
      step += 1;
      if (step === 5) accepted = true;
      const command = commands[step];
      if (command) socket.write(command);
      else {
        clearTimeout(timeout);
        socket.end();
        resolve("sent");
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      if (accepted) resolve("uncertain");
      else reject(error);
    });
  });
}
