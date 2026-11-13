import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPage } from './fetchPage.ts';

afterEach(() => vi.unstubAllGlobals());

describe('fetchPage', () => {
  it('refuses invalid, non-web and private addresses without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blocked = [
      null,
      'not a url',
      'file:///etc/passwd',
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
    ];
    for (const url of blocked) await expect(fetchPage(url)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the body, type and final address', async () => {
    const response = new Response('<p>hello</p>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://example.com/final' });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const page = await fetchPage('https://example.com/start');
    expect(new TextDecoder().decode(page.body)).toBe('<p>hello</p>');
    expect(page).toMatchObject({ contentType: 'text/html', finalUrl: 'https://example.com/final' });
  });

  it('reports site errors, unreachable sites and oversized pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 403 })));
    await expect(fetchPage('https://example.com/')).rejects.toMatchObject({
      status: 502,
      message: 'The site answered with HTTP 403.',
    });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(fetchPage('https://example.com/')).rejects.toMatchObject({ message: 'The site could not be reached.' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))));
    await expect(fetchPage('https://example.com/')).rejects.toMatchObject({ status: 502 });
  });
});
