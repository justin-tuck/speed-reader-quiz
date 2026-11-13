/**
 * Runs the backend inside the Vite dev and preview servers, so the whole app
 * works on your machine with `npm run dev`:
 *   - no login (everything belongs to one local user)
 *   - synced data in .local-data/sync.json instead of DynamoDB
 *   - the Claude API key from ANTHROPIC_API_KEY in .env.local
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { API_HEADER, type AppConfig } from '../shared/api.ts';
import { handleRequest } from './core/router.ts';
import { siteContentSecurityPolicy } from './securityHeaders.ts';
import { FileStore } from './stores/fileStore.ts';

const LOCAL_USER = 'local';
const MAX_BODY_BYTES = 6 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Uint8Array) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}

export function localBackend(): Plugin {
  let root = process.cwd();
  let mode = 'development';
  let store: FileStore | null = null;

  // Read on every request so editing .env.local takes effect without a restart.
  const getApiKey = async () => (loadEnv(mode, root, 'ANTHROPIC_').ANTHROPIC_API_KEY ?? '').trim();

  const api = async (req: IncomingMessage, res: ServerResponse) => {
    // Without a login, this header is what stops other websites open in the
    // same browser from calling the local API.
    if (req.headers[API_HEADER] !== '1') {
      return send(res, 403, { 'content-type': 'application/json' }, '{"error":"Missing request header."}');
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      store ??= new FileStore(path.join(root, '.local-data', 'sync.json'));
      const response = await handleRequest(
        {
          method: req.method ?? 'GET',
          path: `/api${url.pathname}`,
          query: url.searchParams,
          body: await readBody(req),
          userId: LOCAL_USER,
        },
        { store, getApiKey },
      );
      send(res, response.status, response.headers, response.body);
    } catch {
      send(res, 500, { 'content-type': 'application/json' }, '{"error":"The local server ran into an error."}');
    }
  };

  const config = (_req: IncomingMessage, res: ServerResponse) => {
    const body: AppConfig = { auth: null };
    send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(body));
  };

  return {
    name: 'local-backend',
    configResolved(resolved) {
      root = resolved.root;
      mode = resolved.mode;
    },
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => void api(req, res));
      server.middlewares.use('/config.json', config);
    },
    configurePreviewServer(server) {
      // The preview server sends the same content security policy as the
      // deployed site, so a build can be checked against it locally.
      server.middlewares.use((_req, res, next) => {
        res.setHeader('content-security-policy', siteContentSecurityPolicy([]));
        next();
      });
      server.middlewares.use('/api', (req, res) => void api(req, res));
      server.middlewares.use('/config.json', config);
    },
  };
}
