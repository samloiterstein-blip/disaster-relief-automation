/**
 * Pure Gmail-reminder timing and copy. No imports: the scheduled workflow
 * loads this file without installing dependencies.
 */

/** Google expires refresh tokens after 7 days while the OAuth app stays in Testing. */
export const GMAIL_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Open the reminder this long before expiry so a morning check lands on the 7th day, before that evening's digest. */
export const GMAIL_REFRESH_REMINDER_LEAD_MS = 12 * 60 * 60 * 1000;
export const GMAIL_REFRESH_REPO = "samloiterstein-blip/disaster-relief-automation";

export function gmailRefreshReminderDueAt(refreshedAt: Date): Date {
  return new Date(refreshedAt.getTime() + GMAIL_REFRESH_TOKEN_TTL_MS - GMAIL_REFRESH_REMINDER_LEAD_MS);
}

export function isGmailRefreshReminderDue(refreshedAt: Date, now = new Date()): boolean {
  return now.getTime() >= gmailRefreshReminderDueAt(refreshedAt).getTime();
}

/** One block the owner can paste into Cursor. Kept free of secrets. */
export function gmailRefreshCursorPrompt(refreshedAt: Date): string {
  const expires = new Date(refreshedAt.getTime() + GMAIL_REFRESH_TOKEN_TTL_MS);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expires);
  return [
    `Renew the Gmail refresh token for https://github.com/${GMAIL_REFRESH_REPO} before it expires (${when}).`,
    "There is a file in the repo on how to do it.",
    "Run `npm run gmail-refresh`: complete the Google sign-in, update the GitHub GMAIL_REFRESH_TOKEN secret, and re-run the daily digest.",
    "Do not print secrets.",
  ].join(" ");
}

export function gmailRefreshReminderIssueBody(refreshedAt: Date): string {
  const expires = new Date(refreshedAt.getTime() + GMAIL_REFRESH_TOKEN_TTL_MS);
  const stamp = refreshedAt.toISOString();
  return [
    `The Gmail refresh token used by the daily disaster digest needs to be renewed. It was last refreshed at ${stamp} and Google revokes Testing-mode tokens after 7 days (about ${expires.toISOString()}).`,
    "",
    "Paste this into Cursor:",
    "",
    "```",
    gmailRefreshCursorPrompt(refreshedAt),
    "```",
    "",
    `Refreshed at: ${stamp}`,
  ].join("\n");
}
