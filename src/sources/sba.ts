import { fetchJson } from "../http.ts";
import { extractState } from "../states.ts";
import type { Detection, Source } from "../types.ts";
import type { DateWindow } from "./openfema.ts";

const FR = "https://www.federalregister.gov/api/v1";
const SBA = "small-business-administration";

interface FrDocument {
  document_number: string;
  title: string;
  abstract?: string | null;
  html_url: string;
  publication_date?: string;
  filed_at?: string;
  agencies?: Array<{ slug?: string }>;
}

const DECLARATION_TITLE = /\bDeclaration\b.*\b(?:Disaster|Emergency)\b/i;

/**
 * SBA disaster declarations via the Federal Register. SBA "administrative"
 * declarations (EIDL, agency-only) never appear in FEMA data; presidential ones
 * carry the FEMA number and merge with the matching OpenFEMA event.
 */
export function sbaDeclarations(opts: { intervalSeconds?: number; window?: DateWindow } = {}): Source {
  const id = "sba-declarations";
  const name = "SBA (Federal Register)";

  function toDetection(doc: FrDocument, detectedAt: string): Detection | null {
    if (!DECLARATION_TITLE.test(doc.title)) return null;
    // A standing nationwide loan program that SBA republishes as a "Disaster Declaration" notice.
    if (/\bMilitary Reservist\b/i.test(doc.title)) return null;
    const text = `${doc.title}. ${doc.abstract ?? ""}`;
    const state = extractState(doc.title) ?? extractState(text);
    const presidential = /\bPresidential\b/i.test(doc.title);
    const amended = /\bAmendment\b/i.test(doc.title);
    const fema = text.match(/FEMA-\s?(\d{4})-(DR|EM)\b/i);
    const ref = presidential && fema && state ? `${fema[2].toUpperCase()}-${fema[1]}-${state}` : undefined;
    const incident = doc.abstract?.match(/Incident:\s*([^.]+)/i)?.[1];

    return {
      key: `${id}:${doc.document_number}`,
      sourceId: id,
      sourceName: name,
      tier: "official",
      level: "federal",
      kind: presidential ? (fema?.[2].toUpperCase() === "EM" ? "emergency" : "major_disaster") : "sba_disaster",
      // SBA's copies of FEMA amendments are paperwork; FEMA's own county data drives expansion alerts.
      status: amended && !presidential ? "amended" : "declared",
      title: incident ? `${doc.title} (${incident.trim()})` : doc.title,
      url: doc.html_url,
      state,
      ref,
      publishedAt: doc.filed_at ?? (doc.publication_date ? `${doc.publication_date}T00:00:00.000Z` : undefined),
      detectedAt,
      summary: doc.abstract ?? undefined,
    };
  }

  return {
    id,
    name,
    tier: "official",
    intervalMs: (opts.intervalSeconds ?? 300) * 1000,
    maxAgeHours: 24 * 14,
    async poll() {
      const fields = ["document_number", "title", "abstract", "html_url", "publication_date"].map((f) => `fields[]=${f}`).join("&");
      const dates = opts.window
        ? `&conditions[publication_date][gte]=${opts.window.from.slice(0, 10)}&conditions[publication_date][lte]=${opts.window.to.slice(0, 10)}`
        : "";
      const [published, inspection] = await Promise.all([
        fetchJson<{ results: FrDocument[] }>(`${FR}/documents.json?per_page=${opts.window ? 1000 : 100}&order=newest&conditions[agencies][]=${SBA}&conditions[type][]=NOTICE&${fields}${dates}`),
        // Documents sit on public inspection about a day before publication.
        opts.window ? null : fetchJson<{ results: FrDocument[] }>(`${FR}/public-inspection-documents/current.json`),
      ]);
      const docs = [
        ...(inspection?.results ?? []).filter((d) => d.agencies?.some((a) => a.slug === SBA)),
        ...(published?.results ?? []),
      ];
      const detectedAt = new Date().toISOString();
      return {
        detections: docs.map((d) => toDetection(d, detectedAt)).filter((d): d is Detection => d !== null),
        items: docs.map((d) => d.document_number),
      };
    },
  };
}
