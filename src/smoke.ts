import { config } from "./config.ts";
import { escapeHtml, formatTime, plural } from "./digest.ts";
import { fetchJson } from "./http.ts";
import type { EmailMessage } from "./mail.ts";
import { KIND, LEVEL } from "./notify.ts";
import { Scheduler } from "./scheduler.ts";
import { loadSources } from "./sources/index.ts";
import { openFemaDeclarations, openFemaDesignatedAreas, TYPE, type DateWindow } from "./sources/openfema.ts";
import { sbaDeclarations } from "./sources/sba.ts";
import { STATES, stateName } from "./states.ts";
import { Store } from "./store.ts";
import type { Alert, Detection, PollResult, Source, Tier } from "./types.ts";

/** SBA publishes its copies of declarations in the Federal Register over the following days. */
const SBA_LAG_DAYS = 14;

export interface ConnectionResult {
  id: string;
  name: string;
  tier: Tier;
  state?: string;
  ok: boolean;
  error?: string;
  items: number;
  detections: Detection[];
}

interface ReplayResult {
  connections: ConnectionResult[];
  alerts: Alert[];
}

interface FederalDeclaration {
  ref: string;
  date: string;
  name: string;
  state: string;
}

type Verdict = "verified" | "connected" | "failing" | "not watched";

interface StateRow {
  code: string;
  latestFederal?: FederalDeclaration;
  replayAlerts: number;
  endpoints: ConnectionResult[];
  declarationsFound: number;
  example?: Detection;
  verdict: Verdict;
}

export interface SmokeReport extends EmailMessage {
  date: string;
  replayAlerts: number;
  connectionsOk: number;
  connectionsTotal: number;
}

/**
 * Polls each source once on a fresh store with no baseline and no age limit, so everything
 * a source lists goes through classification, event grouping, and alerting as if it were new.
 */
async function replay(sources: Source[], store: Store): Promise<ReplayResult> {
  const captured = new Map<string, PollResult | null>();
  const wrapped = sources.map(
    (s): Source => ({
      ...s,
      maxAgeHours: Infinity,
      poll: async () => {
        const r = await s.poll();
        captured.set(s.id, r);
        return r;
      },
    }),
  );
  for (const s of wrapped) store.markBaselined(s.id);
  const scheduler = new Scheduler(store, wrapped, async () => {});
  const alerts = await scheduler.runAll();

  const connections = wrapped.map((s): ConnectionResult => {
    const h = scheduler.health.get(s.id)!;
    const r = captured.get(s.id);
    const ok = h.consecutiveErrors === 0;
    return {
      id: s.id,
      name: s.name,
      tier: s.tier,
      state: s.state,
      ok,
      error: ok ? undefined : h.lastError,
      items: r?.items.length ?? 0,
      detections: r?.detections ?? [],
    };
  });
  return { connections, alerts };
}

interface WebDeclarationRow {
  disasterNumber: number;
  declarationDate: string;
  declarationType: string;
  stateCode: string;
  disasterName: string;
}

/** Every FEMA declaration on record, newest first (about 5,300 rows). */
async function allFederalDeclarations(): Promise<FederalDeclaration[]> {
  const url =
    "https://www.fema.gov/api/open/v1/FemaWebDisasterDeclarations?$select=disasterNumber,declarationDate,declarationType,stateCode,disasterName" +
    "&$orderby=declarationDate%20desc&$top=10000";
  const body = await fetchJson<{ FemaWebDisasterDeclarations: WebDeclarationRow[] }>(url, { conditional: false, timeoutMs: 60_000 });
  return (body?.FemaWebDisasterDeclarations ?? []).map((r) => ({
    ref: `${TYPE[r.declarationType]?.prefix ?? "??"}-${r.disasterNumber}-${r.stateCode}`,
    date: r.declarationDate,
    name: r.disasterName,
    state: r.stateCode,
  }));
}

