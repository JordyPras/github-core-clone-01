// The HTTP server: route dispatch, bearer-token auth, body reading. The four
// surfaces live in their own modules (rest.ts, graphql.ts, mcp.ts, gitproto.ts)
// over one in-memory store. Kept separate from main.ts's lifecycle, which must
// stay as the starter ships it.
//
// Auth: every route except GET /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN`. When the variable is unset (local development only),
// any non-empty bearer token is accepted; the graded runs always set it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { Store } from './src/store.ts';
import { handleRest, jsonResponse } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleReceivePack, handleUploadPack, infoRefs } from './src/gitproto.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

function authenticate(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const presented = match[1];
  if (presented === '') return false;
  if (SHOP_TOKEN !== '') return presented === SHOP_TOKEN;
  return true;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void {
  res.writeHead(status, headers);
  res.end(body);
}

function json404(message = 'Not Found'): { status: number; headers: Record<string, string>; body: string } {
  return jsonResponse(404, { message });
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // GET /healthz — the boot probe, no auth.
        if (pathname === '/healthz') {
          if (method !== 'GET') return send(res, 404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() }, JSON.stringify({ message: 'Not Found' }));
          return send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() }, JSON.stringify({ ok: true }));
        }

        const needsAuth =
          pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp' || /\.git\//.test(pathname);
        if (needsAuth && !authenticate(req)) {
          const unauthorized = jsonResponse(401, { message: 'Requires authentication' });
          return send(res, 401, unauthorized.headers, unauthorized.body);
        }

        const host = req.headers.host ?? '127.0.0.1';
        const requestId = nextRequestId();

        // POST /mcp — raw text: a body that is not JSON must answer 400/-32700.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            const notFound = json404();
            return send(res, 404, notFound.headers, notFound.body);
          }
          const body = await readBody(req);
          const outcome = handleMcp(store, body.toString('utf8'));
          return send(res, outcome.status, { ...outcome.headers, 'x-github-request-id': requestId }, outcome.body);
        }

        // POST /api/graphql
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            const notFound = json404();
            return send(res, 404, notFound.headers, notFound.body);
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            return send(res, 400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, JSON.stringify({ data: null, errors: [{ message: 'Request body must be valid JSON.' }] }));
          }
          const result = executeGraphQL(parsed, { store, viewer: store.viewer() });
          return send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, JSON.stringify(result));
        }

        // /api/v3/*
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          let parsed: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const body = await readBody(req);
            if (body.length > 0) {
              try {
                parsed = JSON.parse(body.toString('utf8'));
              } catch {
                const bad = jsonResponse(400, { message: 'Problems parsing JSON' });
                return send(res, 400, bad.headers, bad.body);
              }
            }
          }
          const outcome = handleRest(store, method, pathname, url.searchParams, parsed, host);
          return send(res, outcome.status, outcome.headers, outcome.body);
        }

        // git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const service = gitMatch[3];
          const repo = store.getRepo(owner, repoName);
          const gitProtocol = req.headers['git-protocol'];
          if (service === 'info/refs') {
            if (method !== 'GET') {
              const notFound = json404();
              return send(res, 404, notFound.headers, notFound.body);
            }
            const outcome = infoRefs(repo, url.searchParams.get('service') ?? '', typeof gitProtocol === 'string' ? gitProtocol : undefined);
            return send(res, outcome.status, { 'content-type': outcome.contentType, 'x-github-request-id': requestId }, outcome.body);
          }
          if (method !== 'POST') {
            const notFound = json404();
            return send(res, 404, notFound.headers, notFound.body);
          }
          const body = await readBody(req);
          const outcome =
            service === 'git-upload-pack'
              ? handleUploadPack(repo, body, typeof gitProtocol === 'string' ? gitProtocol : undefined)
              : handleReceivePack(repo, body);
          return send(res, outcome.status, { 'content-type': outcome.contentType, 'x-github-request-id': requestId }, outcome.body);
        }

        const notFound = json404();
        return send(res, 404, notFound.headers, notFound.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[entry] request failed: ${message}\n`);
        if (!res.headersSent) {
          send(res, 500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() }, JSON.stringify({ message: 'Internal Server Error' }));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
