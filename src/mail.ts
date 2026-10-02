import nodemailer from "nodemailer";
import { config } from "./config.ts";

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export function mailConfigured(): boolean {
  if (config.mailProvider === "gmail") return !!(config.gmail.clientId && config.gmail.clientSecret && config.gmail.refreshToken);
  return !!(config.smtp.host && config.digest.from);
}

export async function gmailAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.gmail.clientId ?? "",
      client_secret: config.gmail.clientSecret ?? "",
      refresh_token: config.gmail.refreshToken ?? "",
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    const reason = body.error === "invalid_grant" ? "the refresh token expired or was revoked; run `node src/index.ts --gmail-auth`" : `${body.error}: ${body.error_description}`;
    throw new Error(`Gmail token refresh failed (${res.status}): ${reason}`);
  }
  return body.access_token;
}

/** Sends through the Gmail API. Gmail fills in From with the authorized account when DIGEST_FROM is unset. */
async function sendWithGmail(to: string[], msg: EmailMessage, cc: string[]): Promise<void> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const { message } = await composer.sendMail({
    from: config.digest.from,
    to: to.join(", "),
    cc: cc.length ? cc.join(", ") : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${await gmailAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: (message as Buffer).toString("base64url") }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

export async function sendEmail(to: string[], msg: EmailMessage, cc: string[] = []): Promise<void> {
  if (config.mailProvider === "gmail") return sendWithGmail(to, msg, cc);
  const { host, port, user, pass } = config.smtp;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  await transport.sendMail({
    from: config.digest.from,
    to: to.join(", "),
    cc: cc.length ? cc.join(", ") : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