/** The calendar day (UTC, as FEMA records it) with the most declarations. */
export function busiestDay(declarations: FederalDeclaration[]): { date: string; count: number } {
  const counts = new Map<string, number>();
  for (const d of declarations) counts.set(d.date.slice(0, 10), (counts.get(d.date.slice(0, 10)) ?? 0) + 1);
  let best = { date: "", count: 0 };
  for (const [date, count] of counts) if (count > best.count) best = { date, count };
  return best;
}

/**
 * Prefer the most recently dated declaration. Listing pages carry no dates, so fall back to the first
 * link whose own text reads as a declaration, then to links that only matched once their page was opened.
 */
function latestExample(detections: Detection[]): Detection | undefined {
  const dated = detections.filter((d) => d.publishedAt).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  return dated[0] ?? detections.find((d) => !d.summary) ?? detections[0];
}

function verdictOf(endpoints: ConnectionResult[], found: number): Verdict {
  if (!endpoints.length) return "not watched";
  if (!endpoints.some((e) => e.ok)) return "failing";
  return found ? "verified" : "connected";
}

const VERDICT_TEXT: Record<Verdict, string> = {
  verified: "Verified",
  connected: "Connected, no declarations listed",
  failing: "Failing",
  "not watched": "Not watched",
};

function alertLine(a: Alert): string {
  return `${LEVEL[a.event.level]} ${KIND[a.event.kind]}${a.type === "amended" || a.event.status === "amended" ? " (expanded)" : ""}`;
}

function shortDate(iso: string | undefined, tz: string): string {
  return iso ? formatTime(iso, tz, { month: "short", day: "numeric", year: "numeric" }) : "date not listed";
}

/**
 * End-to-end check of every connection: replays the busiest FEMA declaration day on record
 * through the real pipeline, then polls every live source with nothing baselined and reports,
 * state by state, whether the state's own sites returned declarations the classifier recognized.
 */
