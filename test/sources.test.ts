import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { extractAccessToken, extractItems, yearlessDate } from "../src/sources/json.ts";
import { extractLinks, pageSource, pastYearDate } from "../src/sources/page.ts";
import { Store } from "../src/store.ts";

test("extractLinks skips chrome and keeps the best text per link", () => {
  const html = `<html><body>
    <nav><a href="/about">About the Governor</a></nav>
    <main>
      <a href="/news/1?utm_source=x">Governor Declares State of Emergency for Flooding</a>
      <a href="/news/1">Read more</a>
      <a href="/eo/26-14.pdf">View</a>
      <a href="mailto:press@state.gov">Email us</a>
    </main>
    <footer><a href="/privacy">Privacy Policy</a></footer>
  </body></html>`;
  const links = extractLinks(html, "https://gov.example.gov/news");
  assert.deepEqual([...links.entries()], [
    ["https://gov.example.gov/news/1", "Governor Declares State of Emergency for Flooding"],
    ["https://gov.example.gov/eo/26-14.pdf", ""],
  ]);
});

test("pastYearDate ages out documents from earlier years", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  assert.equal(pastYearDate("https://www.maine.gov/official_documents/executive-orders/2024-05-executive-order-8 Executive Order 8", now), "2024-12-31T23:59:59.000Z");
  assert.equal(pastYearDate("https://gov.example.gov/eo/2026-14.pdf Executive Order 2025-2026 winter", now), undefined);
  assert.equal(pastYearDate("https://www.kansastag.gov/m/newsflash/Home/Detail/874", now), undefined);
  assert.equal(pastYearDate("https://example.gov/item/2087", now), undefined);
});

test("yearlessDate picks the most recent past year that matches the weekday", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  assert.equal(yearlessDate("Sunday, August 09", now), "2026-08-09T12:00:00.000Z");
  assert.equal(yearlessDate("Thursday, July 31", now), "2025-07-31T12:00:00.000Z");
  assert.equal(yearlessDate("December 15", now), "2025-12-15T12:00:00.000Z");
  assert.equal(yearlessDate("not a date", now), undefined);
});

test("extractAccessToken reads a Coveo token from page source", () => {
  const html = `<script>const cfg = { organizationId: 'org', accessToken: 'xx4cfd4ffb-11d2-418f-984f-7eaacf843a3b' };</script>`;
  assert.equal(extractAccessToken(html), "xx4cfd4ffb-11d2-418f-984f-7eaacf843a3b");
  assert.equal(extractAccessToken("<html></html>"), undefined);
});

test("extractItems maps nested JSON and templated links", () => {
  const data = { data: { list: [{ event: { title: "Gov. Braun <b>Declares</b> Disaster Emergency", urlname: "gov-braun-declares", created_at: "2026-09-30T15:25:00-04:00" } }] } };
  const [item] = extractItems(data, {
    url: "https://events.in.gov/api",
    itemsPath: "data.list",
    fields: { title: "event.title", link: "event.urlname", date: "event.created_at" },
    linkTemplate: "https://events.in.gov/event/{}",
  });
  assert.equal(item.title, "Gov. Braun Declares Disaster Emergency");
  assert.equal(item.link, "https://events.in.gov/event/gov-braun-declares");
  assert.equal(item.publishedAt, "2026-09-30T19:25:00.000Z");

  const [coveo] = extractItems([{ raw: { t: "x", d: 1790000000000 }, clickUri: "/a" }], { url: "https://www.pa.gov/", fields: { title: "raw.t", link: "clickUri", date: "raw.d" } });
  assert.equal(coveo.link, "https://www.pa.gov/a");
  assert.equal(coveo.publishedAt, new Date(1790000000000).toISOString());
});

// A fake state newsroom whose listing grows between polls.
let server: Server;
let base = "";
let listing = "";
const docs: Record<string, string> = {
  "/eo/26-15": "<html><head><title>Executive Order 26-15</title></head><body><main><p>I hereby declare a state of emergency in Polk County due to severe flooding.</p></main></body></html>",
  "/eo/26-16": "<html><head><title>Executive Order 26-16</title></head><body><main><p>Establishing a council on workforce development.</p></main></body></html>",
};

before(async () => {
  server = createServer((req, res) => {
    const body = req.url === "/news" ? listing : docs[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => server.close());

test("page source baselines silently, then reports only new declaration links", async () => {
  const store = new Store(":memory:");
  const src = pageSource({ id: "xx-orders", name: "Test Governor", url: `${base}/news`, state: "IA" }, store);
  const page = (links: string[]) => `<html><body><main>${links.join("")}</main></body></html>`;
  const old = `<a href="/eo/26-14">Executive Order 26-14</a>`;

  listing = page([old]);
  assert.deepEqual(await src.poll(), { detections: [], items: [`${base}/eo/26-14`] });
  store.markBaselined(src.id);

  listing = page([
    `<a href="/eo/26-15">Executive Order 26-15</a>`,
    `<a href="/eo/26-16">Executive Order 26-16</a>`,
    `<a href="/news/storm">Governor Reynolds Issues Disaster Proclamation for Storm Damage</a>`,
    old,
  ]);
  const result = await src.poll();
  assert.equal(result?.items.length, 4);
  const found = result?.detections ?? [];
  assert.deepEqual(found.map((d) => d.url).sort(), [`${base}/eo/26-15`, `${base}/news/storm`]);
  assert.ok(found.every((d) => d.state === "IA" && d.level === "state" && d.status === "declared"));
  assert.match(found.find((d) => d.url?.endsWith("26-15"))!.title, /Executive Order 26-15/);

  assert.deepEqual((await src.poll())?.detections, []);
});
