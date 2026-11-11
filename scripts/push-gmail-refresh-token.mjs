import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(join(root, ".env"), "utf8");
const m = env.match(/^GMAIL_REFRESH_TOKEN=(.+)$/m);
if (!m?.[1]?.trim()) {
  console.error("No GMAIL_REFRESH_TOKEN in .env. Run `npm run gmail-refresh` or `node src/index.ts --gmail-auth` first.");
  process.exit(1);
}
const token = m[1].trim().replace(/^["']|["']$/g, "");
const repo =
  spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).stdout.match(/github\.com[:/](.+?)(?:\.git)?\s*$/i)?.[1] ??
  "samloiterstein-blip/disaster-relief-automation";
const r = spawnSync("gh", ["secret", "set", "GMAIL_REFRESH_TOKEN", "--body", token, "-R", repo], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

const refreshedAt = new Date().toISOString();
writeFileSync(join(root, "config/gmail-token-refreshed-at.txt"), `${refreshedAt}\n`);
const variable = spawnSync("gh", ["variable", "set", "GMAIL_TOKEN_REFRESHED_AT", "--body", refreshedAt, "-R", repo], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if ((variable.status ?? 1) !== 0) {
  console.error("Gmail secret was updated, but GMAIL_TOKEN_REFRESHED_AT was not. The 7-day reminder will keep the previous clock until this variable is set.");
  process.exit(variable.status ?? 1);
}
console.log(`Recorded GMAIL_TOKEN_REFRESHED_AT=${refreshedAt}`);

const open = spawnSync(
  "gh",
  ["issue", "list", "-R", repo, "--label", "gmail-refresh", "--state", "open", "--json", "number", "--limit", "20"],
  { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
);
if (open.status === 0 && open.stdout.trim()) {
  for (const issue of JSON.parse(open.stdout)) {
    const closed = spawnSync(
      "gh",
      ["issue", "close", String(issue.number), "-R", repo, "--reason", "completed", "--comment", "Gmail refresh token was renewed. The next reminder follows this new 7-day clock."],
      { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
    );
    if ((closed.status ?? 1) !== 0) console.error(`Could not close reminder issue #${issue.number}.`);
  }
}
