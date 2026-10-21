import { writeFileSync } from "node:fs";

const required = [
  "USER_AGENT",
  "STATUS_PORTAL_URL",
  "STATUS_INGEST_TOKEN",
  "DIGEST_TO",
];

const optional = [
  "MAIL_PROVIDER",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "DATABASE_URL",
  "DIGEST_CC",
  "DIGEST_FROM",
  "SLACK_WEBHOOK_URL",
  "WEBHOOK_URLS",
  "WATCH_STATES",
  "ALERT_STATUSES",
];

const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing GitHub secrets: ${missing.join(", ")}`);
  process.exit(1);
}

const provider = process.env.MAIL_PROVIDER?.trim() || "gmail";
if (provider === "gmail") {
  for (const key of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) {
    if (!process.env[key]?.trim()) {
      console.error(`MAIL_PROVIDER=gmail requires secret ${key}.`);
      process.exit(1);
    }
  }
} else if (provider === "smtp") {
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
    if (!process.env[key]?.trim()) {
      console.error(`MAIL_PROVIDER=smtp requires secret ${key}.`);
      process.exit(1);
    }
  }
} else {
  console.error("MAIL_PROVIDER must be gmail or smtp.");
  process.exit(1);
}

const lines = [
  "DATA_DIR=./data",
  `MAIL_PROVIDER=${provider}`,
  `DIGEST_TIME=${process.env.DIGEST_TIME?.trim() || "17:00"}`,
  `DIGEST_TZ=${process.env.DIGEST_TZ?.trim() || "America/New_York"}`,
];

for (const key of [...required, ...optional]) {
  const value = process.env[key];
  if (value != null && value !== "") lines.push(`${key}=${value}`);
}

writeFileSync(".env", `${lines.join("\n")}\n`, { mode: 0o600 });
console.log("Wrote .env for the daily GitHub Actions job.");
