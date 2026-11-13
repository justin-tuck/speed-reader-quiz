import { describe, expect, it, vi } from 'vitest';
import { FetchPageError } from './fetchPage.ts';
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

describe('routing', () => {
  it('answers 404 for unknown routes and wrong methods', async () => {
    expect((await handleRequest(req('GET', '/api/nope'), deps())).status).toBe(404);
    expect((await handleRequest(req('GET', '/api/quiz'), deps())).status).toBe(404);
  });
});
