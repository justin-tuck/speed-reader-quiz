/**
 * Fetches a web page on behalf of the browser, which cannot read other
 * sites directly because of CORS.
 */

/** Lambda responses are capped at 6 MB and binary bodies grow by a third when base64 encoded. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class FetchPageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FetchPageError';
    this.status = status;
  }
}

export interface FetchedPage {
  body: Uint8Array;
  contentType: string;
  finalUrl: string;
}

/** Refuses addresses that point back at the server's own network. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export async function fetchPage(target: string | null): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(target ?? '');
  } catch {
    throw new FetchPageError(400, 'That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchPageError(400, 'Only http and https URLs are supported.');
  }
  if (isPrivateHost(url.hostname)) {
    throw new FetchPageError(400, 'Addresses on a private network cannot be imported.');
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SpeedReaderQuiz/1.0)',
        accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5',
      },
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new FetchPageError(502, timedOut ? 'The site took too long to answer.' : 'The site could not be reached.');
  }
  if (!upstream.ok) throw new FetchPageError(502, `The site answered with HTTP ${upstream.status}.`);

  const declared = Number(upstream.headers.get('content-length') ?? 0);
  const body = declared > MAX_BYTES ? null : new Uint8Array(await upstream.arrayBuffer());
  if (!body || body.byteLength > MAX_BYTES) {
    throw new FetchPageError(
      502,
      'That page or file is larger than 4 MB. Download it and use the PDF tab, or paste the text instead.',
    );
  }
  return {
    body,
    contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
    finalUrl: upstream.url,
  };
}
