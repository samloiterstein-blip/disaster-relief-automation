import { fetchJson } from "../http.ts";
import { stateName } from "../states.ts";
import type { Store } from "../store.ts";
import type { Detection, Kind, Source } from "../types.ts";

const BASE = "https://www.fema.gov/api/open";

export const TYPE: Record<string, { prefix: string; kind: Kind; label: string }> = {
  "Major Disaster": { prefix: "DR", kind: "major_disaster", label: "Major disaster declaration" },
  Emergency: { prefix: "EM", kind: "emergency", label: "Emergency declaration" },
  "Fire Management": { prefix: "FM", kind: "fire_management", label: "Fire management assistance declaration" },
  DR: { prefix: "DR", kind: "major_disaster", label: "Major disaster declaration" },
  EM: { prefix: "EM", kind: "emergency", label: "Emergency declaration" },
  FM: { prefix: "FM", kind: "fire_management", label: "Fire management assistance declaration" },
};

function query(entity: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${BASE}/${entity}?${qs}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/** Inclusive ISO date-time range for replaying a past period instead of watching the last 60 days. */
export interface DateWindow {
  from: string;
  to: string;
}

function dateFilter(window?: DateWindow): string {
  return window ? `declarationDate ge '${window.from}' and declarationDate le '${window.to}'` : `declarationDate ge '${daysAgo(60)}'`;
}

function programs(r: { iaProgramDeclared?: boolean; ihProgramDeclared?: boolean; paProgramDeclared?: boolean; hmProgramDeclared?: boolean }): string {
  const p = [
    r.iaProgramDeclared || r.ihProgramDeclared ? "Individual Assistance" : null,
    r.paProgramDeclared ? "Public Assistance" : null,
    r.hmProgramDeclared ? "Hazard Mitigation" : null,
  ].filter(Boolean);
  return p.length ? p.join(", ") : "none listed";
}

interface WebDeclaration {
  disasterNumber: number;
  declarationDate: string;
  disasterName: string;
  declarationType: string;
  stateCode: string;
  incidentType: string;
  disasterPageUrl: string;
  iaProgramDeclared: boolean;
  ihProgramDeclared: boolean;
  paProgramDeclared: boolean;
  hmProgramDeclared: boolean;
}

/** One record per declaration (DR / EM / FM). Authoritative, but FEMA publishes it in a daily batch. */
export function openFemaDeclarations(opts: { intervalSeconds?: number; window?: DateWindow } = {}): Source {
  const id = "openfema-declarations";
  const name = "FEMA (OpenFEMA declarations)";
  return {
    id,
    name,
    tier: "official",
    intervalMs: (opts.intervalSeconds ?? 60) * 1000,
    maxAgeHours: 24 * 21,
    async poll() {
      const url = query("v1/FemaWebDisasterDeclarations", {
        $filter: dateFilter(opts.window),
        $orderby: "declarationDate desc",
        $top: "1000",
      });
      const body = await fetchJson<{ FemaWebDisasterDeclarations: WebDeclaration[] }>(url);
      if (!body) return null;
      const detectedAt = new Date().toISOString();
      const detections = body.FemaWebDisasterDeclarations.map((r): Detection => {
        const t = TYPE[r.declarationType] ?? { prefix: "??", kind: "other" as Kind, label: r.declarationType };
        const ref = `${t.prefix}-${r.disasterNumber}-${r.stateCode}`;
        return {
          key: `${id}:${ref}`,
          sourceId: id,
          sourceName: name,
          tier: "official",
          level: "federal",
          kind: t.kind,
          status: "declared",
          title: `${t.label} ${ref}: ${r.disasterName} (${stateName(r.stateCode)})`,
          url: r.disasterPageUrl,
          state: r.stateCode,
          ref,
          publishedAt: r.declarationDate,
          detectedAt,
          summary: `Incident: ${r.incidentType}. Programs: ${programs(r)}.`,
        };
      });
      return { detections, items: detections.map((d) => d.ref!) };
    },
  };
}

interface AreaRecord {
  id: string;
  femaDeclarationString: string;
  disasterNumber: number;
  state: string;
  declarationType: string;
  declarationDate: string;
  declarationTitle: string;
  designatedArea: string;
  incidentType: string;
  iaProgramDeclared: boolean;
  ihProgramDeclared: boolean;
  paProgramDeclared: boolean;
  hmProgramDeclared: boolean;
}

/**
 * County-level designations. Emits one detection per declaration whenever new
 * counties/tribal areas appear, so expansions of existing declarations are alerted too.
 */
export function openFemaDesignatedAreas(store: Store, opts: { intervalSeconds?: number; window?: DateWindow } = {}): Source {
  const id = "openfema-areas";
  const name = "FEMA (OpenFEMA designated areas)";
  return {
    id,
    name,
    tier: "official",
    intervalMs: (opts.intervalSeconds ?? 120) * 1000,
    maxAgeHours: 24 * 60,
    async poll() {
      const url = query("v2/DisasterDeclarationsSummaries", {
        $filter: dateFilter(opts.window),
        $orderby: "declarationDate desc",
        $top: "5000",
      });
      const body = await fetchJson<{ DisasterDeclarationsSummaries: AreaRecord[] }>(url);
      if (!body) return null;

      const fresh = new Map<string, AreaRecord[]>();
      for (const r of body.DisasterDeclarationsSummaries) {
        const areaKey = `${id}:area:${r.id}`;
        if (store.hasSeen(areaKey)) continue;
        store.markSeen(areaKey, id);
        fresh.set(r.femaDeclarationString, [...(fresh.get(r.femaDeclarationString) ?? []), r]);
      }

      const detectedAt = new Date().toISOString();
      const detections = [...fresh.entries()].map(([ref, rows]): Detection => {
        const r = rows[0];
        const t = TYPE[r.declarationType] ?? { prefix: "??", kind: "other" as Kind, label: r.declarationType };
        const refKey = `${id}:ref:${ref}`;
        const existing = store.hasSeen(refKey);
        store.markSeen(refKey, id);
        const areas = rows.map((x) => x.designatedArea).sort();
        return {
          key: `${id}:${ref}:${rows.map((x) => x.id).sort().join(",")}`,
          sourceId: id,
          sourceName: name,
          tier: "official",
          level: "federal",
          kind: t.kind,
          status: existing ? "amended" : "declared",
          title: existing
            ? `${ref} expanded: ${areas.length} area(s) added in ${stateName(r.state)}`
            : `${t.label} ${ref}: ${r.declarationTitle} (${stateName(r.state)})`,
          url: `https://www.fema.gov/disaster/${r.disasterNumber}`,
          state: r.state,
          ref,
          publishedAt: r.declarationDate,
          detectedAt,
          summary: `Designated areas: ${areas.join("; ")}. Programs: ${programs(r)}.`,
        };
      });
      return { detections, items: body.DisasterDeclarationsSummaries.map((r) => r.id) };
    },
  };
}
