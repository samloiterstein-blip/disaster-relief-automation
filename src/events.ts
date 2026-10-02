import { similarity, tokenize } from "./classify.ts";
import type { Store } from "./store.ts";
import type { Alert, Detection, EventRecord, Kind } from "./types.ts";

const HOUR = 3600_000;
/** OpenFEMA lags declarations by days, so federal events stay open for matching longer. */
const WINDOW_HOURS = { federal: 240, state: 72, local: 72 } as const;
const STATE_PRESS_WINDOW_HOURS = 48;

const HAZARDS: Array<[string, RegExp]> = [
  ["weather", /\b(?:flood\w*|rain\w*|storms?|severe weather|el ni[nñ]o|atmospheric river|mudslides?|landslides?|hurricane|tropical|typhoon|tornado\w*|winds?)\b/i],
  ["winter", /\b(?:winter|snow\w*|ice|icy|blizzard|freez\w*|cold)\b/i],
  ["fire", /\b(?:fires?|wildfires?|smoke|red flag)\b/i],
  ["drought", /\b(?:drought|water shortage)\b/i],
  ["fuel", /\b(?:fuel|diesel|gas|gasoline|propane|energy|power outages?|pipeline)\b/i],
  ["heat", /\b(?:heat|heatwave)\b/i],
  ["earthquake", /\b(?:earthquake|quake)\b/i],
  ["health", /\b(?:disease|outbreak|dengue|measles|covid|opioid|overdose|public health)\b/i],
  ["cyber", /\b(?:cyber\w*|ransomware)\b/i],
];

function hazards(title: string): Set<string> {
  return new Set(HAZARDS.filter(([, re]) => re.test(title)).map(([h]) => h));
}

/** "Merced County", "St. Tammany Parish": the one- and two-word forms, so "Newsom Merced County" still matches. */
export function places(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\b(?:([A-Z][\w'.-]*) )?([A-Z][\w'.-]*) (County|Parish|Borough)\b/g)) {
    const suffix = m[3].toLowerCase();
    out.add(`${m[2]} ${suffix}`.toLowerCase());
    if (m[1]) out.add(`${m[1]} ${m[2]} ${suffix}`.toLowerCase());
  }
  return out;
}

function kindsCompatible(a: Kind, b: Kind): boolean {
  if (a === b) return true;
  const federal = new Set<Kind>(["major_disaster", "emergency"]);
  return federal.has(a) && federal.has(b);
}

function score(ev: EventRecord, d: Detection, tokens: string[], now: number): number {
  if (ev.level !== d.level) return 0;
  if (now - Date.parse(ev.lastSeen) > WINDOW_HOURS[ev.level] * HOUR) return 0;
  if (ev.ref && d.ref && ev.ref !== d.ref) return 0;
  if ((ev.status === "requested") !== (d.status === "requested")) return 0;

  const bothStates = !!ev.state && !!d.state;
  if (bothStates && ev.state !== d.state) return 0;
  const sim = similarity(ev.tokens, tokens);

  // A press report of a federal approval and FEMA's own record rarely share wording,
  // so link them on state + declaration type instead.
  if (d.level === "federal" && bothStates && (!!ev.ref !== !!d.ref) && kindsCompatible(ev.kind, d.kind)) return 1 + sim;
  // Outlets reword the same governor action ("declares emergency, eases diesel rules" vs "signs order cutting
  // fuel restrictions"), so press reports in one state are matched on the hazard instead of the wording.
  const pressInvolved = d.tier === "news" || !ev.official;
  if (d.level === "state" && bothStates && pressInvolved && now - Date.parse(ev.lastSeen) <= STATE_PRESS_WINDOW_HOURS * HOUR) {
    const ha = hazards(ev.title);
    const hb = hazards(d.title);
    if ([...ha].some((h) => hb.has(h))) return 0.5 + sim;
    if ((!ha.size || !hb.size) && sim >= 0.1) return 0.3 + sim;
  }
  // Local stories often name the county but not the state; the same county plus the same hazard is the same event.
  if (d.level === "local") {
    const pb = places(d.title);
    if ([...places(ev.title)].some((p) => pb.has(p))) {
      const hb = hazards(d.title);
      if ([...hazards(ev.title)].some((h) => hb.has(h)) || sim >= 0.2) return 0.5 + sim;
    }
  }
  if (bothStates) return sim >= 0.35 ? sim : 0;
  return sim >= 0.6 ? sim : 0;
}

/**
 * Merge a detection into the event log.
 * Returns an alert for genuinely new events, or when an official source first confirms a news-only event.
 */
export function ingest(store: Store, d: Detection): Alert | null {
  const tokens = tokenize(d.title);
  const latencySeconds = d.publishedAt ? Math.max(0, Math.round((Date.parse(d.detectedAt) - Date.parse(d.publishedAt)) / 1000)) : undefined;

  let match: EventRecord | undefined = d.ref ? store.eventByRef(d.ref) : undefined;
  if (!match) {
    const now = Date.parse(d.detectedAt);
    const since = new Date(now - WINDOW_HOURS.federal * HOUR).toISOString();
    let best = 0;
    for (const ev of store.recentEvents(since)) {
      const s = score(ev, d, tokens, now);
      if (s > best) {
        best = s;
        match = ev;
      }
    }
  }

  if (!match) {
    return { type: "new", event: store.createEvent(d, tokens), detection: d, latencySeconds };
  }

  const wasOfficial = match.official;
  const event = store.corroborate(match.id, d);
  if (!wasOfficial && d.tier === "official") return { type: "confirmed", event, detection: d, latencySeconds };
  // Press coverage of an expansion repeats across outlets; only official expansions alert.
  if (d.status === "amended" && d.tier === "official") return { type: "amended", event, detection: d, latencySeconds };
  return null;
}
