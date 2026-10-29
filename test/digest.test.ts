import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigest, localClock } from "../src/digest.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";
import type { Detection, PollResult, Source } from "../src/types.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeSource(id: string, tier: Source["tier"], polls: Array<PollResult | Error | (() => PollResult)>): Source {
  let i = 0;
  return {
    id,
    name: `${id} name`,
    tier,
    intervalMs: 60_000,
    maxAgeHours: 48,
    async poll() {
      const next = polls[Math.min(i++, polls.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
  };
}

function declaration(sourceId: string, key: string): Detection {
  return {
    key: `${sourceId}:${key}`,
    sourceId,
    sourceName: "Florida Governor (press releases)",
    tier: "official",
    level: "state",
    kind: "state_emergency",
    status: "declared",
    title: "Governor DeSantis Declares State of Emergency for Tropical Storm Nolo",
    url: "https://www.flgov.com/eog/news/press/2026/storm",
    state: "FL",
    detectedAt: new Date().toISOString(),
  };
}

test("digest answers yes/no and sorts endpoints by activity and health", async () => {
  const store = new Store(":memory:");
  const since = new Date(Date.now() - 1000).toISOString();
  const sources = [
    fakeSource("fl-press", "official", [
      { detections: [], items: ["old-1", "old-2"] },
      () => ({ detections: [declaration("fl-press", "storm")], items: ["old-1", "old-2", "storm"] }),
    ]),
    fakeSource("ar-press", "official", [new Error("HTTP 403 for https://governor.arkansas.gov/newsroom/")]),
    fakeSource("ga-orders", "official", [{ detections: [], items: ["eo-1"] }]),
    fakeSource("news-local", "news", [{ detections: [], items: ["a"] }, { detections: [], items: ["a", "b", "c"] }]),
  ];
  const scheduler = new Scheduler(store, sources, async () => {});
  for (const s of sources) await scheduler.runOnce(s);
  await tick();
  for (const s of sources) await scheduler.runOnce(s);
  const until = new Date(Date.now() + 1000).toISOString();

  const d = buildDigest(store, sources, since, until, "America/New_York");
  assert.match(d.subject, /: YES, 1 new declaration$/);
  assert.equal(d.alertCount, 1);
  assert.match(d.text, /^YES\. 1 alert \(1 new declaration\)/);
  assert.match(d.text, /1\. OFFICIAL DISASTER DECLARATIONS[\s\S]*New: State emergency declaration, Florida\n {3}Governor DeSantis Declares/);
  assert.match(d.text, /2\. OTHER EVIDENCE & NEWS[\s\S]*None in this window\./);
  assert.match(d.text, /3\. SOURCE EVIDENCE \/ VERIFICATION[\s\S]*POSTED SOMETHING NEW \(1\)\n {2}fl-press {2}fl-press name: 1 new item, 1 declaration match\n/);
  assert.match(d.text, /DOWN OR UNRELIABLE \(1\)\n {2}ar-press {2}ar-press name: down, 0 of 2 checks succeeded\. Last error: HTTP 403/);
  assert.match(d.text, /NOTHING NEW \(1\)\n {2}ga-orders/);
  assert.match(d.text, /News searches: 2 new articles across 1 search, 0 declaration matches\./);
  assert.match(d.html, /1\. Official disaster declarations/);
  assert.match(d.html, /2\. Other evidence &amp; news/);
  assert.match(d.html, /3\. Source evidence \/ verification/);
  assert.match(d.html, /<td[^>]*>Yes<\/td>/);

  const later = buildDigest(store, sources, until, new Date(Date.now() + 2000).toISOString(), "America/New_York");
  assert.match(later.subject, /: no new declarations$/);
  assert.match(later.text, /^NO\. Nothing new was declared/);
});

test("localClock reports the date and time in the digest's time zone", () => {
  assert.deepEqual(localClock(new Date("2026-10-01T21:30:00Z"), "America/New_York"), { date: "2026-10-01", minutes: 17 * 60 + 30 });
  assert.deepEqual(localClock(new Date("2026-10-02T02:30:00Z"), "America/Los_Angeles"), { date: "2026-10-01", minutes: 19 * 60 + 30 });
});
