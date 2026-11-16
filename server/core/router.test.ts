import { describe, expect, it, vi } from 'vitest';
import { MAX_PDF_BYTES } from '../../shared/api.ts';
import { FetchPageError } from './fetchPage.ts';
import { MemoryOriginalStore } from './originals.ts';
import { QuizError } from './quiz.ts';
import { handleRequest, type ApiRequest, type Dependencies } from './router.ts';
import { MemoryStore } from './sync.ts';

const question = { question: 'Q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'Because.' };

function deps(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    store: new MemoryStore(),
    getApiKey: async () => 'server-side-key',
    generateQuiz: vi.fn(async () => [question]),
    fetchPage: vi.fn(async () => ({
      body: new TextEncoder().encode('<p>hi</p>'),
      contentType: 'text/html',
      finalUrl: 'https://example.com/',
    })),
    now: () => 1000,
    ...overrides,
  };
}

const req = (method: string, path: string, body?: unknown, query = ''): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(query),
  body: body === undefined ? null : JSON.stringify(body),
  userId: 'u1',
});

const parse = (body: string | Uint8Array) => JSON.parse(body as string) as Record<string, unknown>;

describe('POST /api/quiz', () => {
  it('generates a quiz with the server-side key and never returns the key', async () => {
    const d = deps();
    const res = await handleRequest(req('POST', '/api/quiz', { docTitle: 'T', sectionText: ' Text ', count: 4 }), d);
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ questions: [question] });
    expect(d.generateQuiz).toHaveBeenCalledWith({
      apiKey: 'server-side-key',
      sectionText: 'Text',
      docTitle: 'T',
      count: 4,
    });
    expect(String(res.body)).not.toContain('server-side-key');
  });

  it('rejects an empty or oversized section', async () => {
    expect((await handleRequest(req('POST', '/api/quiz', { sectionText: '  ' }), deps())).status).toBe(400);
    expect((await handleRequest(req('POST', '/api/quiz', { sectionText: 'x'.repeat(60_001) }), deps())).status).toBe(413);
    expect((await handleRequest(req('POST', '/api/quiz'), deps())).status).toBe(400);
  });

  it('maps quiz failures to a status, kind and message', async () => {
    const cases: [QuizError['kind'], number][] = [
      ['no-key', 503],
      ['rate-limit', 429],
      ['refusal', 422],
      ['timeout', 504],
      ['invalid', 502],
    ];
    for (const [kind, status] of cases) {
      const d = deps({ generateQuiz: vi.fn(async () => Promise.reject(new QuizError(kind, `failed: ${kind}`))) });
      const res = await handleRequest(req('POST', '/api/quiz', { sectionText: 'Text' }), d);
      expect(res.status).toBe(status);
      expect(parse(res.body)).toEqual({ error: `failed: ${kind}`, kind });
    }
  });

  it('hides unexpected errors', async () => {
    const d = deps({ generateQuiz: vi.fn(async () => Promise.reject(new Error('stack trace with secrets'))) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleRequest(req('POST', '/api/quiz', { sectionText: 'Text' }), d);
    expect(res.status).toBe(500);
    expect(String(res.body)).not.toContain('secrets');
  });
});

describe('GET /api/fetch', () => {
  it('returns the page as inert data', async () => {
    const res = await handleRequest(req('GET', '/api/fetch', undefined, 'url=https://example.com'), deps());
    expect(res.status).toBe(200);
    expect(res.headers['x-final-url']).toBe('https://example.com/');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(new TextDecoder().decode(res.body as Uint8Array)).toBe('<p>hi</p>');
  });

  it('passes on a clear message when the page cannot be fetched', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => Promise.reject(new FetchPageError(502, 'The site answered with HTTP 403.'))),
    });
    const res = await handleRequest(req('GET', '/api/fetch', undefined, 'url=https://example.com'), d);
    expect(res.status).toBe(502);
    expect(parse(res.body).error).toBe('The site answered with HTTP 403.');
  });
});

