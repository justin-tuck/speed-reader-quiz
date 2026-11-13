/**
 * Fetches a web page on behalf of the browser, which cannot read other
 * sites directly because of CORS.
 *
 * The backend must not become a way into addresses that only it can reach,
 * such as its own loopback interface or a private network. So the address a
 * host name resolves to is checked at the moment of connecting (a check made
 * earlier could be outwitted by a name that changes its answer), and
 * redirects are followed one at a time so that every hop is checked too.
 */
import { lookup as dnsLookup } from 'node:dns';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable, type Transform } from 'node:stream';
import zlib from 'node:zlib';

/** Lambda responses are capped at 6 MB and binary bodies grow by a third when base64 encoded. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Error code of a connection refused because the host resolved to a private address. */
const PRIVATE_ADDRESS = 'EPRIVATEADDR';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; SpeedReaderQuiz/1.0)',
  accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5',
  'accept-encoding': 'gzip, deflate, br',
};

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

/** Addresses that are not on the public internet. IPv4-mapped IPv6 addresses match the IPv4 rules. */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3], // multicast, reserved and broadcast
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the old IPv4-compatible form
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

/** True for an IP address that is not on the public internet, and for anything that is not an IP address. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  try {
    return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return true;
  }
}

function isPrivateName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local');
}

const privateAddressError = () => new FetchPageError(400, 'Addresses on a private network cannot be imported.');

/**
 * Refuses URLs that are not web addresses, and private addresses that can be
 * recognised without a DNS lookup. Names are checked again once resolved.
 */
function checkTarget(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchPageError(400, 'Only http and https URLs are supported.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host) ? isPrivateAddress(host) : isPrivateName(host)) throw privateAddressError();
}

/**
 * dns.lookup for outgoing connections, except that it fails when the name
 * resolves to any private address. Connections to an IP address skip the
 * lookup, which is why checkTarget checks those itself.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      const refused = Object.assign(new Error(`${hostname} resolves to a private address.`), { code: PRIVATE_ADDRESS });
      return callback(refused, '');
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/** A response whose body has not been read yet. http.IncomingMessage is one. */
export type Upstream = Readable & { statusCode?: number; headers: IncomingHttpHeaders };

/** Sends one GET request, without following redirects. */
export type Get = (url: URL, signal: AbortSignal) => Promise<Upstream>;

export const httpGet: Get = (url, signal) =>
  new Promise((resolve, reject) => {
    // No shared agent: every request makes a fresh connection, checked by guardedLookup.
    const options: https.RequestOptions = { headers: HEADERS, signal, lookup: guardedLookup, agent: false };
    const req = url.protocol === 'https:' ? https.get(url, options, resolve) : http.get(url, options, resolve);
    req.on('error', reject);
  });

function decoderFor(encoding: string | undefined): Transform | null {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

const tooLargeError = () =>
  new FetchPageError(
    502,
    'That page or file is larger than 4 MB. Download it and use the PDF tab, or paste the text instead.',
  );

async function readBody(res: Upstream): Promise<Uint8Array> {
  if (Number(res.headers['content-length'] ?? 0) > MAX_BYTES) {
    res.destroy();
    throw tooLargeError();
  }
  const decoder = decoderFor(res.headers['content-encoding']);
  const stream: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    // Counted after decompression, so a small compressed reply cannot unpack into a huge one.
    size += (chunk as Buffer).length;
    if (size > MAX_BYTES) {
      res.destroy();
      throw tooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function connectionError(err: unknown, signal: AbortSignal): FetchPageError {
  if (err instanceof FetchPageError) return err;
  if ((err as { code?: unknown } | null)?.code === PRIVATE_ADDRESS) return privateAddressError();
  if (signal.aborted) return new FetchPageError(502, 'The site took too long to answer.');
  return new FetchPageError(502, 'The site could not be reached.');
}

/** `get` is replaceable so the tests do not need the network. */
export async function fetchPage(target: string | null, get: Get = httpGet): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(target ?? '');
  } catch {
    throw new FetchPageError(400, 'That is not a valid URL.');
  }
  checkTarget(url);

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let redirects = 0; ; redirects++) {
    let res: Upstream;
    try {
      res = await get(url, signal);
    } catch (err) {
      throw connectionError(err, signal);
    }

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (REDIRECT_STATUSES.has(status) && location) {
      res.resume(); // discard the redirect's own body
      if (redirects >= MAX_REDIRECTS) throw new FetchPageError(502, 'The site redirected too many times.');
      try {
        url = new URL(location, url);
      } catch {
        throw new FetchPageError(502, 'The site redirected to an invalid address.');
      }
      checkTarget(url);
      continue;
    }
    if (status < 200 || status > 299) {
      res.resume();
      throw new FetchPageError(502, `The site answered with HTTP ${status}.`);
    }

    try {
      return {
        body: await readBody(res),
        contentType: res.headers['content-type'] ?? 'application/octet-stream',
        finalUrl: url.toString(),
      };
    } catch (err) {
      throw connectionError(err, signal);
    }
  }
}
