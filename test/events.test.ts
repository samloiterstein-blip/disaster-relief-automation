import assert from "node:assert/strict";
import { test } from "node:test";
import { ingest } from "../src/events.ts";
import { Store } from "../src/store.ts";
import type { Detection } from "../src/types.ts";

let n = 0;
function det(over: Partial<Detection>): Detection {
  n++;
  return {
    key: `k${n}`,
    sourceId: "test",
    sourceName: "Test",
    tier: "news",
    level: "state",
    kind: "state_emergency",
    status: "declared",
    title: "untitled",
    detectedAt: new Date().toISOString(),
    ...over,
  };
}

test("repeat coverage of one event alerts once", () => {
  const store = new Store(":memory:");
  const a = ingest(store, det({ state: "TX", title: "Gov. Abbott declares disaster in Texas over high diesel prices - KVUE" }));
  const b = ingest(store, det({ state: "TX", title: "Abbott declares disaster over high diesel prices, fuel shortage - Houston Chronicle" }));
  assert.equal(a?.type, "new");
  assert.equal(b, null);
  assert.equal(store.latestEvents(10)[0].sourceCount, 2);
});

test("different events in the same state both alert", () => {
  const store = new Store(":memory:");
  assert.equal(ingest(store, det({ state: "CA", title: "Newsom proclaims state of emergency ahead of El Niño storms" }))?.type, "new");
  assert.equal(ingest(store, det({ state: "CA", title: "Governor declares emergency over Kern County wildfire" }))?.type, "new");
});

test("differently worded press reports of one state's declaration merge on the hazard", () => {
  const store = new Store(":memory:");
  const titles = [
    "Governor Mike Kehoe declares State of Emergency and eases fuel restrictions for farmers - KJLU 88.9 FM",
    "Kehoe declares state of emergency, signs order cutting diesel-related restrictions amid skyrocketing prices - ABC17NEWS",
    "Kehoe signs emergency order to ease farm fuel and transport rules - KTTN",
  ];
  const types = titles.map((title) => ingest(store, det({ state: "MO", title }))?.type ?? null);
  assert.deepEqual(types, ["new", null, null]);

  const ks = new Store(":memory:");
  assert.equal(ingest(ks, det({ tier: "official", state: "KS", title: "Governor Laura Kelly issues disaster proclamation for severe storms and flooding" }))?.type, "new");
  assert.equal(ingest(ks, det({ state: "KS", title: "Kansas gov. declares state of disaster due to rain, flooding - AOL.com" })), null);
});

test("stateless local reports naming the same county and hazard merge", () => {
  const store = new Store(":memory:");
  const local = (title: string) => ingest(store, det({ level: "local", kind: "local_emergency", state: undefined, title }))?.type ?? null;
  assert.equal(local("Merced County proclaims state of emergency to prepare for El Niño - YourCentralValley.com"), "new");
  assert.equal(local("Merced County declares local emergency as officials prepare for potentially strong El Niño - ABC30 Fresno"), null);
  assert.equal(local("Merced County issues emergency proclamation in preparation for El Niño - Merced Sun-Star"), null);
  assert.equal(local("Orange County declares local emergency over wildfire - KTLA"), "new");
});

test("an official source confirms an earlier press report", () => {
  const store = new Store(":memory:");
  ingest(store, det({ state: "IA", title: "Iowa counties declare emergency after historic flooding" }));
  const confirmed = ingest(store, det({ tier: "official", state: "IA", title: "Gov. Reynolds issues disaster proclamation for historic flooding in Iowa counties" }));
  assert.equal(confirmed?.type, "confirmed");
  assert.equal(confirmed?.event.official, true);
});

test("FEMA record links to a federal press report despite different wording", () => {
  const store = new Store(":memory:");
  const news = ingest(store, det({ level: "federal", kind: "major_disaster", state: "KY", title: "Trump approves Kentucky disaster declaration" }));
  assert.equal(news?.type, "new");
  const fema = ingest(store, det({
    tier: "official", level: "federal", kind: "major_disaster", state: "KY", ref: "DR-4950-KY",
    title: "Major disaster declaration DR-4950-KY: SEVERE STORMS AND FLOODING (Kentucky)",
  }));
  assert.equal(fema?.type, "confirmed");
  assert.equal(fema?.event.ref, "DR-4950-KY");
});

test("two FEMA declarations in one state stay separate", () => {
  const store = new Store(":memory:");
  const base = { tier: "official" as const, level: "federal" as const, kind: "fire_management" as const, state: "TX" };
  assert.equal(ingest(store, det({ ...base, ref: "FM-5677-TX", title: "FM-5677-TX: HYDRA FIRE" }))?.type, "new");
  assert.equal(ingest(store, det({ ...base, ref: "FM-5678-TX", title: "FM-5678-TX: ROSS FIRE" }))?.type, "new");
});

test("a request and the later approval are separate alerts", () => {
  const store = new Store(":memory:");
  const base = { level: "federal" as const, kind: "major_disaster" as const, state: "WA" };
  assert.equal(ingest(store, det({ ...base, status: "requested", title: "Washington requests major disaster declaration for wildfires" }))?.type, "new");
  assert.equal(ingest(store, det({ ...base, status: "declared", title: "Washington major disaster declaration approved for wildfires" }))?.type, "new");
});

test("official expansion of a known declaration alerts as amended", () => {
  const store = new Store(":memory:");
  const base = { tier: "official" as const, level: "federal" as const, kind: "major_disaster" as const, state: "TX", ref: "DR-4935-TX" };
  ingest(store, det({ ...base, title: "DR-4935-TX: SEVERE STORMS" }));
  const amended = ingest(store, det({ ...base, status: "amended", title: "DR-4935-TX expanded: 3 area(s) added in Texas" }));
  assert.equal(amended?.type, "amended");
});
