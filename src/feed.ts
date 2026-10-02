import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  id: string;
  title: string;
  link?: string;
  summary?: string;
  publishedAt?: string;
  /** Publisher name, e.g. the <source> element in Google News items. */
  publisher?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
});

function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  return undefined;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function atomLink(link: unknown): string | undefined {
  const links = toArray(link as Record<string, string> | Record<string, string>[]);
  const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
  return alt?.["@href"];
}

/** Parse RSS 2.0, RSS 1.0 (RDF), or Atom into a flat item list. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml);

  const rssItems = doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item;
  if (rssItems) {
    return toArray(rssItems).map((it: Record<string, unknown>) => {
      const title = stripHtml(text(it.title)) ?? "";
      const link = text(it.link)?.trim();
      return {
        id: text(it.guid)?.trim() || link || title,
        title,
        link,
        summary: stripHtml(text(it.description) ?? text(it["content:encoded"])),
        publishedAt: isoDate(text(it.pubDate) ?? text(it["dc:date"])),
        publisher: text(it.source),
      };
    });
  }

  const entries = doc.feed?.entry;
  if (entries) {
    return toArray(entries).map((it: Record<string, unknown>) => {
      const title = stripHtml(text(it.title)) ?? "";
      const link = atomLink(it.link);
      return {
        id: text(it.id)?.trim() || link || title,
        title,
        link,
        summary: stripHtml(text(it.summary) ?? text(it.content)),
        publishedAt: isoDate(text(it.published) ?? text(it.updated)),
      };
    });
  }

  return [];
}
