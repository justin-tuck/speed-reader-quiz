import { Readability } from '@mozilla/readability';
import { ApiError, apiFetch, readError } from '../api';
import { ExtractError } from './errors';
import type { SourceOriginal } from '../../types';
import { extractPdfText } from './pdf';
import { buildSnapshot } from './snapshot';

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre';
const MIN_ARTICLE_CHARS = 200;

/** Turns article HTML into plain text with blank lines between blocks. */
export function htmlToText(root: ParentNode): string {
  const out: string[] = [];
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue; // keep only the innermost blocks
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push(/^H[1-6]$/.test(el.tagName) ? `# ${text}` : text);
  }
  return out.join('\n\n');
}

export function extractArticle(html: string, url: string): { text: string; title?: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pageTitle = doc.title.trim() || undefined;

  const article = new Readability(doc.cloneNode(true) as Document).parse();
  if (article?.content) {
    const container = new DOMParser().parseFromString(article.content, 'text/html');
    let text = htmlToText(container.body);
    if (text.length < MIN_ARTICLE_CHARS) text = (article.textContent ?? '').trim();
    if (text.length >= MIN_ARTICLE_CHARS) return { text, title: article.title?.trim() || pageTitle };
  }

  // Fallback for pages Readability cannot make sense of.
  doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form').forEach((el) => el.remove());
  const text = htmlToText(doc.body);
  if (text.length >= MIN_ARTICLE_CHARS) return { text, title: pageTitle };

  throw new ExtractError(
    `No readable article text was found at ${new URL(url).hostname}. The page may need a login or build its content with JavaScript. Copy the text from the page and use the Paste tab instead.`,
  );
}

interface UrlText {
  text: string;
  title?: string;
  pages?: string[][];
  original?: SourceOriginal;
}

async function readResponse(response: Response, url: string): Promise<UrlText> {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/pdf') || /\.pdf($|\?)/i.test(url)) {
    const data = await response.arrayBuffer();
    // Copied first: pdf.js takes over the buffer it is given.
    const file = new Blob([data], { type: 'application/pdf' });
    return { ...(await extractPdfText(data)), original: { kind: 'pdf', file } };
  }
  const body = await response.text();
  if (type.includes('text/plain')) {
    if (!body.trim()) throw new ExtractError('That URL returned an empty text file.');
    return { text: body };
  }
  const article = extractArticle(body, url);
  // The snapshot is only for previews, so the import goes ahead without it.
  const html = await buildSnapshot(body, response.headers.get('x-final-url') || url).catch(() => null);
  return { ...article, original: html ? { kind: 'html', html, url } : undefined };
}

/** Fetches the page through the app's backend, since browsers cannot read other sites directly. */
export async function fetchUrlText(rawUrl: string): Promise<UrlText & { url: string }> {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  } catch {
    throw new ExtractError('That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExtractError('Only http and https URLs can be imported.');
  }
  const target = url.toString();
  const pasteHint = 'Open the page yourself, copy the text, and use the Paste tab instead.';

  let response: Response;
  try {
    response = await apiFetch(`/api/fetch?url=${encodeURIComponent(target)}`, {
      signal: AbortSignal.timeout(28_000),
    });
  } catch (err) {
    const reason = err instanceof ApiError ? err.message : 'The request took too long.';
    throw new ExtractError(`Could not load ${url.hostname}. ${reason} ${pasteHint}`);
  }
  if (!response.ok || !response.headers.has('x-final-url')) {
    const reason = (await readError(response)).message;
    throw new ExtractError(`Could not load ${url.hostname}. ${reason} ${pasteHint}`);
  }
  return { ...(await readResponse(response, target)), url: target };
}
