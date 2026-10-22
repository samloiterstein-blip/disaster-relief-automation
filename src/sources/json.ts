import { assumedDeclaration, classify } from "../classify.ts";
import { fetchJson, fetchText, HttpError } from "../http.ts";
import type { Detection, Level, Source, Tier } from "../types.ts";

export interface JsonSourceConfig {
  id: string;
  name: string;
  url: string;
  /** JSON body to POST (GraphQL, Coveo search). Omit for GET. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * HTML page that publishes a search API token (e.g. Pennsylvania's Coveo `accessToken`).
   * The token is scraped and sent as `Authorization: Bearer …`.
   */
  tokenFrom?: string;
  /** Capture group 1 is the token. Defaults to a Coveo/JS `accessToken: '…'` assignment. */
  tokenPattern?: string;
  /** Dot path to the item array; omit when the response is the array. */
  itemsPath?: string;
  /** Dot paths within each item. */
  fields: { title: string; link: string; date?: string; summary?: string };
  /** Builds the item URL from the link field, e.g. "https://governor.wyo.gov/news-releases/{}". Relative links otherwise resolve against `url`. */
  linkTemplate?: string;
  state?: string;
  level?: Level;
  tier?: Tier;
  intervalSeconds?: number;
  maxAgeHours?: number;
  mode?: "classify" | "declarations";
  browserUserAgent?: boolean;
}

const DEFAULT_TOKEN_RE = /accessToken["']?\s*[:=]\s*["']([^"']+)/i;
const tokenCache = new Map<string, { token: string; fetchedAt: number }>();
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export function extractAccessToken(html: string, pattern?: string): string | undefined {
  return html.match(pattern ? new RegExp(pattern) : DEFAULT_TOKEN_RE)?.[1];
}

async function searchToken(cfg: JsonSourceConfig, force = false): Promise<string> {
  const page = cfg.tokenFrom!;
  const cached = tokenCache.get(page);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const html = await fetchText(page, { accept: "text/html,application/xhtml+xml", browserUserAgent: cfg.browserUserAgent ?? true, conditional: false });
  const token = html ? extractAccessToken(html, cfg.tokenPattern) : undefined;
  if (!token) throw new Error(`no search token found on ${page}`);
  tokenCache.set(page, { token, fetchedAt: Date.now() });
  return token;
}

async function requestJson(cfg: JsonSourceConfig): Promise<unknown | null> {
  const headers = { ...cfg.headers };
  if (cfg.tokenFrom) headers.authorization = `Bearer ${await searchToken(cfg)}`;
  try {
    return await fetchJson<unknown>(cfg.url, { body: cfg.body, headers, browserUserAgent: cfg.browserUserAgent });
  } catch (err) {
    if (cfg.tokenFrom && err instanceof HttpError && err.status === 401) {
      headers.authorization = `Bearer ${await searchToken(cfg, true)}`;
      return await fetchJson<unknown>(cfg.url, { body: cfg.body, headers, browserUserAgent: cfg.browserUserAgent });
    }
    throw err;
  }
}

export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Month and day with no year, as Illinois's newsroom API sends them ("Sunday, August 09"):
 * the most recent such date that isn't in the future and, when given, falls on that weekday.
 */
export function yearlessDate(text: string, now = new Date()): string | undefined {
  const weekday = WEEKDAYS.indexOf(text.match(/^([a-z]+),/i)?.[1].toLowerCase() ?? "");
  const monthDay = text.replace(/^[a-z]+,\s*/i, "");
  if (!/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}$/i.test(monthDay)) return undefined;
  for (let year = now.getUTCFullYear(); year > now.getUTCFullYear() - 8; year--) {
    const ms = Date.parse(`${monthDay}, ${year} 12:00 UTC`);
    if (!Number.isFinite(ms)) return undefined;
    if (ms > now.getTime() + 86400_000) continue;
    if (weekday >= 0 && new Date(ms).getUTCDay() !== weekday) continue;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value);
  if (typeof value === "string" && !/\d{4}/.test(s)) return yearlessDate(s.trim());
  const ms = typeof value === "number" ? value : /^\d{10,13}$/.test(s) ? Number(value) : Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms < 1e12 ? ms * 1000 : ms).toISOString();
}

export interface JsonItem {
  title: string;
  link: string;
  publishedAt?: string;
  summary?: string;
}

export function extractItems(data: unknown, cfg: Pick<JsonSourceConfig, "itemsPath" | "fields" | "linkTemplate" | "url">): JsonItem[] {
  const items = getPath(data, cfg.itemsPath);
  if (!Array.isArray(items)) throw new Error(`no array at "${cfg.itemsPath ?? "(root)"}"; API response shape may have changed`);
  const out: JsonItem[] = [];
  for (const item of items) {
    const title = String(getPath(item, cfg.fields.title) ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const rawLink = getPath(item, cfg.fields.link);
    if (!title || rawLink === undefined || rawLink === null) continue;
    const link = cfg.linkTemplate ? cfg.linkTemplate.replace("{}", String(rawLink)) : new URL(String(rawLink), cfg.url).href;
    const summary = cfg.fields.summary ? getPath(item, cfg.fields.summary) : undefined;
    out.push({
      title,
      link,
      publishedAt: toIso(getPath(item, cfg.fields.date)),
      summary: typeof summary === "string" ? summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined,
    });
  }
  return out;
}

/** Newsrooms that render client-side from a JSON, GraphQL, or search API (Illinois, Pennsylvania, Wyoming, ...). */
export function jsonSource(cfg: JsonSourceConfig): Source {
  const tier = cfg.tier ?? "official";
  const hints = { level: cfg.level, state: cfg.state };
  return {
    id: cfg.id,
    name: cfg.name,
    tier,
    state: cfg.state,
    intervalMs: (cfg.intervalSeconds ?? 60) * 1000,
    maxAgeHours: cfg.maxAgeHours ?? 48,
    async poll() {
      const data = await requestJson(cfg);
      if (data === null) return null;
      const detectedAt = new Date().toISOString();
      const detections: Detection[] = [];
      const items = extractItems(data, cfg);
      for (const item of items) {
        const c =
          classify([item.title, item.summary?.slice(0, 300)].filter(Boolean).join(". "), hints) ??
          (cfg.mode === "declarations" ? assumedDeclaration(item.title, cfg.level, cfg.state) : null);
        if (!c) continue;
        detections.push({
          key: `${cfg.id}:${item.link}`,
          sourceId: cfg.id,
          sourceName: cfg.name,
          tier,
          level: c.level,
          kind: c.kind,
          status: c.status,
          title: item.title,
          url: item.link,
          state: c.state,
          publishedAt: item.publishedAt,
          detectedAt,
          summary: item.summary,
        });
      }
      return { detections, items: items.map((item) => item.link) };
    },
  };
}
