import { ingest } from "./events.ts";
import type { Store } from "./store.ts";
import type { Alert, Source } from "./types.ts";

export interface SourceHealth {
  id: string;
  name: string;
  tier: string;
  intervalSeconds: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveErrors: number;
  lastDurationMs?: number;
  lastItemCount?: number;
  healthy: boolean;
}

const MAX_BACKOFF_MS = 15 * 60_000;

export class Scheduler {
  health = new Map<string, SourceHealth>();
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private store: Store;
  private sources: Source[];
  private onAlert: (a: Alert) => Promise<void>;

  constructor(store: Store, sources: Source[], onAlert: (a: Alert) => Promise<void>) {
    this.store = store;
    this.sources = sources;
    this.onAlert = onAlert;
    for (const s of sources) {
      this.health.set(s.id, { id: s.id, name: s.name, tier: s.tier, intervalSeconds: s.intervalMs / 1000, consecutiveErrors: 0, healthy: false });
    }
  }

  /** Poll one source and route anything new. The first successful poll of a source only records a baseline. */
  async runOnce(src: Source): Promise<Alert[]> {
    const h = this.health.get(src.id)!;
    const started = Date.now();
    const alerts: Alert[] = [];
    try {
      const baselined = this.store.isBaselined(src.id);
      const result = await src.poll();
      const detections = result?.detections ?? [];
      if (result) {
        // Sources baselined before item tracking existed get a silent item baseline too.
        const itemBaseline = `items-baselined:${src.id}`;
        const firstItems = !this.store.getMeta(itemBaseline);
        this.store.noteItems(src.id, result.items, baselined && firstItems ? this.store.baselineAt(src.id) : undefined);
        if (firstItems) this.store.setMeta(itemBaseline, "1");
      }
      for (const d of detections) {
        if (this.store.hasSeen(d.key)) continue;
        this.store.markSeen(d.key, src.id);
        const alert = ingest(this.store, d);
        const age = d.publishedAt ? started - Date.parse(d.publishedAt) : 0;
        if (alert && baselined && age <= src.maxAgeHours * 3600_000) alerts.push(alert);
      }
      if (!baselined && result) {
        this.store.markBaselined(src.id);
        console.log(`[baseline] ${src.id}: recorded ${result.items.length} existing item(s) without alerting`);
      }
      this.store.recordPoll(src.id, true);
      h.lastSuccessAt = new Date().toISOString();
      h.consecutiveErrors = 0;
      if (result) h.lastItemCount = detections.length;
    } catch (err) {
      h.consecutiveErrors++;
      h.lastErrorAt = new Date().toISOString();
      h.lastError = err instanceof Error ? err.message : String(err);
      this.store.recordPoll(src.id, false, h.lastError);
      console.error(`[poll] ${src.id} failed (${h.consecutiveErrors}x): ${h.lastError}`);
    }
    h.lastDurationMs = Date.now() - started;
    h.healthy = !!h.lastSuccessAt && Date.now() - Date.parse(h.lastSuccessAt) < Math.max(src.intervalMs * 5, 10 * 60_000);

    for (const a of alerts) {
      this.store.logAlert(a);
      await this.onAlert(a);
    }
    return alerts;
  }

  /**
   * Polls every source once, a few at a time, then retries failures once after a pause so a
   * transient network error isn't reported as a broken connection. Used by one-shot runs.
   */
  async runAll(opts: { concurrency?: number; retryDelayMs?: number } = {}): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const runBatch = async (batch: Source[]) => {
      const queue = [...batch];
      await Promise.all(
        Array.from({ length: Math.min(opts.concurrency ?? 16, queue.length) }, async () => {
          for (let src = queue.shift(); src; src = queue.shift()) alerts.push(...(await this.runOnce(src)));
        }),
      );
    };
    await runBatch(this.sources);
    const failed = this.sources.filter((s) => this.health.get(s.id)!.consecutiveErrors > 0);
    if (failed.length) {
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 10_000));
      await runBatch(failed);
    }
    return alerts;
  }

  start(): void {
    this.sources.forEach((src, i) => {
      // Stagger start-up so dozens of feeds don't fire in the same second.
      this.schedule(src, Math.min(i * 250, src.intervalMs));
    });
  }

  private schedule(src: Source, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      await this.runOnce(src);
      const errors = this.health.get(src.id)!.consecutiveErrors;
      const base = errors ? Math.min(src.intervalMs * 2 ** errors, MAX_BACKOFF_MS) : src.intervalMs;
      const jitter = base * 0.1 * Math.random();
      this.schedule(src, base + jitter);
    }, delayMs);
    this.timers.add(timer);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
