export type Level = "federal" | "state" | "local";

/** "official" = published by a government body; "news" = press report of a declaration. */
export type Tier = "official" | "news";

export type Status = "declared" | "amended" | "renewed" | "requested";

export type Kind =
  | "major_disaster"
  | "emergency"
  | "fire_management"
  | "sba_disaster"
  | "state_emergency"
  | "local_emergency"
  | "other";

export interface Detection {
  /** Stable, unique id for this item within its source. */
  key: string;
  sourceId: string;
  sourceName: string;
  tier: Tier;
  level: Level;
  kind: Kind;
  status: Status;
  title: string;
  url?: string;
  /** USPS state/territory code, when known. */
  state?: string;
  /** Authoritative identifier such as "DR-4945-TX", used to merge duplicates exactly. */
  ref?: string;
  publishedAt?: string;
  detectedAt: string;
  summary?: string;
}

export interface PollResult {
  detections: Detection[];
  /** Keys of everything the source currently lists, declaration or not. Feeds the daily activity digest. */
  items: string[];
}

export interface Source {
  id: string;
  name: string;
  tier: Tier;
  /** USPS code of the state or territory that runs this endpoint. */
  state?: string;
  intervalMs: number;
  /** Items older than this are recorded but never alerted on. */
  maxAgeHours: number;
  /** Resolves to null when the source reports nothing changed (HTTP 304). */
  poll(): Promise<PollResult | null>;
}

export type AlertType = "new" | "confirmed" | "amended";

export interface EventRecord {
  id: number;
  state: string | null;
  level: Level;
  kind: Kind;
  status: Status;
  title: string;
  tokens: string[];
  ref: string | null;
  official: boolean;
  firstSeen: string;
  lastSeen: string;
  sourceCount: number;
  firstUrl: string | null;
  firstSource: string;
}

export interface Alert {
  type: AlertType;
  event: EventRecord;
  detection: Detection;
  /** Seconds between the source's publish time and our detection, when known. */
  latencySeconds?: number;
}
