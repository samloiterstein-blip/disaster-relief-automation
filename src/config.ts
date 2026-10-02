import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Status } from "./types.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  dataDir: resolve(env.DATA_DIR ?? "data"),
  sourcesFile: resolve(env.SOURCES_FILE ?? "config/sources.json"),
  port: Number(env.PORT ?? 8787),
  // Arkansas's Cloudflare rejects agents containing the word "email"; a bare address is fine.
  userAgent: env.USER_AGENT ?? "DisasterDeclarationWatch/0.1",
  httpTimeoutMs: Number(env.HTTP_TIMEOUT_MS ?? 15000),

  /** Only alert for these states (USPS codes). Events with no detectable state always alert. */
  watchStates: new Set(list(env.WATCH_STATES).map((s) => s.toUpperCase())),
  /** "renewed" (monthly re-issues of standing proclamations) is off by default: it's not a new declaration. */
  alertStatuses: new Set(list(env.ALERT_STATUSES || "declared,amended,requested") as Status[]),

  slackWebhookUrl: env.SLACK_WEBHOOK_URL,
  webhookUrls: list(env.WEBHOOK_URLS),

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
    to: list(env.SMS_TO),
    /** "official": SMS only when a government source is involved; "all": any tier; "none": disable. */
    tier: (env.SMS_TIER ?? "official") as "official" | "all" | "none",
    statuses: new Set(list(env.SMS_STATUSES || "declared") as Status[]),
  },

  /** "smtp" (any SMTP server) or "gmail" (Gmail API with an OAuth refresh token from `--gmail-auth`). */
  mailProvider: (env.MAIL_PROVIDER || "smtp") as "smtp" | "gmail",

  gmail: {
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
  },

  smtp: {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },

  digest: {
    to: list(env.DIGEST_TO),
    cc: list(env.DIGEST_CC),
    from: env.DIGEST_FROM || env.SMTP_USER,
    /** Local send time, 24-hour HH:MM in DIGEST_TZ. */
    time: env.DIGEST_TIME || "17:00",
    tz: env.DIGEST_TZ || "America/New_York",
  },
};
