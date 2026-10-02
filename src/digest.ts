import { config } from "./config.ts";
import { reportWatchRun } from "./status-portal.ts";
import { mailConfigured, sendEmail } from "./mail.ts";
import { alertWanted, KIND, LEVEL } from "./notify.ts";
import { stateName } from "./states.ts";
import type { AlertRow, SourceActivity, Store } from "./store.ts";
import type { Source } from "./types.ts";

export interface Digest {
  subject: string;
  text: string;
  html: string;
  alertCount: number;
}

type EndpointStatus = "ok" | "unreliable" | "down" | "not checked";

interface Endpoint {
  id: string;
  name: string;
  activity: SourceActivity;
  status: EndpointStatus;
}

const NO_ACTIVITY: SourceActivity = { newItems: 0, detections: 0, pollsOk: 0, pollsFailed: 0 };

function statusOf(a: SourceActivity): EndpointStatus {
  const total = a.pollsOk + a.pollsFailed;
  if (total === 0) return "not checked";
  if (a.pollsOk === 0) return "down";
  if (a.pollsFailed / total > 0.25) return "unreliable";
  return "ok";
}

export function formatTime(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : /(?:ch|sh|s|x)$/.test(word) ? "es" : "s"}`;
}

function alertLabel(r: AlertRow): string {
  const what = `${LEVEL[r.level]} ${KIND[r.kind]}`;
  const where = stateName(r.state);
  if (r.type === "confirmed") return `Officially confirmed: ${what}, ${where}`;
  if (r.type === "amended" || r.status === "amended") return `Expanded: ${what}, ${where}`;
  if (r.status === "requested") return `Requested: ${what}, ${where}`;
  if (r.status === "renewed") return `Renewed: ${what}, ${where}`;
  return `New: ${what}, ${where}`;
}

function alertCategory(r: AlertRow): string {
  if (r.type === "confirmed") return "confirmation";
  if (r.type === "amended" || r.status === "amended") return "expansion";
  if (r.status === "requested") return "request";
  if (r.status === "renewed") return "renewal";
  return "new declaration";
}

function summarize(alerts: AlertRow[]): string {
  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(alertCategory(a), (counts.get(alertCategory(a)) ?? 0) + 1);
  return ["new declaration", "expansion", "request", "confirmation", "renewal"]
    .filter((c) => counts.has(c))
    .map((c) => plural(counts.get(c)!, c))
    .join(", ");
}

function activityLine(a: SourceActivity): string {
  const parts = [plural(a.newItems, "new item")];
  if (a.detections) parts.push(plural(a.detections, "declaration match"));
  return parts.join(", ");
}

function healthLine(e: Endpoint): string {
  const a = e.activity;
  if (e.status === "not checked") return "not checked in this window";
  const checks = `${a.pollsOk.toLocaleString("en-US")} of ${(a.pollsOk + a.pollsFailed).toLocaleString("en-US")} checks succeeded`;
  return `${e.status}, ${checks}${a.lastError ? `. Last error: ${a.lastError}` : ""}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrap(words: string[], width = 76, indent = "  "): string {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + w.length + 2 > width) {
      lines.push(indent + line + ",");
      line = w;
    } else {
      line = line ? `${line}, ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

/** The end-of-day summary: did anything get declared, and which endpoints posted anything at all. */
export function buildDigest(store: Store, sources: Source[], since: string, until: string, tz = config.digest.tz): Digest {
  const alerts = store.alertsBetween(since, until).filter((a) => alertWanted(a.type, a.status, a.state));
  const activity = store.activityBetween(since, until);

  const endpoints: Endpoint[] = sources
    .filter((s) => s.tier === "official")
    .map((s) => {
      const a = activity.get(s.id) ?? NO_ACTIVITY;
      return { id: s.id, name: s.name, activity: a, status: statusOf(a) };
    });
  const isActive = (e: Endpoint) => e.activity.newItems > 0 || e.activity.detections > 0;
  const active = endpoints
    .filter(isActive)
    .sort((x, y) => y.activity.detections - x.activity.detections || y.activity.newItems - x.activity.newItems || x.id.localeCompare(y.id));
  const troubled = endpoints.filter((e) => e.status !== "ok");
  const quiet = endpoints.filter((e) => !isActive(e) && e.status === "ok");

  const news = sources.filter((s) => s.tier === "news").map((s) => activity.get(s.id) ?? NO_ACTIVITY);
  const newsArticles = news.reduce((n, a) => n + a.newItems, 0);
  const newsMatches = news.reduce((n, a) => n + a.detections, 0);

  const span = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;
  const window = `from ${formatTime(since, tz, span)} to ${formatTime(until, tz, { ...span, timeZoneName: "short" })}`;
  const day = formatTime(until, tz, { weekday: "short", month: "short", day: "numeric" });
  const subject = alerts.length
    ? `Disaster watch ${day}: YES, ${summarize(alerts)}`
    : `Disaster watch ${day}: no new declarations`;
  const answer = alerts.length
    ? `YES. ${plural(alerts.length, "alert")} (${summarize(alerts)}) ${window}.`
    : `NO. Nothing new was declared ${window}.`;
  const endpointSummary = `${active.length} of ${endpoints.length} official endpoints posted something new.${troubled.length ? ` ${troubled.length} had trouble responding.` : ""}`;
  const newsSummary = news.length
    ? `News searches: ${plural(newsArticles, "new article")} across ${plural(news.length, "search")}, ${plural(newsMatches, "declaration match")}.`
    : "";

  const text = [
    answer,
    endpointSummary,
    "",
    ...(alerts.length
      ? [
          "ALERTS",
          ...alerts.flatMap((a, i) => [
            `${i + 1}. ${alertLabel(a)}`,
            `   ${a.title}`,
            `   ${a.source_name}, ${a.official ? "official source" : "press report"}, ${formatTime(a.at, tz, { hour: "numeric", minute: "2-digit" })}`,
            ...(a.url ? [`   ${a.url}`] : []),
          ]),
          "",
        ]
      : []),
    `POSTED SOMETHING NEW (${active.length})`,
    ...(active.length ? active.map((e) => `  ${e.id}  ${e.name}: ${activityLine(e.activity)}`) : ["  none"]),
    "",
    ...(troubled.length
      ? [`DOWN OR UNRELIABLE (${troubled.length})`, ...troubled.map((e) => `  ${e.id}  ${e.name}: ${healthLine(e)}`), ""]
      : []),
    `NOTHING NEW (${quiet.length})`,
    wrap(quiet.map((e) => e.id)),
    "",
    newsSummary,
  ].join("\n");

  const rows = [...active, ...troubled.filter((e) => !isActive(e)), ...quiet];
  const cell = "padding:4px 8px;border-bottom:1px solid #e5e5e5;text-align:left;";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;max-width:760px">
<p style="font-size:18px;font-weight:600;margin:0 0 4px">${escapeHtml(answer)}</p>
<p style="margin:0 0 16px;color:#444">${escapeHtml(endpointSummary)}</p>
${
  alerts.length
    ? `<h3 style="margin:16px 0 8px">Alerts</h3><ol style="padding-left:20px">${alerts
        .map(
          (a) => `<li style="margin-bottom:10px"><strong>${escapeHtml(alertLabel(a))}</strong><br>${
            a.url ? `<a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>` : escapeHtml(a.title)
          }<br><span style="color:#555">${escapeHtml(a.source_name)}, ${a.official ? "official source" : "press report"}, ${escapeHtml(
            formatTime(a.at, tz, { hour: "numeric", minute: "2-digit" }),
          )}</span></li>`,
        )
        .join("")}</ol>`
    : ""
}
<h3 style="margin:16px 0 8px">Official endpoints</h3>
<table style="border-collapse:collapse;width:100%">
<tr><th style="${cell}">Endpoint</th><th style="${cell}">New activity</th><th style="${cell}">New items</th><th style="${cell}">Declaration matches</th><th style="${cell}">Status</th></tr>
${rows
  .map((e) => {
    const yes = isActive(e);
    const statusColor = e.status === "ok" ? "#555" : "#b42318";
    return `<tr><td style="${cell}">${escapeHtml(e.name)}<br><span style="color:#888;font-size:12px">${e.id}</span></td><td style="${cell}font-weight:600;color:${yes ? "#067647" : "#888"}">${yes ? "Yes" : "No"}</td><td style="${cell}">${e.activity.newItems}</td><td style="${cell}">${e.activity.detections}</td><td style="${cell}color:${statusColor}" title="${escapeHtml(e.activity.lastError ?? "")}">${escapeHtml(e.status === "ok" ? "ok" : healthLine(e))}</td></tr>`;
  })
  .join("\n")}
