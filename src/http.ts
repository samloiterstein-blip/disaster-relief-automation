import { lookup } from "node:dns/promises";
import { config } from "./config.ts";

interface Validators {
  etag?: string;
  lastModified?: string;
}

const validators = new Map<string, Validators>();

/** Some state sites (Akamai, mass.gov, maine.gov, tn.gov) reject any client that doesn't look like a browser. */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": BROWSER_UA,
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "sec-ch-ua": `"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": `"macOS"`,
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

export class HttpError extends Error {
  status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export interface FetchOptions {
  accept?: string;
  conditional?: boolean;
  browserUserAgent?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** JSON request body; switches the request to POST. */
  body?: unknown;
}

async function request(url: string, opts: FetchOptions): Promise<Response | null> {
  const headers: Record<string, string> = {
    ...(opts.browserUserAgent ? BROWSER_HEADERS : { "user-agent": config.userAgent }),
    accept: opts.accept ?? "*/*",
    ...opts.headers,
  };
  const conditional = opts.conditional !== false && opts.body === undefined;
  const cached = conditional ? validators.get(url) : undefined;
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? config.httpTimeoutMs),
    redirect: "follow",
  });
  if (res.status === 304) return null;
  if (!res.ok) throw new HttpError(url, res.status);

  if (conditional) {
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (etag || lastModified) validators.set(url, { etag, lastModified });
  }
  return res;
}

/**
 * GET with timeout and conditional-request support.
 * Returns null when the server says nothing changed (304), so callers can skip parsing.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string | null> {
  const res = await request(url, opts);
  return res === null ? null : res.text();
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T | null> {
  const text = await fetchText(url, { accept: "application/json", ...opts });
  return text === null ? null : (JSON.parse(text) as T);
}

/** True once DNS resolves. A laptop waking from sleep can take a minute or more to get back online. */
export async function networkUp(hosts = ["www.fema.gov", "oauth2.googleapis.com"], waitMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await Promise.all(hosts.map((h) => lookup(h)));
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/** Unconditional GET that keeps the body as bytes, for documents that may be PDFs. */
export async function fetchDocument(url: string, opts: FetchOptions = {}): Promise<{ contentType: string; body: Uint8Array; finalUrl: string }> {
  const res = (await request(url, { ...opts, conditional: false }))!;
  return { contentType: res.headers.get("content-type") ?? "", body: new Uint8Array(await res.arrayBuffer()), finalUrl: res.url };
}
