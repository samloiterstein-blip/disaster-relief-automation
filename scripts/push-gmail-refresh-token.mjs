import { readFileSync } from "node:fs";
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
process.exit(r.status ?? 1);