describe('sync routes', () => {
  it('stores a push and returns it on pull, per user', async () => {
    const d = deps();
    const record = { store: 'docs', id: 'd1', updatedAt: 5, data: { title: 'T' } };
    const pushed = await handleRequest(req('POST', '/api/sync/push', { records: [record] }), d);
    expect(parse(pushed.body)).toEqual({ accepted: 1 });

    const pulled = await handleRequest(req('POST', '/api/sync/pull', { since: 0 }), d);
    expect(parse(pulled.body)).toEqual({ records: [record], cursor: 1000 });

    const other = await handleRequest({ ...req('POST', '/api/sync/pull', { since: 0 }), userId: 'u2' }, d);
    expect(parse(other.body).records).toEqual([]);
  });

  it('rejects a malformed push', async () => {
    const res = await handleRequest(req('POST', '/api/sync/push', { records: [{ store: 'nope' }] }), deps());
    expect(res.status).toBe(400);
  });
});

describe('originals routes', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 a small file');
  const upload = (id: string, bytes: Uint8Array | null, userId = 'u1'): ApiRequest => ({
    ...req('PUT', `/api/originals/${id}`),
    bytes,
    userId,
  });

  it('stores a PDF, lists it and returns it, per user', async () => {
    const d = deps({ originals: new MemoryOriginalStore() });
    expect((await handleRequest(upload('d1', pdf), d)).status).toBe(204);

    expect(parse((await handleRequest(req('GET', '/api/originals'), d)).body)).toEqual({ ids: ['d1'] });
    const got = await handleRequest(req('GET', '/api/originals/d1'), d);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    expect(got.body).toEqual(pdf);

    const other = { ...req('GET', '/api/originals/d1'), userId: 'u2' };
    expect((await handleRequest(other, d)).status).toBe(404);
    expect(parse((await handleRequest({ ...req('GET', '/api/originals'), userId: 'u2' }, d)).body)).toEqual({ ids: [] });
  });

  it('deletes a PDF', async () => {
    const d = deps({ originals: new MemoryOriginalStore() });
    await handleRequest(upload('d1', pdf), d);
    expect((await handleRequest(req('DELETE', '/api/originals/d1'), d)).status).toBe(204);
    expect((await handleRequest(req('GET', '/api/originals/d1'), d)).status).toBe(404);
  });

  it('refuses uploads that are not a PDF, too large, or empty', async () => {
    const d = deps({ originals: new MemoryOriginalStore() });
    expect((await handleRequest(upload('d1', new TextEncoder().encode('<html>')), d)).status).toBe(415);
    expect((await handleRequest(upload('d1', null), d)).status).toBe(400);
    const huge = new Uint8Array(MAX_PDF_BYTES + 1);
    huge.set(pdf);
    expect((await handleRequest(upload('d1', huge), d)).status).toBe(413);
    expect(parse((await handleRequest(req('GET', '/api/originals'), d)).body)).toEqual({ ids: [] });
  });

  it('refuses ids that are not plain', async () => {
    const d = deps({ originals: new MemoryOriginalStore() });
    for (const id of ['..', '..%2Fsync', 'a.pdf', 'x'.repeat(101)]) {
      expect((await handleRequest(upload(id, pdf), d)).status).toBe(400);
      expect((await handleRequest(req('GET', `/api/originals/${id}`), d)).status).toBe(400);
    }
    expect((await handleRequest(upload('a/b', pdf), d)).status).toBe(404);
  });

  it('answers 501 when the server does not keep originals', async () => {
    expect((await handleRequest(req('GET', '/api/originals'), deps())).status).toBe(501);
    expect((await handleRequest(upload('d1', pdf), deps())).status).toBe(501);
  });

  it('deletes the PDF when a newer deletion of its text is pushed, but not an older one', async () => {
    const originals = new MemoryOriginalStore();
    const d = deps({ originals });
    const push = (records: unknown[]) => handleRequest(req('POST', '/api/sync/push', { records }), d);
    await handleRequest(upload('d1', pdf), d);
    await push([{ store: 'docs', id: 'd1', updatedAt: 10, data: { title: 'T' } }]);

    await push([{ store: 'docs', id: 'd1', updatedAt: 5, deleted: true }]);
    expect(await originals.list('u1')).toEqual(['d1']);

    await push([{ store: 'sections', id: 'd1', updatedAt: 20, deleted: true }]);
    expect(await originals.list('u1')).toEqual(['d1']);

    await push([{ store: 'docs', id: 'd1', updatedAt: 20, deleted: true }]);
    expect(await originals.list('u1')).toEqual([]);
  });
});

describe('routing', () => {
  it('answers 404 for unknown routes and wrong methods', async () => {
    expect((await handleRequest(req('GET', '/api/nope'), deps())).status).toBe(404);
    expect((await handleRequest(req('GET', '/api/quiz'), deps())).status).toBe(404);
  });
});
