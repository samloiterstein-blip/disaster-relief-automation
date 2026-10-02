import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Alert, Detection, EventRecord, Kind, Level, Status } from "./types.ts";

export interface AlertRow {
  id: number;
  at: string;
  type: Alert["type"];
  status: Status;
  level: Level;
  kind: Kind;
  state: string | null;
  official: number;
  event_id: number;
  source_id: string;
  source_name: string;
  title: string;
  url: string | null;
}

export interface SourceActivity {
  newItems: number;
  detections: number;
  pollsOk: number;
  pollsFailed: number;
  lastError?: string;
}

interface EventRow {
  id: number;
  state: string | null;
  level: string;
  kind: string;
  status: string;
  title: string;
  tokens: string;
  ref: string | null;
  official: number;
  first_seen: string;
  last_seen: string;
  source_count: number;
  first_url: string | null;
  first_source: string;
}

function toEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    state: r.state,
    level: r.level as EventRecord["level"],
    kind: r.kind as EventRecord["kind"],
    status: r.status as EventRecord["status"],
    title: r.title,
    tokens: JSON.parse(r.tokens),
    ref: r.ref,
    official: r.official === 1,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    sourceCount: r.source_count,
    firstUrl: r.first_url,
    firstSource: r.first_source,
  };
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (
        key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        first_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS baselined (
        source_id TEXT PRIMARY KEY,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        tokens TEXT NOT NULL,
        ref TEXT,
        official INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 1,
        first_url TEXT,
        first_source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_last_seen ON events(last_seen);
      CREATE UNIQUE INDEX IF NOT EXISTS events_ref ON events(ref) WHERE ref IS NOT NULL;
      CREATE TABLE IF NOT EXISTS detections (
        key TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id),
        source_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        published_at TEXT,
        detected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS detections_source ON detections(source_id, detected_at);
      CREATE TABLE IF NOT EXISTS items (
        source_id TEXT NOT NULL,
        key TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (source_id, key)
      );
      CREATE INDEX IF NOT EXISTS items_first_seen ON items(first_seen);
      CREATE TABLE IF NOT EXISTS poll_stats (
        source_id TEXT NOT NULL,
        hour TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (source_id, hour)
      );
      CREATE INDEX IF NOT EXISTS poll_stats_hour ON poll_stats(hour);
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT,
        official INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT
      );
      CREATE INDEX IF NOT EXISTS alerts_at ON alerts(at);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Record everything a source currently lists. Returns how many keys were new. */
  noteItems(sourceId: string, keys: string[], at = new Date().toISOString()): number {
    const insert = this.db.prepare("INSERT OR IGNORE INTO items (source_id, key, first_seen) VALUES (?, ?, ?)");
    let added = 0;
    this.db.exec("BEGIN");
    try {
      for (const key of keys) added += Number(insert.run(sourceId, key, at).changes);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }

  recordPoll(sourceId: string, ok: boolean, error?: string, at = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO poll_stats (source_id, hour, ok, failed, last_error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_id, hour) DO UPDATE SET
           ok = ok + excluded.ok,
           failed = failed + excluded.failed,
           last_error = COALESCE(excluded.last_error, last_error)`,
      )
      .run(sourceId, at.slice(0, 13), ok ? 1 : 0, ok ? 0 : 1, error ?? null);
  }

  logAlert(a: Alert): void {
    this.db
      .prepare(
        `INSERT INTO alerts (at, type, status, level, kind, state, official, event_id, source_id, source_name, title, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.detection.detectedAt,
        a.type,
        a.detection.status,
        a.event.level,
        a.event.kind,
        a.event.state ?? a.detection.state ?? null,
        a.event.official ? 1 : 0,
        a.event.id,
        a.detection.sourceId,
        a.detection.sourceName,
        a.detection.title,
        a.detection.url ?? null,
      );
  }

  alertsBetween(since: string, until: string): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE at >= ? AND at < ? ORDER BY at").all(since, until) as unknown as AlertRow[];
  }

  /**
   * Per-source activity in a window. Anything recorded during a source's
   * first (baseline) poll predates its baseline timestamp and is excluded.
   */
  activityBetween(since: string, until: string): Map<string, SourceActivity> {
    const out = new Map<string, SourceActivity>();
    const get = (id: string) => {
      let a = out.get(id);
      if (!a) out.set(id, (a = { newItems: 0, detections: 0, pollsOk: 0, pollsFailed: 0 }));
      return a;
    };
    const items = this.db
      .prepare(
        `SELECT i.source_id AS id, COUNT(*) AS n FROM items i JOIN baselined b ON b.source_id = i.source_id
         WHERE i.first_seen >= ? AND i.first_seen < ? AND i.first_seen > b.at GROUP BY i.source_id`,
      )
      .all(since, until) as Array<{ id: string; n: number }>;
    for (const r of items) get(r.id).newItems = r.n;

    const detections = this.db
      .prepare(
        `SELECT d.source_id AS id, COUNT(*) AS n FROM detections d JOIN baselined b ON b.source_id = d.source_id
         WHERE d.detected_at >= ? AND d.detected_at < ? AND d.detected_at > b.at GROUP BY d.source_id`,
      )
      .all(since, until) as Array<{ id: string; n: number }>;
    for (const r of detections) get(r.id).detections = r.n;

    const polls = this.db
      .prepare(
        `SELECT source_id AS id, SUM(ok) AS ok, SUM(failed) AS failed,
           (SELECT last_error FROM poll_stats p2 WHERE p2.source_id = p.source_id AND p2.failed > 0 AND p2.hour >= ? AND p2.hour <= ?
            ORDER BY p2.hour DESC LIMIT 1) AS lastError
         FROM poll_stats p WHERE hour >= ? AND hour <= ? GROUP BY source_id`,
      )
      .all(since.slice(0, 13), until.slice(0, 13), since.slice(0, 13), until.slice(0, 13)) as Array<{ id: string; ok: number; failed: number; lastError: string | null }>;
    for (const r of polls) {
      const a = get(r.id);
      a.pollsOk = r.ok;
      a.pollsFailed = r.failed;
      if (r.lastError) a.lastError = r.lastError;
    }
    return out;
  }

  pruneStats(before: string): void {
    this.db.prepare("DELETE FROM poll_stats WHERE hour < ?").run(before.slice(0, 13));
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  hasSeen(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen WHERE key = ?").get(key) !== undefined;
  }

  markSeen(key: string, sourceId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO seen (key, source_id, first_seen) VALUES (?, ?, ?)").run(key, sourceId, new Date().toISOString());
  }

  isBaselined(sourceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM baselined WHERE source_id = ?").get(sourceId) !== undefined;
  }

  baselineAt(sourceId: string): string | undefined {
    return (this.db.prepare("SELECT at FROM baselined WHERE source_id = ?").get(sourceId) as { at: string } | undefined)?.at;
  }

  markBaselined(sourceId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO baselined (source_id, at) VALUES (?, ?)").run(sourceId, new Date().toISOString());
  }

  recentEvents(sinceIso: string): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events WHERE last_seen >= ? ORDER BY id DESC").all(sinceIso) as unknown as EventRow[]).map(toEvent);
  }

  latestEvents(limit: number): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as EventRow[]).map(toEvent);
  }

  eventByRef(ref: string): EventRecord | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE ref = ?").get(ref) as unknown as EventRow | undefined;
    return row && toEvent(row);
  }

  createEvent(d: Detection, tokens: string[]): EventRecord {
    const now = d.detectedAt;
    const res = this.db
      .prepare(
        `INSERT INTO events (state, level, kind, status, title, tokens, ref, official, first_seen, last_seen, first_url, first_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.state ?? null, d.level, d.kind, d.status, d.title, JSON.stringify(tokens), d.ref ?? null, d.tier === "official" ? 1 : 0, now, now, d.url ?? null, d.sourceName);
    this.attach(Number(res.lastInsertRowid), d);
    return this.getEvent(Number(res.lastInsertRowid));
  }

  /** Attach a corroborating detection. Upgrades the event with official status, a ref, or a known state. */
  corroborate(eventId: number, d: Detection): EventRecord {
    this.db
      .prepare(
        `UPDATE events SET
           last_seen = ?,
           source_count = source_count + 1,
           official = MAX(official, ?),
           ref = COALESCE(ref, ?),
           state = COALESCE(state, ?),
           status = CASE WHEN status = 'requested' AND ? != 'requested' THEN ? ELSE status END
         WHERE id = ?`,
      )
      .run(d.detectedAt, d.tier === "official" ? 1 : 0, d.ref ?? null, d.state ?? null, d.status, d.status, eventId);
    this.attach(eventId, d);
    return this.getEvent(eventId);
  }

  getEvent(id: number): EventRecord {
    return toEvent(this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as unknown as EventRow);
  }

  private attach(eventId: number, d: Detection): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO detections (key, event_id, source_id, tier, title, url, published_at, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.key, eventId, d.sourceId, d.tier, d.title, d.url ?? null, d.publishedAt ?? null, d.detectedAt);
  }
}
