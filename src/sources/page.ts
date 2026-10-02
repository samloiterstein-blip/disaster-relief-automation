import { parse } from "node-html-parser";
import { assumedDeclaration, classify } from "../classify.ts";
import { readDocument, stripChrome } from "../documents.ts";
import { fetchText } from "../http.ts";
import type { Store } from "../store.ts";
import type { Detection, Level, Source, Tier } from "../types.ts";

export interface PageSourceConfig {
  id: string;
  name: string;
  url: string;
  state?: string;
  level?: Level;
  tier?: Tier;
  intervalSeconds?: number;
  /** CSS selector for the region that lists items. Defaults to the whole page minus nav/header/footer. */
  selector?: string;
  /** Only links whose absolute URL matches this regex count as items. */
  linkPattern?: string;
  /** Only links whose text matches this regex count as items (e.g. Colorado's "D 2026 ###" disaster orders). */
  textPattern?: string;
  /**
   * "classify": alert only when a new link (or the document behind it) reads as a declaration.
   * "declarations": the page only lists declarations, so any new document link alerts.
   */
  mode?: "classify" | "declarations";
  /** Open new links that don't classify on their headline alone. Needed for pages of bare "EO 26-14" links. */
  inspect?: boolean;
  browserUserAgent?: boolean;
  /** For slow listing pages; defaults to HTTP_TIMEOUT_MS. */
  timeoutSeconds?: number;
}

const MAX_INSPECTIONS_PER_POLL = 5;
const GENERIC_TEXT = /^(?:read more|learn more|more|click here|here|download|view|details|continue reading|full (?:story|release)|pdf|english|español|share|print|next|previous|\d+)$/i;
const DOCUMENT_TEXT = /\b(?:proclamation|declaration|emergency|disaster|executive order|order no|eo\s?\d|\d{2,4}-\d{1,4})\b/i;
const TRACKING_PARAMS = /^(?:utm_\w+|fbclid|gclid|jsessionid|sessionid|sid)$/i;

function normalizeHref(href: string, base: string): string | null {
  if (/^(?:mailto|tel|javascript|data):/i.test(href) || href.startsWith("#")) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Listing pages carry no dates, and a layout change can surface years-old documents as "new" links.
 * When every year in the URL and title is in the past, date the item Dec 31 of that year so the age limit drops it.
 */
export function pastYearDate(text: string, now = new Date()): string | undefined {
  const current = now.getUTCFullYear();
  const years = [...text.matchAll(/(?<!\d)(20\d\d)(?!\d)/g)].map((m) => Number(m[1])).filter((y) => y <= current);
  if (!years.length) return undefined;
  const latest = Math.max(...years);
  return latest < current ? `${latest}-12-31T23:59:59.000Z` : undefined;
}

/** Extract { href -> best link text } from a listing page. */
export function extractLinks(html: string, base: string, selector?: string, linkPattern?: RegExp): Map<string, string> {
  const root = stripChrome(parse(html));
  const scopes = selector ? root.querySelectorAll(selector) : [root.querySelector("body") ?? root];
  const links = new Map<string, string>();
  for (const scope of scopes) {
    for (const a of scope.querySelectorAll("a[href]")) {
      const href = normalizeHref(a.getAttribute("href") ?? "", base);
      if (!href || href === base) continue;
      if (linkPattern && !linkPattern.test(href)) continue;
      const text = (a.text || a.getAttribute("title") || a.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\S*read[- ]more\S* about the article:\s*/i, "");
      const prev = links.get(href) ?? "";
      if (text.length < 3 || GENERIC_TEXT.test(text)) {
        if (!links.has(href)) links.set(href, "");
      } else if (text.length > prev.length) {
        links.set(href, text.slice(0, 300));
      }
    }
  }
  return links;
}

/**
 * Watches an HTML listing page (press releases, executive orders, emergency
 * proclamations) for links that weren't there before.
 */
export function pageSource(cfg: PageSourceConfig, store: Store): Source {
  const level = cfg.level ?? "state";
  const tier = cfg.tier ?? "official";
  const mode = cfg.mode ?? "classify";
  const inspect = cfg.inspect ?? true;
  const pattern = cfg.linkPattern ? new RegExp(cfg.linkPattern, "i") : undefined;
  const textPattern = cfg.textPattern ? new RegExp(cfg.textPattern, "i") : undefined;
  const hints = { level, state: cfg.state };

  return {
    id: cfg.id,
    name: cfg.name,
    tier,
    state: cfg.state,
    intervalMs: (cfg.intervalSeconds ?? 60) * 1000,
    maxAgeHours: 72,
    async poll() {
      const html = await fetchText(cfg.url, {
        accept: "text/html,application/xhtml+xml",
        browserUserAgent: cfg.browserUserAgent,
        timeoutMs: cfg.timeoutSeconds ? cfg.timeoutSeconds * 1000 : undefined,
      });
      if (html === null) return null;
      const links = extractLinks(html, cfg.url, cfg.selector, pattern);
      if (textPattern) for (const [href, text] of links) if (!textPattern.test(text)) links.delete(href);
      if (links.size === 0) throw new Error("no matching links found; page layout may have changed or requires JavaScript");

      const baselined = store.isBaselined(cfg.id);
      const detectedAt = new Date().toISOString();
      const detections: Detection[] = [];
      let inspections = 0;

      for (const [href, text] of links) {
        const seenKey = `${cfg.id}:link:${href}`;
        if (store.hasSeen(seenKey)) continue;
        if (!baselined) {
          store.markSeen(seenKey, cfg.id);
          continue;
        }

        let title = text;
        let c = text ? classify(text, hints) : null;
        let summary: string | undefined;

        if (!c && inspect) {
          // Leave the link unseen so the next poll inspects it.
          if (inspections >= MAX_INSPECTIONS_PER_POLL) continue;
          inspections++;
          try {
            const doc = await readDocument(href, { browserUserAgent: cfg.browserUserAgent });
            if (doc.title && (!title || title.length < 25)) title = title ? `${title}: ${doc.title}` : doc.title;
            summary = doc.text.slice(0, 500);
            c = classify([title, doc.text].filter(Boolean).join(". "), hints);
          } catch (err) {
            console.warn(`[page] ${cfg.id}: could not read ${href}: ${err instanceof Error ? err.message : err}`);
          }
        }
        store.markSeen(seenKey, cfg.id);
        if (!c && mode === "declarations" && (textPattern || pattern || DOCUMENT_TEXT.test(`${title} ${href}`))) c = assumedDeclaration(title, level, cfg.state);
        if (!c) continue;

        detections.push({
          key: `${cfg.id}:${href}`,
          sourceId: cfg.id,
          sourceName: cfg.name,
          tier,
          level: c.level,
          kind: c.kind,
          status: c.status,
          title: title || href,
          url: href,
          state: c.state,
          publishedAt: pastYearDate(`${href} ${title}`),
          detectedAt,
          summary,
        });
      }
      return { detections, items: [...links.keys()] };
    },
  };
}