export async function runSmokeTest(opts: { date?: string; tz?: string } = {}): Promise<SmokeReport> {
  const tz = opts.tz ?? config.digest.tz;
  const started = new Date().toISOString();
  const federal = await allFederalDeclarations();
  if (!federal.length) throw new Error("OpenFEMA returned no declarations; the federal connection is down.");
  const busiest = busiestDay(federal);
  const date = opts.date ?? busiest.date;
  const day: DateWindow = { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
  const sbaWindow: DateWindow = { from: day.from, to: new Date(Date.parse(day.to) + SBA_LAG_DAYS * 86400_000).toISOString() };
  const declaredThatDay = federal.filter((d) => d.date.slice(0, 10) === date);

  const historyStore = new Store(":memory:");
  const history = await replay(
    [openFemaDeclarations({ window: day }), openFemaDesignatedAreas(historyStore, { window: day }), sbaDeclarations({ window: sbaWindow })],
    historyStore,
  );

  const liveStore = new Store(":memory:");
  const live = await replay(loadSources(config.sourcesFile, liveStore), liveStore);

  const latest = new Map<string, FederalDeclaration>();
  for (const d of federal) if (!latest.has(d.state)) latest.set(d.state, d);
  const rows: StateRow[] = Object.keys(STATES).map((code) => {
    const endpoints = live.connections.filter((c) => c.state === code);
    const found = endpoints.filter((e) => e.tier === "official").flatMap((e) => e.detections);
    return {
      code,
      latestFederal: latest.get(code),
      replayAlerts: history.alerts.filter((a) => a.event.state === code).length,
      endpoints,
      declarationsFound: found.length,
      example: latestExample(found),
      verdict: verdictOf(endpoints, found.length),
    };
  });

  const ok = live.connections.filter((c) => c.ok);
  const failed = live.connections.filter((c) => !c.ok);
  const federalLive = live.connections.filter((c) => !c.state && c.tier === "official");
  const news = live.connections.filter((c) => c.tier === "news");
  const replayStates = new Set(history.alerts.map((a) => a.event.state).filter(Boolean));
  const sbaAlerts = history.alerts.filter((a) => a.detection.sourceId === "sba-declarations").length;
  const femaAlerts = history.alerts.length - sbaAlerts;
  const dayLabel = formatTime(day.from, "UTC", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const shortDay = formatTime(day.from, "UTC", { month: "short", day: "numeric", year: "numeric" });
  const verdictCount = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const channels = [
    `Slack: ${config.slackWebhookUrl ? "configured" : "not configured"}`,
    `Webhooks: ${config.webhookUrls.length || "none"}`,
    `SMS: ${config.twilio.accountSid && config.twilio.to.length ? `${config.twilio.to.length} number(s)` : "not configured"}`,
    "Email: this message",
  ];

  const subject = `Disaster watch smoke test: ${plural(history.alerts.length, "alert")} from ${shortDay} replay, ${ok.length} of ${live.connections.length} connections working`;
  const headline = `${failed.length ? `${failed.length} of ${live.connections.length} connections failed.` : `All ${live.connections.length} connections responded.`} Replaying ${shortDay} produced ${plural(history.alerts.length, "alert")}.`;
  const replaySummary =
    `FEMA issued ${plural(declaredThatDay.length, "declaration")} on ${dayLabel}` +
    `${date === busiest.date ? ", the most of any day on record" : ` (the record is ${busiest.count} on ${busiest.date})`}. ` +
    `Replaying that day through the pipeline produced ${plural(femaAlerts, "FEMA alert")} covering ${replayStates.size} states and territories, ` +
    `and SBA's Federal Register notices from the following ${SBA_LAG_DAYS} days produced ${sbaAlerts} more.`;
  const stateSummary =
    `${verdictCount("verified")} states and territories verified (a state site responded and listed declarations the classifier recognized), ` +
    `${verdictCount("connected")} connected with no declarations currently listed, ${verdictCount("failing")} failing, ${verdictCount("not watched")} not watched.`;
  const liveSummary =
    `Federal: ${federalLive.filter((c) => c.ok).length} of ${federalLive.length} working. ` +
    `News searches: ${news.filter((c) => c.ok).length} of ${news.length} working, ${plural(news.reduce((n, c) => n + c.items, 0), "article")}, ` +
    `${plural(news.reduce((n, c) => n + c.detections.length, 0), "declaration match")}.`;

  const stateLine = (r: StateRow): string => {
    const fed = r.latestFederal ? `${r.latestFederal.ref} on ${shortDate(r.latestFederal.date, "UTC")} (${r.latestFederal.name})` : "none on record";
    const sites = r.endpoints.length
      ? `${r.endpoints.filter((e) => e.ok).length} of ${r.endpoints.length} state endpoints working, ${plural(r.declarationsFound, "declaration")} found`
      : "no state endpoints watched";
    const example = r.example ? `\n      Latest on state site: ${r.example.title} (${shortDate(r.example.publishedAt, tz)})` : "";
    return `  ${r.code}  ${VERDICT_TEXT[r.verdict]}. Last FEMA declaration ${fed}. ${sites}. ${r.replayAlerts} in replay.${example}`;
  };

  const text = [
    headline,
    "",
    "1. STATE BY STATE",
    stateSummary,
    ...rows.map(stateLine),
    "",
    `2. HISTORICAL REPLAY: ${dayLabel.toUpperCase()}`,
    replaySummary,
    ...history.alerts.map((a) => `  ${a.event.state ?? "??"}  ${alertLine(a)}: ${a.detection.title}`),
    "",
    "3. LIVE CONNECTIONS",
    `${ok.length} of ${live.connections.length} working.${failed.length ? " Failed after one retry:" : ""}`,
    ...failed.map((c) => `  ${c.id}  ${c.name}: ${c.error}`),
    liveSummary,
    "",
    "4. ALERT CHANNELS",
    channels.join(". ") + ".",
    "",
    `Run ${formatTime(started, tz, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}.`,
  ].join("\n");

  const cell = "padding:4px 8px;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top;";
  const verdictColor: Record<Verdict, string> = { verified: "#067647", connected: "#555", failing: "#b42318", "not watched": "#888" };
  const link = (title: string, url?: string) => (url ? `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>` : escapeHtml(title));
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;max-width:900px">
<p style="font-size:18px;font-weight:600;margin:0 0 4px">${escapeHtml(headline)}</p>
<p style="margin:0 0 16px;color:#444">${escapeHtml(stateSummary)}</p>
<h3 style="margin:16px 0 8px">State by state</h3>
<table style="border-collapse:collapse;width:100%">
<tr><th style="${cell}">State</th><th style="${cell}">Result</th><th style="${cell}">Last FEMA declaration</th><th style="${cell}">State endpoints working</th><th style="${cell}">Declarations on state sites</th><th style="${cell}">Latest on state site</th></tr>
${rows
  .map(
    (r) => `<tr><td style="${cell}"><strong>${r.code}</strong><br><span style="color:#888;font-size:12px">${escapeHtml(stateName(r.code))}</span></td>` +
      `<td style="${cell}font-weight:600;color:${verdictColor[r.verdict]}">${VERDICT_TEXT[r.verdict]}</td>` +
      `<td style="${cell}">${r.latestFederal ? `${escapeHtml(r.latestFederal.ref)}<br><span style="color:#555">${shortDate(r.latestFederal.date, "UTC")}, ${escapeHtml(r.latestFederal.name)}</span>` : "none"}</td>` +
      `<td style="${cell}">${r.endpoints.length ? `${r.endpoints.filter((e) => e.ok).length} of ${r.endpoints.length}` : "none"}</td>` +
      `<td style="${cell}">${r.declarationsFound}</td>` +
      `<td style="${cell}font-size:13px">${r.example ? `${link(r.example.title, r.example.url)}<br><span style="color:#555">${shortDate(r.example.publishedAt, tz)}</span>` : ""}</td></tr>`,
  )
  .join("\n")}
</table>
<h3 style="margin:24px 0 8px">Historical replay: ${escapeHtml(dayLabel)}</h3>
<p style="margin:0 0 8px;color:#444">${escapeHtml(replaySummary)}</p>
<table style="border-collapse:collapse;width:100%">
<tr><th style="${cell}">State</th><th style="${cell}">Alert</th><th style="${cell}">Source</th></tr>
${history.alerts
  .map(
    (a) => `<tr><td style="${cell}">${a.event.state ?? "??"}</td><td style="${cell}"><strong>${escapeHtml(alertLine(a))}</strong><br>${link(a.detection.title, a.detection.url)}</td><td style="${cell}color:#555">${escapeHtml(a.detection.sourceName)}</td></tr>`,
  )
  .join("\n")}
</table>
<h3 style="margin:24px 0 8px">Live connections</h3>
<p style="margin:0 0 8px">${ok.length} of ${live.connections.length} working. ${escapeHtml(liveSummary)}</p>
${
  failed.length
    ? `<table style="border-collapse:collapse;width:100%"><tr><th style="${cell}">Failed after one retry</th><th style="${cell}">Error</th></tr>${failed
        .map((c) => `<tr><td style="${cell}">${escapeHtml(c.name)}<br><span style="color:#888;font-size:12px">${c.id}</span></td><td style="${cell}color:#b42318">${escapeHtml(c.error ?? "")}</td></tr>`)
        .join("")}</table>`
    : ""
}
<h3 style="margin:24px 0 8px">Alert channels</h3>
<p style="margin:0">${escapeHtml(channels.join(". "))}.</p>
<p style="margin-top:24px;color:#888;font-size:12px">Run ${escapeHtml(formatTime(started, tz, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }))}.</p>
</body></html>`;

  historyStore.db.close();
  liveStore.db.close();
  return { subject, text, html, date, replayAlerts: history.alerts.length, connectionsOk: ok.length, connectionsTotal: live.connections.length };
}
