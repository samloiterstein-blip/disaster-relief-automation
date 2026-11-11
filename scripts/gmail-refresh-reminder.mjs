/**
 * Opens one GitHub issue when the Gmail refresh token is inside its last 12 hours.
 * The issue body contains a Cursor prompt. GitHub notifies the assignee; this does
 * not use the Gmail token, which is what is about to expire.
 *
 * Clock: GMAIL_TOKEN_REFRESHED_AT (Actions variable), else config/gmail-token-refreshed-at.txt.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GMAIL_REFRESH_REPO,
  gmailRefreshReminderDueAt,
  gmailRefreshReminderIssueBody,
  isGmailRefreshReminderDue,
} from "../src/gmail-reminder.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.GITHUB_REPOSITORY || GMAIL_REFRESH_REPO;
const assignee = process.env.GMAIL_REFRESH_ASSIGNEE || "samloiterstein-blip";

function gh(args, { allowFail = false } = {}) {
  const r = spawnSync("gh", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  return r;
}

function refreshedAt() {
  const raw = (process.env.GMAIL_TOKEN_REFRESHED_AT || "").trim()
    || readFileSync(join(root, "config/gmail-token-refreshed-at.txt"), "utf8").trim().split(/\r?\n/)[0];
  const at = new Date(raw);
  if (!raw || Number.isNaN(at.getTime())) {
    console.error("Set GMAIL_TOKEN_REFRESHED_AT or config/gmail-token-refreshed-at.txt to an ISO timestamp.");
    process.exit(1);
  }
  return at;
}

const at = refreshedAt();
const due = gmailRefreshReminderDueAt(at);
if (!isGmailRefreshReminderDue(at)) {
  console.log(`Gmail reminder not due until ${due.toISOString()} (refreshed ${at.toISOString()}).`);
  process.exit(0);
}

const marker = `Refreshed at: ${at.toISOString()}`;
const listed = gh(["issue", "list", "-R", repo, "--label", "gmail-refresh", "--state", "open", "--json", "number,body", "--limit", "20"]);
const open = JSON.parse(listed.stdout || "[]");
if (open.some((issue) => (issue.body || "").includes(marker))) {
  console.log(`Reminder already open for ${at.toISOString()}.`);
  process.exit(0);
}

const label = gh(["label", "create", "gmail-refresh", "-R", repo, "--color", "B60205", "--description", "Gmail OAuth refresh token needs renewal", "--force"], { allowFail: true });
if (label.status !== 0 && !/already exists/i.test(`${label.stderr}\n${label.stdout}`)) {
  console.error(label.stderr || label.stdout);
  process.exit(label.status ?? 1);
}

const bodyFile = join(mkdtempSync(join(tmpdir(), "gmail-refresh-")), "issue.md");
writeFileSync(bodyFile, `${gmailRefreshReminderIssueBody(at)}\n`);
const title = "Renew the Gmail refresh token before the daily digest expires";
const created = gh(["issue", "create", "-R", repo, "--title", title, "--body-file", bodyFile, "--label", "gmail-refresh", "--assignee", assignee], { allowFail: true });
if (created.status !== 0) {
  console.error(created.stderr || created.stdout);
  console.error("Retrying without an assignee.");
  gh(["issue", "create", "-R", repo, "--title", title, "--body-file", bodyFile, "--label", "gmail-refresh"]);
}
console.log(`Opened Gmail refresh reminder for token refreshed at ${at.toISOString()}.`);
