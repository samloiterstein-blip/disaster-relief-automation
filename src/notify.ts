import { config } from "./config.ts";
import { stateName } from "./states.ts";
import type { Alert, Kind, Level, Status } from "./types.ts";

export const LEVEL: Record<Level, string> = { federal: "Federal", state: "State", local: "Local" };
export const KIND: Record<Kind, string> = {
  major_disaster: "major disaster declaration",
  emergency: "emergency declaration",
  fire_management: "fire management assistance declaration",
  sba_disaster: "SBA disaster declaration",
  state_emergency: "emergency declaration",
  local_emergency: "emergency declaration",
  other: "declaration",
};

export function headline(a: Alert): string {
  const d = a.detection;
  const what = `${LEVEL[a.event.level]} ${KIND[a.event.kind]}`;
  const where = stateName(a.event.state ?? d.state);
  if (a.type === "confirmed") return `OFFICIALLY CONFIRMED: ${what}, ${where}`;
  if (a.type === "amended" || d.status === "amended") return `DECLARATION EXPANDED: ${what}, ${where}`;
  if (d.status === "requested") return `DECLARATION REQUESTED: ${what}, ${where}`;
  if (d.status === "renewed") return `DECLARATION RENEWED: ${what}, ${where}`;
  return `NEW ${what.toUpperCase()}: ${where}`;
}

function sourceLine(a: Alert): string {
  const d = a.detection;
  const tier = d.tier === "official" ? "official source" : a.event.official ? "press report, officially confirmed" : "press report, not yet officially confirmed";
  const lag = a.latencySeconds !== undefined ? `, detected ${formatLag(a.latencySeconds)} after publication` : "";
  return `Source: ${d.sourceName} (${tier}${lag})`;
}

function formatLag(s: number): string {
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function formatText(a: Alert): string {
  const d = a.detection;
  return [headline(a), d.title, d.summary && d.tier === "official" ? d.summary.slice(0, 400) : null, sourceLine(a), d.url]
    .filter(Boolean)
    .join("\n");
}

/** WATCH_STATES and ALERT_STATUSES, shared by real-time alerts and the daily digest. */
export function alertWanted(type: Alert["type"], status: Status, state: string | null | undefined): boolean {
  if (config.watchStates.size && state && !config.watchStates.has(state)) return false;
  if (type === "new" && !config.alertStatuses.has(status)) return false;
  return true;
}

function passesFilters(a: Alert): boolean {
  return alertWanted(a.type, a.detection.status, a.event.state ?? a.detection.state);
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (attempt === 3) throw err;
    }
    if (res?.ok) return;
    if (res && ((res.status < 500 && res.status !== 429) || attempt === 3)) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}

async function sendSms(a: Alert): Promise<void> {
  const t = config.twilio;
  if (!t.accountSid || !t.authToken || !t.from || !t.to.length || t.tier === "none") return;
  if (t.tier === "official" && !a.event.official) return;
  if (a.type === "new" && !t.statuses.has(a.detection.status)) return;

  const body = `${headline(a)}\n${a.detection.title}`.slice(0, 300) + (a.detection.url ? `\n${a.detection.url}` : "");
  const auth = Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`;
  await Promise.all(
    t.to.map((to) =>
      post(url, new URLSearchParams({ To: to, From: t.from!, Body: body }).toString(), {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${auth}`,
      }),
    ),
  );
}

export function alertPayload(a: Alert) {
  return {
    type: a.type,
    headline: headline(a),
    text: formatText(a),
    latencySeconds: a.latencySeconds ?? null,
    event: { ...a.event, tokens: undefined },
    detection: a.detection,
  };
}

export async function notify(a: Alert): Promise<void> {
  if (!passesFilters(a)) return;
  const text = formatText(a);
  console.log(`\n[ALERT ${new Date().toISOString()}]\n${text}\n`);

  const jobs: Array<[string, Promise<void>]> = [];
  if (config.slackWebhookUrl) jobs.push(["slack", post(config.slackWebhookUrl, { text })]);
  for (const url of config.webhookUrls) jobs.push([`webhook ${new URL(url).host}`, post(url, alertPayload(a))]);
  jobs.push(["sms", sendSms(a)]);

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`[notify] ${jobs[i][0]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
  });
}
