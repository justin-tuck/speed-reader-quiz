/**
 * Turns a fetched web page into a snapshot that can be shown later as a page
 * preview: one HTML string with its stylesheets and images inside it.
 *
 * The snapshot is self-contained because the site's content security policy
 * (server/securityHeaders.ts) does not let the app load anything from other
 * sites, and so that a preview keeps working when the page changes or the
 * device is offline. Scripts are removed; the preview shows the page as it
 * was delivered, not as its scripts would have rebuilt it. Nothing in a
 * snapshot is loaded from the original site when it is shown.
 */
import { apiFetch } from '../api';

const MAX_STYLESHEETS = 12;
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PARALLEL = 6;
const TIME_LIMIT_MS = 20_000;

const REMOVE =
  'script,iframe,frame,frameset,object,embed,base,template,video,audio,source,track,meta[http-equiv],link:not([rel~="stylesheet" i])';
/** Attributes that sites use to hold the real image address until a script copies it to `src`. */
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'srcset'];

function absolute(value: string | null | undefined, base: string): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Keeps a stylesheet from loading anything: @import is dropped and addresses
 * of background images and fonts are blanked. Only images in the page itself
 * are embedded, so decorative backgrounds and web fonts are not shown.
 */
export function prepareCss(css: string): string {
  return css
    .replace(/@import\s[^;]*;/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _quote: string, target: string) =>
      /^\s*(data:|#)/i.test(target) ? whole : 'url("data:,")',
    );
}

async function fetchAsset(url: string, signal: AbortSignal): Promise<Response | null> {
  try {
    const response = await apiFetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal });
    return response.ok && response.headers.has('x-final-url') ? response : null;
  } catch {
    return null;
  }
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

/** The address an image should be loaded from, allowing for lazy-loading attributes. */
function imageAddress(img: Element, base: string): string | null {
  const src = img.getAttribute('src');
  if (src && !src.startsWith('data:')) return absolute(src, base);
  for (const name of LAZY_SRC) {
    // For a srcset, the first candidate will do.
    const first = (img.getAttribute(name) ?? '').trim().split(/[\s,]+/)[0];
    const url = absolute(first, base);
    if (url) return url;
  }
  return null;
}

export async function buildSnapshot(html: string, pageUrl: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const signal = AbortSignal.timeout(TIME_LIMIT_MS);

  doc.querySelectorAll(REMOVE).forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    const style = el.getAttribute('style');
    if (style?.includes('url(')) el.setAttribute('style', prepareCss(style));
  }
  // Links stay visible but must not replace the preview with another page.
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = absolute(a.getAttribute('href'), pageUrl);
    if (url) a.setAttribute('href', url);
    else a.removeAttribute('href');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  doc.querySelectorAll('style').forEach((el) => (el.textContent = prepareCss(el.textContent ?? '')));

  // Stylesheets become <style> elements.
  const links = [...doc.querySelectorAll('link')];
  links.slice(MAX_STYLESHEETS).forEach((link) => link.remove());
  await inParallel(links.slice(0, MAX_STYLESHEETS), async (link) => {
    const url = absolute(link.getAttribute('href'), pageUrl);
    const response = url ? await fetchAsset(url, signal) : null;
    const css = response ? await response.text().catch(() => null) : null;
    if (url && css !== null) {
      const style = doc.createElement('style');
      const media = link.getAttribute('media');
      if (media) style.setAttribute('media', media);
      style.textContent = prepareCss(css);
      link.replaceWith(style);
    } else {
      link.remove();
    }
  });

  // Images become data: addresses.
  doc.querySelectorAll('picture source').forEach((el) => el.remove());
  const images = new Map<string, Element[]>();
  for (const img of doc.querySelectorAll('img')) {
    const url = imageAddress(img, pageUrl);
    for (const name of [...LAZY_SRC, 'sizes', 'loading']) img.removeAttribute(name);
    // Until its data arrives the image has no address, so one that cannot be embedded shows its alt text.
    if (!img.getAttribute('src')?.startsWith('data:')) img.removeAttribute('src');
    if (url) images.set(url, [...(images.get(url) ?? []), img]);
  }
  let bytes = 0;
  await inParallel([...images.keys()].slice(0, MAX_IMAGES), async (url) => {
    if (bytes >= MAX_IMAGE_BYTES) return;
    const response = await fetchAsset(url, signal);
    const blob = response ? await response.blob().catch(() => null) : null;
    if (!blob || !blob.type.startsWith('image/') || bytes + blob.size > MAX_IMAGE_BYTES) return;
    bytes += blob.size;
    const data = await toDataUrl(blob).catch(() => null);
    if (data) images.get(url)?.forEach((img) => img.setAttribute('src', data));
  });

  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.prepend(charset);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
