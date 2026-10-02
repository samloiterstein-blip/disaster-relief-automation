import { assumedDeclaration, classify } from "../classify.ts";
import { parseFeed, type FeedItem } from "../feed.ts";
import { fetchText } from "../http.ts";
import type { Detection, Level, Source, Tier } from "../types.ts";

export interface RssSourceConfig {
  id: string;
  name: string;
  url: string;
  tier?: Tier;
  /** Default level for items from this feed, e.g. "state" for a governor's newsroom. */
  level?: Level;
  /** USPS code when the feed belongs to one state. */
  state?: string;
  intervalSeconds?: number;
  maxAgeHours?: number;
  /** How much of each item's summary to feed the classifier. Titles alone are the most precise. */
  summaryChars?: number;
  /** Override the dedupe key namespace, so the same article from several queries is seen once. */
  keyNamespace?: string;
  /** "declarations": the feed only carries declarations (e.g. an emergency-proclamations category), so every item counts. */
  mode?: "classify" | "declarations";
  browserUserAgent?: boolean;
  /** For slow servers; defaults to HTTP_TIMEOUT_MS. */
  timeoutSeconds?: number;
}

export function rssSource(cfg: RssSourceConfig): Source {
  const tier = cfg.tier ?? "official";
  const summaryChars = cfg.summaryChars ?? 300;
  const namespace = cfg.keyNamespace ?? cfg.id;

  function toDetection(item: FeedItem, detectedAt: string): Detection | null {
    const text = [item.title, item.summary?.slice(0, summaryChars)].filter(Boolean).join(". ");
    const c = classify(text, { level: cfg.level, state: cfg.state }) ?? (cfg.mode === "declarations" ? assumedDeclaration(item.title, cfg.level, cfg.state) : null);
    if (!c) return null;
    const title = item.publisher && !item.title.endsWith(item.publisher) ? `${item.title} - ${item.publisher}` : item.title;
    return {
      key: `${namespace}:${item.id}`,
      sourceId: cfg.id,
      sourceName: item.publisher ? `${cfg.name} / ${item.publisher}` : cfg.name,
      tier,
      level: c.level,
      kind: c.kind,
      status: c.status,
      title,
      url: item.link,
      state: c.state,
      publishedAt: item.publishedAt,
      detectedAt,
      summary: item.summary,
    };
  }

  return {
    id: cfg.id,
    name: cfg.name,
    tier,
    state: cfg.state,
    intervalMs: (cfg.intervalSeconds ?? 60) * 1000,
    maxAgeHours: cfg.maxAgeHours ?? 48,
    async poll() {
      const xml = await fetchText(cfg.url, {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        browserUserAgent: cfg.browserUserAgent,
        timeoutMs: cfg.timeoutSeconds ? cfg.timeoutSeconds * 1000 : undefined,
      });
      if (xml === null) return null;
      const detectedAt = new Date().toISOString();
      const items = parseFeed(xml);
      return {
        detections: items.map((item) => toDetection(item, detectedAt)).filter((d): d is Detection => d !== null),
        items: items.map((item) => item.id),
      };
    },
  };
}

export interface NewsQueryConfig {
  id: string;
  query: string;
  intervalSeconds?: number;
}

/** Google News search feed. Catches county/city declarations that have no machine-readable official feed. */
export function googleNewsSource(cfg: NewsQueryConfig): Source {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cfg.query)}&hl=en-US&gl=US&ceid=US:en`;
  return rssSource({
    id: cfg.id,
    name: "Google News",
    url,
    tier: "news",
    intervalSeconds: cfg.intervalSeconds ?? 60,
    maxAgeHours: 24,
    summaryChars: 0,
    keyNamespace: "google-news",
  });
}
