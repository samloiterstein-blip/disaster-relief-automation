#!/usr/bin/env node
/**
 * Foolproof Gmail refresh for daily digest email (GitHub Actions + local .env).
 * Usage: npm run gmail-refresh
 * Flags: --no-dispatch  skip re-running the daily workflow after updating the secret
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipDispatch = process.argv.includes("--no-dispatch");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
}

function requireTool(name, versionArgs = ["--version"]) {
  const r = runCapture(name, versionArgs);
  if (r.status !== 0) {
    console.error(`Missing ${name}. Install it and ensure it is on your PATH, then run this script again.`);
    process.exit(1);
  }
}

function envHasGmailClient() {
  if (!existsSync(join(root, ".env"))) return false;
  const env = readFileSync(join(root, ".env"), "utf8");
  return /^GMAIL_CLIENT_ID=\S+/m.test(env) && /^GMAIL_CLIENT_SECRET=\S+/m.test(env);
}

function freeOAuthPort() {
  if (process.platform === "win32") {
    runCapture("powershell", [
      "-NoProfile",
      "-Command",
      "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }",
    ]);
  } else {
    runCapture("sh", ["-c", "lsof -ti:8765 | xargs -r kill -9 2>/dev/null || true"]);
  }
}

function gitHubRepo() {
  const r = runCapture("git", ["remote", "get-url", "origin"]);
  if (r.status !== 0) return "samloiterstein-blip/disaster-relief-automation";
  const m = r.stdout.match(/github\.com[:/](.+?)(?:\.git)?\s*$/i);
  return m?.[1] ?? "samloiterstein-blip/disaster-relief-automation";
}

console.log("Gmail refresh for Disaster Declaration Watch\n");

requireTool("node", ["--version"]);
requireTool("gh", ["--version"]);

if (!envHasGmailClient()) {
  console.log("GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not found in .env.");
  if (existsSync(join(root, ".vercel", "project.json"))) {
    console.log("Pulling development env from linked Vercel project (usccfdisasterrelief)…");
    requireTool("vercel", ["--version"]);
    run("vercel", ["env", "pull", ".env.vercel.dev", "--environment=development", "--yes"]);
    console.log(
      "Merge GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and related keys from .env.vercel.dev into .env, then re-run:",
      "npm run gmail-refresh",
    );
    process.exit(1);
  }
  console.error("Copy .env.example to .env and set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (same as GitHub Actions secrets).");
  process.exit(1);
}

freeOAuthPort();
console.log("\n1/3 — Browser sign-in (complete Google consent; wait for “Gmail authorized”)…\n");
run("node", ["src/index.ts", "--gmail-auth"]);

console.log("\n2/3 — Updating GitHub secret GMAIL_REFRESH_TOKEN…\n");
run("node", ["scripts/push-gmail-refresh-token.mjs"]);

if (!skipDispatch) {
  const repo = gitHubRepo();
  console.log(`\n3/3 — Re-sending today’s digest via GitHub Actions (${repo})…\n`);
  run("gh", ["workflow", "run", "daily.yml", "-R", repo, "-f", "force=true"]);
  console.log("\nDone. Watch the run: gh run list --workflow=daily.yml -R", repo);
} else {
  console.log("\n3/3 — Skipped workflow dispatch (--no-dispatch).");
}

console.log("\nGmail refresh complete.");
