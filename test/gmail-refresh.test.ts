import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

process.env.MAIL_PROVIDER = "gmail";
const {
  GMAIL_REFRESH_COMMAND,
  GMAIL_REFRESH_NEEDED_META,
  GMAIL_REFRESH_NOTICE_HOURS,
  isGmailRefreshNoticeActive,
  withGmailRefreshNotice,
} = await import("../src/gmail-refresh.ts");

test("refresh notice is shown for 48 hours after the flag is set", () => {
  const store = new Store(":memory:");
  const at = new Date("2026-10-29T12:00:00Z");
  store.setMeta(GMAIL_REFRESH_NEEDED_META, at.toISOString());
  assert.equal(isGmailRefreshNoticeActive(store, at.getTime() + 47 * 3600_000), true);
  assert.equal(isGmailRefreshNoticeActive(store, at.getTime() + (GMAIL_REFRESH_NOTICE_HOURS * 3600_000 + 1)), false);
});

test("reminder is due 12 hours before the 7-day expiry", async () => {
  const { gmailRefreshReminderDueAt, isGmailRefreshReminderDue, gmailRefreshCursorPrompt, gmailRefreshReminderIssueBody } = await import("../src/gmail-refresh.ts");
  const refreshed = new Date("2026-11-11T01:46:12Z");
  const due = gmailRefreshReminderDueAt(refreshed);
  assert.equal(due.toISOString(), "2026-11-17T13:46:12.000Z");
  assert.equal(isGmailRefreshReminderDue(refreshed, new Date(due.getTime() - 1)), false);
  assert.equal(isGmailRefreshReminderDue(refreshed, due), true);
  const prompt = gmailRefreshCursorPrompt(refreshed);
  assert.match(prompt, /npm run gmail-refresh/);
  assert.match(prompt, /https:\/\/github.com\/samloiterstein-blip\/disaster-relief-automation/);
  assert.match(prompt, /Do not print secrets/);
  const body = gmailRefreshReminderIssueBody(refreshed);
  assert.match(body, /Paste this into Cursor:/);
  assert.match(body, /Refreshed at: 2026-11-11T01:46:12.000Z/);
  assert.match(body, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("refresh notice prepends instructions referencing the refresh script", () => {
  const store = new Store(":memory:");
  store.setMeta(GMAIL_REFRESH_NEEDED_META, new Date().toISOString());
  const base = { subject: "Disaster watch Thu: no new declarations", text: "NO.", html: '<body style="x"><p>NO.</p></body>', alertCount: 0 };
  const out = withGmailRefreshNotice(base, store);
  assert.match(out.subject, /^\[Action required\]/);
  assert.match(out.text, new RegExp(GMAIL_REFRESH_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out.html, /Action required: renew Gmail access/);
});
