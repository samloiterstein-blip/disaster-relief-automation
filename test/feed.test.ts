import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "../src/feed.ts";

test("parses Google News style RSS", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
    <item><title>Ohio Governor declares State of Emergency - Morgan County Herald</title>
      <link>https://news.google.com/rss/articles/abc</link>
      <guid isPermaLink="false">CBMiabc</guid>
      <pubDate>Tue, 29 Sep 2026 21:30:00 GMT</pubDate>
      <description>&lt;a href="x"&gt;Ohio Governor declares&lt;/a&gt;</description>
      <source url="https://www.morgancountyherald.com">Morgan County Herald</source></item>
  </channel></rss>`;
  const [item] = parseFeed(xml);
  assert.equal(item.id, "CBMiabc");
  assert.equal(item.title, "Ohio Governor declares State of Emergency - Morgan County Herald");
  assert.equal(item.publisher, "Morgan County Herald");
  assert.equal(item.publishedAt, "2026-09-29T21:30:00.000Z");
  assert.equal(item.summary, "Ohio Governor declares");
});

test("parses WordPress RSS with CDATA and a single item", () => {
  const xml = `<rss><channel><item><title><![CDATA[Governor Issues Disaster Declaration & More]]></title>
    <link>https://gov.example/a</link><pubDate>Wed, 30 Sep 2026 12:00:00 +0000</pubDate></item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Governor Issues Disaster Declaration & More");
  assert.equal(items[0].id, "https://gov.example/a");
});

test("parses Atom", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>State of emergency declared</title>
    <link rel="alternate" href="https://example.gov/1"/><updated>2026-09-30T10:00:00Z</updated><summary>Details</summary></entry></feed>`;
  const [e] = parseFeed(xml);
  assert.equal(e.link, "https://example.gov/1");
  assert.equal(e.publishedAt, "2026-09-30T10:00:00.000Z");
});
