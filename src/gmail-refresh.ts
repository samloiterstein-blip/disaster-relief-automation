import { config } from "./config.ts";
import { gmailAccessToken } from "./mail.ts";
import type { Store } from "./store.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface DigestBody {
  subject: string;
  text: string;
  html: string;
  alertCount: number;
}

export const GMAIL_REFRESH_NEEDED_META = "gmail_refresh_needed_at";
export const GMAIL_REFRESH_NOTICE_HOURS = 48;
const NOTICE_MS = GMAIL_REFRESH_NOTICE_HOURS * 60 * 60 * 1000;

/** Run from the repo root (installs deps if needed, browser sign-in, updates GitHub secret, optional forced digest). */
export const GMAIL_REFRESH_COMMAND = "npm run gmail-refresh";

export function isGmailRefreshError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Gmail token refresh failed|invalid_grant|refresh token expired/i.test(msg);
}

export function markGmailRefreshNeeded(store: Store, at = new Date()): void {
  if (!store.getMeta(GMAIL_REFRESH_NEEDED_META)) store.setMeta(GMAIL_REFRESH_NEEDED_META, at.toISOString());
}

export function clearGmailRefreshNeeded(store: Store): void {
  store.setMeta(GMAIL_REFRESH_NEEDED_META, "");
}

export function gmailRefreshNeededAt(store: Store): Date | null {
  const raw = store.getMeta(GMAIL_REFRESH_NEEDED_META)?.trim();
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function isGmailRefreshNoticeActive(store: Store, now = Date.now()): boolean {
  if (config.mailProvider !== "gmail") return false;
  const at = gmailRefreshNeededAt(store);
  if (!at) return false;
  return now - at.getTime() <= NOTICE_MS;
}

export function gmailRefreshNoticeText(): string {
  return [
    "ACTION REQUIRED — Gmail refresh token expired or was revoked. Daily disaster-watch emails will fail until you renew it.",
    `On a computer with this repo, Node.js, and GitHub CLI (\`gh auth login\`), open a terminal in the project folder and run:`,
    `  ${GMAIL_REFRESH_COMMAND}`,
    "When Google sign-in opens, approve access and wait for “Gmail authorized”. The script updates the GitHub secret and can re-send today’s digest.",
    "If the OAuth app is in Google Cloud “Testing” mode, tokens expire after 7 days — set the app to “In production” to avoid repeat renewals.",
  ].join("\n");
}

export function gmailRefreshNoticeHtml(): string {
  const cmd = escapeHtml(GMAIL_REFRESH_COMMAND);
  return `<div style="margin:0 0 16px;padding:12px 14px;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;color:#7a271a">
<p style="margin:0 0 8px;font-weight:700;font-size:15px">Action required: renew Gmail access</p>
<p style="margin:0 0 8px;font-size:14px">Daily disaster-watch emails will fail until the Gmail refresh token is renewed.</p>
<p style="margin:0 0 8px;font-size:14px">On a machine with this repo, Node.js, and GitHub CLI (<code>gh auth login</code>), run in the project folder:</p>
<p style="margin:0 0 8px;font-size:14px"><code style="background:#fff;padding:2px 6px;border-radius:4px">${cmd}</code></p>
<p style="margin:0;font-size:13px">Complete Google sign-in when prompted. The script updates the GitHub secret and can re-send today’s digest. If your Google OAuth app is in “Testing” mode, set it to “In production” so tokens are not revoked every 7 days.</p>
</div>`;
}

export function withGmailRefreshNotice<T extends DigestBody>(digest: T, store: Store): T {
  if (!isGmailRefreshNoticeActive(store)) return digest;
  const notice = gmailRefreshNoticeText();
  return {
    ...digest,
    subject: `[Action required] ${digest.subject}`,
    text: `${notice}\n\n---\n\n${digest.text}`,
    html: digest.html.replace(
      /<body style="[^"]*">/,
      (open) => `${open}${gmailRefreshNoticeHtml()}`,
    ),
  };
}

/** Probes Gmail when configured; records or clears the refresh-needed flag in the store. */
export async function probeGmailAuth(store: Store): Promise<"ok" | "needs_refresh" | "skipped"> {
  if (config.mailProvider !== "gmail") return "skipped";
  try {
    await gmailAccessToken();
    clearGmailRefreshNeeded(store);
    return "ok";
  } catch (err) {
    if (isGmailRefreshError(err)) markGmailRefreshNeeded(store);
    return "needs_refresh";
  }
}
