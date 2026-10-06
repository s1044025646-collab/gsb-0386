import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { TreeService } from './service.js';
import { Store } from './store.js';
import { AppError } from './errors.js';

const PORT = Number.parseInt(process.env.PORT ?? '0', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'segment-tree.db');

const store = new Store(DB_PATH);
const service = new TreeService(store);

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown;
}

const routes: Route[] = [
  { method: 'POST', pattern: /^\/api\/arrays$/, handler: (_p, body) => {
      const b = body as { id?: string; length?: number; values?: string[] };
      return service.create(b.id ?? '', b.length, b.values);
    } },
  { method: 'GET', pattern: /^\/api\/arrays\/([^/]+)$/, handler: (p) => service.meta(p[0]!) },
  { method: 'POST', pattern: /^\/api\/arrays\/([^/]+)\/add$/, handler: (p, body) => {
      const b = body as { expectedVersion?: unknown; l?: number; r?: number; delta?: string };
      return service.add(p[0]!, b.expectedVersion, { l: b.l as number, r: b.r as number, delta: b.delta as string });
    } },
  { method: 'POST', pattern: /^\/api\/arrays\/([^/]+)\/batch-add$/, handler: (p, body) => {
      const b = body as { expectedVersion?: unknown; ops?: unknown };
      return service.batchAdd(p[0]!, b.expectedVersion, b.ops);
    } },
  { method: 'GET', pattern: /^\/api\/arrays\/([^/]+)\/query$/, handler: (p, _b, q) => {
      const at = q.get('version');
      return service.query(
        p[0]!,
        Number(q.get('l')),
        Number(q.get('r')),
        at === null ? undefined : Number(at),
      );
    } },
  { method: 'GET', pattern: /^\/api\/arrays\/([^/]+)\/operations\/(\d+)$/, handler: (p) => service.explain(p[0]!, Number(p[1])) },
  { method: 'GET', pattern: /^\/api\/arrays\/([^/]+)\/versions$/, handler: (p) => ({ versions: service.listVersions(p[0]!) }) },
  { method: 'GET', pattern: /^\/api\/arrays\/([^/]+)\/export$/, handler: (p, _b, q) => {
      const at = q.get('version');
      return service.export(p[0]!, at === null ? undefined : Number(at));
    } },
  { method: 'POST', pattern: /^\/api\/arrays\/([^/]+)\/verify$/, handler: (p) => service.verify(p[0]!) },
];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new AppError('VALIDATION_ERROR', '请求体过大（上限 2MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('VALIDATION_ERROR', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, db: DB_PATH });
      return;
    }
    const route = routes.find((rt) => rt.method === req.method && rt.pattern.test(url.pathname));
    if (!route) {
      send(res, 404, { error: { code: 'VALIDATION_ERROR', message: '未找到对应路由' } });
      return;
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const match = url.pathname.match(route.pattern)!;
    const params: Record<string, string> = {};
    match.slice(1).forEach((g, i) => (params[String(i)] = decodeURIComponent(g)));
    const data = route.handler(params, body, url.searchParams);
    send(res, 200, { data });
  } catch (err) {
    if (err instanceof AppError) {
      send(res, 400, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    } else {
      send(res, 500, { error: { code: 'VALIDATION_ERROR', message: (err as Error).message } });
    }
  }
});

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(JSON.stringify({ started: true, host: HOST, port, db: DB_PATH }));
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
