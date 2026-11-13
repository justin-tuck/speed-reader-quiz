import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuizError, generateQuiz, shuffledOrder } from './quiz';

const request = { docTitle: 'Doc', sectionText: 'Text', count: 4 };
const question = { question: 'Q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'Because.' };

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('generateQuiz', () => {
  it('posts the section to the backend and returns its questions', async () => {
    const fetchMock = respondWith(200, { questions: [question] });
    await expect(generateQuiz(request)).resolves.toEqual([question]);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/quiz');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(new Headers(init.headers).get('x-srq-client')).toBe('1');
  });

  it('turns a backend error into a QuizError with its kind and message', async () => {
    respondWith(429, { error: 'Slow down.', kind: 'rate-limit' });
    await expect(generateQuiz(request)).rejects.toMatchObject({ name: 'QuizError', kind: 'rate-limit', message: 'Slow down.' });
  });

  it('reports an unreachable server as offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const error = await generateQuiz(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuizError);
    expect((error as QuizError).kind).toBe('offline');
  });

  it('rejects an empty quiz', async () => {
    respondWith(200, { questions: [] });
    await expect(generateQuiz(request)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('shuffledOrder', () => {
  it('returns every index once', () => {
    expect([...shuffledOrder(4)].sort()).toEqual([0, 1, 2, 3]);
  });

  it('is driven by the random source', () => {
    expect(shuffledOrder(4, () => 0)).toEqual([1, 2, 3, 0]);
  });
});
