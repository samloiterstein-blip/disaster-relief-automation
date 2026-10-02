import { parse, type HTMLElement } from "node-html-parser";
import { extractText, getDocumentProxy } from "unpdf";
import { fetchDocument, type FetchOptions } from "./http.ts";

const MAX_BYTES = 15 * 1024 * 1024;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Drop chrome that repeats on every page so it isn't mistaken for content. */
export function stripChrome(root: HTMLElement): HTMLElement {
  for (const el of root.querySelectorAll("script, style, noscript, template, svg, nav, header, footer, [role=navigation], [role=banner], [role=contentinfo], .breadcrumb, .breadcrumbs, #skip-link")) {
    el.remove();
  }
  return root;
}

/**
 * Fetch a linked press release or executive order and return the text most likely
 * to state what it does: the title plus the opening of the body (HTML), or the
 * first pages of text (PDF, where orders put the "hereby declare" clause).
 */
export async function readDocument(url: string, opts: FetchOptions = {}): Promise<{ title?: string; text: string }> {
  const doc = await fetchDocument(url, { ...opts, accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" });
  if (doc.body.byteLength > MAX_BYTES) return { text: "" };

  const isPdf = doc.contentType.includes("pdf") || new TextDecoder().decode(doc.body.slice(0, 5)) === "%PDF-";
  if (isPdf) {
    const pdf = await getDocumentProxy(doc.body);
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: clean(String(text)).slice(0, 4000) };
  }

  const root = parse(new TextDecoder().decode(doc.body));
  const title = clean(root.querySelector("meta[property='og:title']")?.getAttribute("content") ?? root.querySelector("h1")?.text ?? root.querySelector("title")?.text ?? "");
  const description = clean(root.querySelector("meta[name='description']")?.getAttribute("content") ?? root.querySelector("meta[property='og:description']")?.getAttribute("content") ?? "");
  stripChrome(root);
  const main = root.querySelector("main, article, [role=main], #main-content, #content, .content") ?? root.querySelector("body") ?? root;
  const body = clean(main.text).slice(0, 800);
  return { title: title || undefined, text: [description, body].filter(Boolean).join(". ") };
}
