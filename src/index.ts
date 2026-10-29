import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { buildDigestAsync, digestConfigured, localClock, parseTime, sendDigest, startDigestSchedule } from "./digest.ts";
import { isGmailRefreshError, markGmailRefreshNeeded } from "./gmail-refresh.ts";
import { networkUp } from "./http.ts";
import { authorizeGmail } from "./gmail-auth.ts";
import { mailConfigured, sendEmail } from "./mail.ts";
import { notify } from "./notify.ts";
import { runSmokeTest } from "./smoke.ts";
import { Scheduler } from "./scheduler.ts";
import { startServer } from "./server.ts";
import { loadSources } from "./sources/index.ts";
import { applyDashboardRecipients } from "./recipients.ts";
import { reportWatchRun } from "./status-portal.ts";
import { Store } from "./store.ts";
import type { Alert } from "./types.ts";

const args = new Set(process.argv.slice(2));
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (args.has("--gmail-auth")) {
  const email = await authorizeGmail();
  console.log(`Gmail authorized for ${email}. Refresh token saved to .env.`);
  process.exit(0);
}

if (args.has("--smoke-test")) {
  // Replays the busiest FEMA day on record and polls every connection live, then reports state by state.
  const to = option("to")?.split(",").map((s) => s.trim()).filter(Boolean) ?? config.digest.to;
  if (args.has("--send") && (!mailConfigured() || !to.length)) throw new Error("Configure email (MAIL_PROVIDER=gmail with GMAIL_* settings, or SMTP_*) and pass --to= or set DIGEST_TO to send the smoke test.");
  const report = await runSmokeTest({ date: option("date") });
  const file = join(config.dataDir, "smoke-test.html");
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, report.html);
  console.log(`Subject: ${report.subject}\n\n${report.text}\n\nHTML version: ${file}`);
  if (args.has("--send")) {
    await sendEmail(to, report);
    console.log(`Sent to ${to.join(", ")}`);
  }
  process.exit(0);
}

if (args.has("--test-alert")) {
  const now = new Date().toISOString();
  const sample: Alert = {
    type: "new",
    latencySeconds: 12,
    event: {
      id: 0, state: "TX", level: "state", kind: "state_emergency", status: "declared",
      title: "TEST: Governor issues disaster declaration for 12 counties", tokens: [], ref: null,
      official: true, firstSeen: now, lastSeen: now, sourceCount: 1, firstUrl: null, firstSource: "Test",
    },
    detection: {
      key: "test", sourceId: "test", sourceName: "Disaster Declaration Watch (test message)", tier: "official",
      level: "state", kind: "state_emergency", status: "declared", state: "TX",
      title: "TEST: Governor issues disaster declaration for 12 counties", detectedAt: now,
    },
  };
  await notify(sample);
  process.exit(0);
}

const store = new Store(join(config.dataDir, "watch.db"));
const sources = loadSources(config.sourcesFile, store);
const scheduler = new Scheduler(store, sources, notify);