</table>
${newsSummary ? `<p style="margin-top:16px;color:#444">${escapeHtml(newsSummary)}</p>` : ""}
</body></html>`;

  return { subject, text, html, alertCount: alerts.length };
}

export function digestConfigured(): boolean {
  return mailConfigured() && config.digest.to.length > 0;
}

export async function sendDigest(d: Digest): Promise<void> {
  await sendEmail(config.digest.to, d, config.digest.cc);
}

/** Calendar date and minutes past midnight in a time zone. */
export function localClock(date: Date, tz: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function parseTime(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`DIGEST_TIME must be HH:MM (24-hour), got "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Sends the digest once a day at DIGEST_TIME. Each digest covers everything
 * since the previous one, so a restart or a failed send never leaves a gap.
 */
export function startDigestSchedule(store: Store, sources: Source[]): () => void {
  if (!digestConfigured()) return () => {};
  const { tz } = config.digest;
  const target = parseTime(config.digest.time);
  localClock(new Date(), tz); // throws on an invalid DIGEST_TZ

  // On first run, start the window now; the first digest goes out at the next send time.
  if (!store.getMeta("digest_until")) {
    const now = new Date();
    store.setMeta("digest_until", now.toISOString());
    const clock = localClock(now, tz);
    if (clock.minutes >= target) store.setMeta("digest_date", clock.date);
  }

  let running = false;
  let retryAt = 0;
  const tick = async () => {
    const now = new Date();
    const clock = localClock(now, tz);
    if (running || clock.minutes < target || store.getMeta("digest_date") === clock.date || now.getTime() < retryAt) return;
    running = true;
    const since = store.getMeta("digest_until")!;
    const until = now.toISOString();
    try {
      const digest = buildDigest(store, sources, since, until);
      await sendDigest(digest);
      store.setMeta("digest_until", until);
      store.setMeta("digest_date", clock.date);
      store.pruneStats(new Date(now.getTime() - 40 * 86400_000).toISOString());
      console.log(`[digest] sent "${digest.subject}" to ${config.digest.to.length} recipient(s)`);
      await reportWatchRun({
        externalId: `daily:${clock.date}`,
        status: "succeeded",
        startedAt: since,
        finishedAt: until,
        summary: digest.subject,
        html: digest.html,
      });
    } catch (err) {
      retryAt = now.getTime() + 15 * 60_000;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[digest] send failed, retrying in 15 min: ${message}`);
      await reportWatchRun({
        externalId: `daily:${clock.date}:send:${until}`,
        status: "failed",
        startedAt: since,
        finishedAt: until,
        summary: `Daily digest was not sent. ${message}`,
        logs: [{ level: "error", message, logged_at: until }],
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  void tick();
  return () => clearInterval(timer);
}
