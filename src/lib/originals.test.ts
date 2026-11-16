import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryOriginalStore } from '../../server/core/originals.ts';
import { handleRequest } from '../../server/core/router.ts';
import { MemoryStore } from '../../server/core/sync.ts';
import type { Doc } from '../types';
import { backupOriginals, keepOriginal, loadSource, resetOriginalsState, startOriginalBackup } from './originals';
import { closeDb, createDocument, deleteDocument, getSource, saveSource } from './storage';
import { syncNow } from './sync';

/**
 * Two "browsers" are two separate browser databases, talking to the real
 * backend router with in-memory stores. `originals` is undefined to play a
 * backend that does not keep originals.
 */
let originals: MemoryOriginalStore | undefined;
let devices: Record<'laptop' | 'phone', IDBFactory>;
let requests: string[];

async function use(device: 'laptop' | 'phone') {
  await closeDb();
  globalThis.indexedDB = devices[device];
  // A different browser knows nothing yet about what the backend has.
  resetOriginalsState();
}

const pdfDoc = (id: string): Doc => ({ id, title: `Book ${id}`, source: 'pdf', sourceRef: `${id}.pdf`, createdAt: 1 });
const pdfFile = (text: string) => new Blob([`%PDF-1.7 ${text}`], { type: 'application/pdf' });
const remoteIds = async () => (await originals?.list('me'))?.sort();

beforeEach(async () => {
  originals = new MemoryOriginalStore();
  const server = new MemoryStore();
  devices = { laptop: new IDBFactory(), phone: new IDBFactory() };
  requests = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, 'http://app.test');
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    const res = await handleRequest(
      {
        method,
        path: url.pathname,
        query: url.searchParams,
        body: typeof init.body === 'string' ? init.body : null,
        bytes: init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : null,
        userId: 'me',
      },
      { store: server, originals, getApiKey: async () => '' },
    );
    return new Response(res.status === 204 ? null : (res.body as BodyInit), { status: res.status, headers: res.headers });
  });
  await use('laptop');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('original PDFs on the backend', () => {
  it('shows a PDF imported in one browser in another, and keeps the copy there', async () => {
    await createDocument(pdfDoc('d1'), []);
    await keepOriginal('d1', { kind: 'pdf', file: pdfFile('laptop') });
    await vi.waitFor(async () => expect(await remoteIds()).toEqual(['d1']));
    await syncNow();

    await use('phone');
    await syncNow();
    expect(await getSource('d1')).toBeUndefined();
    const source = await loadSource('d1');
    expect(source?.kind).toBe('pdf');
    expect(source?.kind === 'pdf' && (await source.file.text())).toBe('%PDF-1.7 laptop');

    requests = [];
    expect((await loadSource('d1'))?.kind).toBe('pdf');
    expect(requests).toEqual([]);
  });

  it('backs up PDFs this browser kept before the backend did, after a sync', async () => {
    await createDocument(pdfDoc('d1'), []);
    await createDocument({ ...pdfDoc('page'), source: 'url' }, []);
    await saveSource({ id: 'd1', kind: 'pdf', file: pdfFile('old import') });
    await saveSource({ id: 'page', kind: 'html', html: '<p>Hi</p>', url: 'https://example.com/' });
    await saveSource({ id: 'deleted-doc', kind: 'pdf', file: pdfFile('orphan') });

    const stop = startOriginalBackup();
    await syncNow();
    await vi.waitFor(async () => expect(await remoteIds()).toEqual(['d1']));
    stop();

    // Everything is settled, so another backup asks the backend nothing.
    requests = [];
    await backupOriginals();
    expect(requests).toEqual([]);
  });

  it('deletes the PDF on the backend when its text is deleted', async () => {
    await createDocument(pdfDoc('d1'), []);
    await keepOriginal('d1', { kind: 'pdf', file: pdfFile('x') });
    await vi.waitFor(async () => expect(await remoteIds()).toEqual(['d1']));
    await syncNow();

    await deleteDocument('d1');
    await syncNow();
    expect(await remoteIds()).toEqual([]);
  });

  it('keeps PDFs in the browser only when the backend does not keep originals', async () => {
    originals = undefined;
    await createDocument(pdfDoc('d1'), []);
    await createDocument(pdfDoc('d2'), []);
    await keepOriginal('d1', { kind: 'pdf', file: pdfFile('x') });
    await vi.waitFor(() => expect(requests).toEqual(['GET /api/originals']));
    expect((await loadSource('d1'))?.kind).toBe('pdf');

    // Once the backend has said no, nothing large is sent and nothing is asked again.
    await keepOriginal('d2', { kind: 'pdf', file: pdfFile('y') });
    expect(await loadSource('missing')).toBeUndefined();
    await backupOriginals();
    expect(requests).toEqual(['GET /api/originals']);
  });

  it('reports a PDF neither the browser nor the backend has as missing', async () => {
    await createDocument(pdfDoc('d1'), []);
    expect(await loadSource('d1')).toBeUndefined();
  });
});
