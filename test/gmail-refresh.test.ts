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

test("refresh notice prepends instructions referencing the refresh script", () => {
  const store = new Store(":memory:");
  store.setMeta(GMAIL_REFRESH_NEEDED_META, new Date().toISOString());
  const base = { subject: "Disaster watch Thu: no new declarations", text: "NO.", html: '<body style="x"><p>NO.</p></body>', alertCount: 0 };
  const out = withGmailRefreshNotice(base, store);
  assert.match(out.subject, /^\[Action required\]/);
  assert.match(out.text, new RegExp(GMAIL_REFRESH_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out.html, /Action required: renew Gmail access/);
});