if (args.has("--daily")) {
  // For cron/launchd, which can call it often: once a day at or after DIGEST_TIME, poll every source once,
  // then email the digest covering everything since the previous send. --force skips the time check.
  const send = !args.has("--no-send");
  await applyDashboardRecipients();
  if (send && !digestConfigured()) throw new Error("Configure email (MAIL_PROVIDER=gmail with GMAIL_* settings, or SMTP_*) and set DIGEST_TO.");
  const clock = localClock(new Date(), config.digest.tz);
  const due = clock.minutes >= parseTime(config.digest.time) && store.getMeta("daily_date") !== clock.date;
  if (send && !due && !args.has("--force")) process.exit(0);
  if (!(await networkUp())) {
    console.log(`[daily] ${new Date().toISOString()} no network; trying again at the next scheduled check`);
    process.exit(0);
  }

  const started = Date.now();
  const startedAt = new Date().toISOString();
  try {
    const alerts = await scheduler.runAll();
    const until = new Date().toISOString();
    const since = store.getMeta("digest_until") ?? new Date(Date.now() - 86400_000).toISOString();
    const digest = await buildDigestAsync(store, sources, since, until);
    const failedSources = [...scheduler.health.values()].filter((h) => h.consecutiveErrors > 0);
    const openFemaDown = failedSources.some((h) => h.id.startsWith("openfema"));
    const status = openFemaDown ? "failed" : failedSources.length ? "degraded" : "succeeded";
    console.log(`[daily] ${until} polled ${sources.length} sources in ${Math.round((Date.now() - started) / 1000)}s, ${failedSources.length} failed, ${alerts.length} alert(s)`);
    if (!send) {
      console.log(`Subject: ${digest.subject}\n\n${digest.text}`);
      await reportWatchRun({
        externalId: `daily:${clock.date}:preview:${startedAt}`,
        status,
        startedAt,
        finishedAt: until,
        summary: `Daily check finished without sending email. ${failedSources.length} source(s) failed and ${alerts.length} alert(s) were found.`,
        logs: watchLogs(failedSources, alerts),
        html: digest.html,
      });
      process.exit(0);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await sendDigest(digest, store);
        break;
      } catch (err) {
        if (isGmailRefreshError(err)) markGmailRefreshNeeded(store);
        if (attempt === 3) throw err;
        console.error(`[daily] send attempt ${attempt} failed, retrying in 30s: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
    store.setMeta("digest_until", until);
    store.setMeta("daily_date", clock.date);
    store.pruneStats(new Date(Date.now() - 40 * 86400_000).toISOString());
    console.log(`[daily] sent "${digest.subject}" to ${config.digest.to.join(", ")}${config.digest.cc.length ? ` cc ${config.digest.cc.join(", ")}` : ""}`);
    await reportWatchRun({
      externalId: `daily:${clock.date}`,
      status,
      startedAt,
      finishedAt: until,
      summary: `${digest.subject} ${failedSources.length} source(s) failed.`,
      logs: watchLogs(failedSources, alerts),
      html: digest.html,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportWatchRun({
      externalId: `daily:${clock.date}:attempt:${startedAt}`,
      status: "failed",
      startedAt,
      summary: `Daily disaster watch did not finish. ${message}`,
      logs: [{ level: "error", message, logged_at: new Date().toISOString() }],
    });
    throw err;
  }
  process.exit(0);
}

if (args.has("--digest") || args.has("--digest-preview")) {
  // Ad hoc digest covering everything since the last scheduled one (or the last 24 hours). Doesn't move the schedule's window.
  const until = new Date().toISOString();
  const since = store.getMeta("digest_until") ?? new Date(Date.now() - 86400_000).toISOString();
  const digest = await buildDigestAsync(store, sources, since, until);
  if (args.has("--digest-preview")) {
    const file = join(config.dataDir, "digest-preview.html");
    writeFileSync(file, digest.html);
    console.log(`Subject: ${digest.subject}\n\n${digest.text}\n\nHTML version: ${file}`);
  } else {
    if (!digestConfigured()) throw new Error("Configure email (MAIL_PROVIDER=gmail with GMAIL_* settings, or SMTP_*) and set DIGEST_TO to send the digest.");
    await sendDigest(digest, store);
    console.log(`Sent "${digest.subject}" to ${config.digest.to.join(", ")}`);
  }
  process.exit(0);
}

function watchLogs(
  failedSources: { id: string; lastError?: string }[],
  alerts: Alert[],
): { level: "info" | "warn" | "error"; message: string; logged_at: string }[] {
  const at = new Date().toISOString();
  return [
    ...failedSources.map((source) => ({
      level: "error" as const,
      message: `${source.id} failed. ${source.lastError ?? "No error text was recorded."}`,
      logged_at: at,
    })),
    ...alerts.slice(0, 40).map((alert) => ({
      level: "info" as const,
      message: `${alert.type}: ${alert.detection.title}`,
      logged_at: alert.detection.detectedAt,
    })),
  ];
}

if (args.has("--once")) {
  // One pass over every source; useful for checking connectivity and classifier output.
  const startedAt = new Date().toISOString();
  const results = await Promise.all(sources.map((s) => scheduler.runOnce(s)));
  for (const h of scheduler.health.values()) {
    console.log(`${h.healthy ? "ok  " : "FAIL"} ${h.id.padEnd(26)} items=${h.lastItemCount ?? "-"} ${h.lastDurationMs}ms ${h.lastError ?? ""}`);
  }
  console.log(`\n${results.flat().length} alert(s). Recent events:`);
  for (const e of store.latestEvents(25)) {
    console.log(`  [${e.level}/${e.status}${e.official ? "/official" : ""}] ${e.state ?? "??"} ${e.title}`);
  }
  const failedSources = [...scheduler.health.values()].filter((h) => !h.healthy);
  const alerts = results.flat();
  const openFemaDown = failedSources.some((h) => h.id.startsWith("openfema"));
  await reportWatchRun({
    externalId: `once:${startedAt}`,
    status: openFemaDown ? "failed" : failedSources.length ? "degraded" : "succeeded",
    startedAt,
    summary: `One pass finished. ${failedSources.length} source(s) were unhealthy and ${alerts.length} alert(s) were found.`,
    logs: watchLogs(failedSources, alerts),
  });
  process.exit(0);
}

console.log(`[start] watching ${sources.length} sources; alerts -> console${config.slackWebhookUrl ? ", Slack" : ""}${config.webhookUrls.length ? `, ${config.webhookUrls.length} webhook(s)` : ""}${config.twilio.to.length ? `, SMS x${config.twilio.to.length}` : ""}`);
scheduler.start();
const server = startServer(config.port, store, scheduler);
const stopDigest = startDigestSchedule(store, sources);
if (digestConfigured()) console.log(`[digest] daily at ${config.digest.time} ${config.digest.tz} -> ${config.digest.to.join(", ")}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[stop] ${sig}`);
    stopDigest();
    scheduler.stop();
    server.close();
    store.db.close();
    process.exit(0);
  });
}
