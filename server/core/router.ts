/**
 * The backend's HTTP routes, independent of where they run. The Vite dev
 * server (devPlugin.ts) and the Lambda function (lambda.ts) both call
 * `handleRequest`.
 */
import {
  MAX_SECTION_CHARS,
  type ErrorResponse,
  type OriginalsListResponse,
  type QuizRequest,
  type QuizResponse,
  type SyncRecord,
} from '../../shared/api.ts';
import { FetchPageError, fetchPage } from './fetchPage.ts';
import { OriginalError, checkDocId, checkPdf, isSafeId, type OriginalStore } from './originals.ts';
import { QuizError, generateQuiz } from './quiz.ts';
import { SyncError, pull, push, type RecordStore } from './sync.ts';

export interface ApiRequest {
  method: string;
  /** Path starting with /api/. */
  path: string;
  query: URLSearchParams;
  body: string | null;
  /** The raw body of an upload (PUT /api/originals/<id>), instead of `body`. */
  bytes?: Uint8Array | null;
  /** The signed-in user. Authentication happens before the router is called. */
  userId: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface Dependencies {
  store: RecordStore;
  /** Where original PDFs are kept. Without it, the originals routes answer 501. */
  originals?: OriginalStore;
  /** Returns the Claude API key, or an empty string when none is configured. */
  getApiKey: () => Promise<string>;
  /** Overridable in tests. */
  generateQuiz?: typeof generateQuiz;
  fetchPage?: typeof fetchPage;
  now?: () => number;
}

const QUIZ_STATUS: Record<QuizError['kind'], number> = {
  'no-key': 503,
  auth: 502,
  'rate-limit': 429,
  network: 502,
  refusal: 422,
  invalid: 502,
  timeout: 504,
  api: 502,
};

function json(status: number, body: unknown): ApiResponse {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function fail(status: number, error: string, kind?: ErrorResponse['kind']): ApiResponse {
  return json(status, { error, kind } satisfies ErrorResponse);
}

function parseBody(body: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Headers for a stored PDF: a file to hand to pdf.js, never a page of the app's origin. */
const PDF_HEADERS = {
  'content-type': 'application/pdf',
  'content-disposition': 'attachment',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; sandbox",
  'x-content-type-options': 'nosniff',
};

const NO_CONTENT: ApiResponse = { status: 204, headers: { 'cache-control': 'no-store' }, body: '' };

/** GET /api/originals, and GET, PUT or DELETE /api/originals/<doc id>. */
async function handleOriginals(req: ApiRequest, store: OriginalStore | undefined, docId?: string): Promise<ApiResponse> {
  if (!store) return fail(501, 'This server does not keep original PDFs.');
  if (docId === undefined) {
    if (req.method !== 'GET') return fail(404, 'Not found.');
    return json(200, { ids: await store.list(req.userId) } satisfies OriginalsListResponse);
  }
  checkDocId(docId);
  switch (req.method) {
    case 'GET': {
      const data = await store.get(req.userId, docId);
      return data ? { status: 200, headers: PDF_HEADERS, body: data } : fail(404, 'The server has no original for this text.');
    }
    case 'PUT':
      await store.put(req.userId, docId, checkPdf(req.bytes));
      return NO_CONTENT;
    case 'DELETE':
      await store.delete(req.userId, docId);
      return NO_CONTENT;
    default:
      return fail(404, 'Not found.');
  }
}

export async function handleRequest(req: ApiRequest, deps: Dependencies): Promise<ApiResponse> {
  const now = (deps.now ?? Date.now)();
  const path = req.path.replace(/\/+$/, '');
  const route = `${req.method} ${path}`;

  try {
    if (path === '/api/originals') return await handleOriginals(req, deps.originals);
    const original = /^\/api\/originals\/([^/]+)$/.exec(path);
    if (original) return await handleOriginals(req, deps.originals, original[1]);

    switch (route) {
      case 'POST /api/quiz': {
        const body = parseBody(req.body) as Partial<QuizRequest> | null;
        const text = typeof body?.sectionText === 'string' ? body.sectionText.trim() : '';
        if (!text) return fail(400, 'There is no section text to write questions about.');
        if (text.length > MAX_SECTION_CHARS) {
          return fail(413, 'This section is too long for a quiz. Split it into smaller sections.');
        }
        const questions = await (deps.generateQuiz ?? generateQuiz)({
          apiKey: await deps.getApiKey(),
          sectionText: text,
          docTitle: typeof body?.docTitle === 'string' ? body.docTitle.slice(0, 300) : 'Untitled',
          count: typeof body?.count === 'number' ? body.count : 4,
        });
        return json(200, { questions } satisfies QuizResponse);
      }

      case 'GET /api/fetch': {
        const page = await (deps.fetchPage ?? fetchPage)(req.query.get('url'));
        return {
          status: 200,
          headers: {
            'content-type': page.contentType,
            'x-final-url': page.finalUrl,
            'cache-control': 'no-store',
            // The fetched page is data for the app to parse, never a document to display.
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
          },
          body: page.body,
        };
      }

      case 'POST /api/sync/push': {
        const body = parseBody(req.body);
        const originals = deps.originals;
        // A deleted text takes its stored PDF with it, whichever device deleted it.
        const dropOriginal = async (record: SyncRecord) => {
          if (!originals || record.store !== 'docs' || !record.deleted || !isSafeId(record.id)) return;
          await originals.delete(req.userId, record.id).catch((err) => console.error('Could not delete an original', err));
        };
        return json(200, await push(deps.store, req.userId, body?.records, now, dropOriginal));
      }

      case 'POST /api/sync/pull': {
        const body = parseBody(req.body);
        return json(200, await pull(deps.store, req.userId, body?.since, body?.pageToken, now));
      }

      default:
        return fail(404, 'Not found.');
    }
  } catch (err) {
    if (err instanceof QuizError) return fail(QUIZ_STATUS[err.kind], err.message, err.kind);
    if (err instanceof FetchPageError) return fail(err.status, err.message);
    if (err instanceof SyncError) return fail(400, err.message);
    if (err instanceof OriginalError) return fail(err.status, err.message);
    console.error('Unhandled API error', err);
    return fail(500, 'The server ran into an unexpected error.');
  }
}
