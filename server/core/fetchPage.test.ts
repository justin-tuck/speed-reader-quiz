import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { fetchPage, guardedLookup, httpGet, isPrivateAddress, type Get, type Upstream } from './fetchPage.ts';

/** A fake response, as the network would return it. */
function reply(statusCode: number, body: string | Buffer = '', headers: Record<string, string> = {}): Upstream {
  const chunks = body.length ? [Buffer.isBuffer(body) ? body : Buffer.from(body)] : [];
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}

/** A fake network that answers each request with the next reply. */
function network(...replies: Upstream[]) {
  return vi.fn<Get>(async () => {
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next;
  });
}

describe('isPrivateAddress', () => {
  it('recognises loopback, private, link-local and mapped addresses', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '169.254.169.254',
      '172.31.255.255',
      '192.168.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      'not an address',
    ];
    for (const address of blocked) expect(isPrivateAddress(address), address).toBe(true);
  });

  it('allows public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('guardedLookup', () => {
  it('fails for a name that resolves to a private address', async () => {
    const err = await new Promise((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(err).toMatchObject({ code: 'EPRIVATEADDR' });
  });

  it('is used for real connections, so they never reach a private address', async () => {
    const hits = vi.fn();
    const server = http.createServer((_req, res) => {
      hits();
      res.end('private');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // "localhost" is a name, so the connection goes through the lookup.
      await expect(httpGet(new URL(`http://localhost:${port}/`), AbortSignal.timeout(5000))).rejects.toMatchObject({
        code: 'EPRIVATEADDR',
      });
      expect(hits).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('fetchPage', () => {
  it('refuses invalid, non-web and private addresses without making a request', async () => {
    const get = network();
    const blocked = [
      null,
      'not a url',
      'file:///etc/passwd',
      'http://localhost:3000/',
      'http://localhost./',
      'http://metadata.google.internal/',
      'http://127.0.0.1/',
      'http://0x7f000001/',
      'http://10.0.0.5/',
      'http://100.64.0.1/',
      'http://192.168.1.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
    ];
    for (const url of blocked) await expect(fetchPage(url, get), String(url)).rejects.toMatchObject({ status: 400 });
    expect(get).not.toHaveBeenCalled();
  });

  it('returns the body, type and final address after following redirects', async () => {
    const get = network(
      reply(301, '', { location: 'https://example.com/start' }),
      reply(302, '', { location: '/final' }),
      reply(200, '<p>hello</p>', { 'content-type': 'text/html' }),
    );
    const page = await fetchPage('http://example.com/', get);
    expect(new TextDecoder().decode(page.body)).toBe('<p>hello</p>');
    expect(page).toMatchObject({ contentType: 'text/html', finalUrl: 'https://example.com/final' });
    expect(get.mock.calls.map(([url]) => url.toString())).toEqual([
      'http://example.com/',
      'https://example.com/start',
      'https://example.com/final',
    ]);
  });

  it('refuses a redirect to a private address', async () => {
    const get = network(reply(302, '', { location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(fetchPage('https://example.com/', get)).rejects.toMatchObject({ status: 400 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refuses a public name that resolves to a private address', async () => {
    const get = network();
    get.mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'EPRIVATEADDR' }));
    await expect(fetchPage('https://rebind.example/', get)).rejects.toMatchObject({
      status: 400,
      message: 'Addresses on a private network cannot be imported.',
    });
  });

  it('stops after too many redirects', async () => {
    const loop = Array.from({ length: 11 }, () => reply(302, '', { location: '/again' }));
    await expect(fetchPage('https://example.com/', network(...loop))).rejects.toMatchObject({
      status: 502,
      message: 'The site redirected too many times.',
    });
  });

  it('decompresses the body', async () => {
    const get = network(reply(200, zlib.gzipSync('<p>hello</p>'), { 'content-encoding': 'gzip' }));
    const page = await fetchPage('https://example.com/', get);
    expect(new TextDecoder().decode(page.body)).toBe('<p>hello</p>');
  });

  it('reports site errors, unreachable sites and oversized pages', async () => {
    await expect(fetchPage('https://example.com/', network(reply(403, 'no')))).rejects.toMatchObject({
      status: 502,
      message: 'The site answered with HTTP 403.',
    });

    const unreachable = network();
    unreachable.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchPage('https://example.com/', unreachable)).rejects.toMatchObject({
      message: 'The site could not be reached.',
    });

    const big = Buffer.alloc(4 * 1024 * 1024 + 1);
    await expect(fetchPage('https://example.com/', network(reply(200, big)))).rejects.toMatchObject({ status: 502 });

    // Small on the wire, too large once unpacked.
    const bomb = reply(200, zlib.gzipSync(big), { 'content-encoding': 'gzip' });
    await expect(fetchPage('https://example.com/', network(bomb))).rejects.toMatchObject({ status: 502 });
  });
});
