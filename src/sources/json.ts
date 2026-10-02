import { assumedDeclaration, classify } from "../classify.ts";
import { fetchJson } from "../http.ts";
import type { Detection, Level, Source, Tier } from "../types.ts";

export interface JsonSourceConfig {
  id: string;
  name: string;
  url: string;
  /** JSON body to POST (GraphQL, Coveo search). Omit for GET. */
  body?: unknown;
  headers?: Record<string, string>;
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
      const data = await fetchJson<unknown>(cfg.url, { body: cfg.body, headers: cfg.headers, browserUserAgent: cfg.browserUserAgent });
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
