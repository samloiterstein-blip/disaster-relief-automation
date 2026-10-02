import { readFileSync } from "node:fs";
import type { Store } from "../store.ts";
import type { Source } from "../types.ts";
import { jsonSource, type JsonSourceConfig } from "./json.ts";
import { openFemaDeclarations, openFemaDesignatedAreas } from "./openfema.ts";
import { pageSource, type PageSourceConfig } from "./page.ts";
import { googleNewsSource, rssSource, type NewsQueryConfig, type RssSourceConfig } from "./rss.ts";
import { sbaDeclarations } from "./sba.ts";

type SourceEntry =
  | { type: "openfema-declarations" | "openfema-areas" | "sba-declarations"; enabled?: boolean; intervalSeconds?: number }
  | ({ type: "rss"; enabled?: boolean } & RssSourceConfig)
  | ({ type: "page"; enabled?: boolean } & PageSourceConfig)
  | ({ type: "json"; enabled?: boolean } & JsonSourceConfig)
  | ({ type: "google-news"; enabled?: boolean } & NewsQueryConfig);

export function loadSources(file: string, store: Store): Source[] {
  const entries = JSON.parse(readFileSync(file, "utf8")).sources as SourceEntry[];
  const ids = new Set<string>();
  const sources: Source[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue;
    const src =
      e.type === "openfema-declarations" ? openFemaDeclarations(e)
      : e.type === "openfema-areas" ? openFemaDesignatedAreas(store, e)
      : e.type === "sba-declarations" ? sbaDeclarations(e)
      : e.type === "rss" ? rssSource(e)
      : e.type === "page" ? pageSource(e, store)
      : e.type === "json" ? jsonSource(e)
      : e.type === "google-news" ? googleNewsSource(e)
      : null;
    if (!src) throw new Error(`Unknown source type in ${file}: ${JSON.stringify(e)}`);
    if (ids.has(src.id)) throw new Error(`Duplicate source id "${src.id}" in ${file}`);
    ids.add(src.id);
    sources.push(src);
  }
  return sources;
}
