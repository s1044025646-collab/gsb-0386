/** HTTP API 服务器（仅本地）。默认端口 0 = 自动选择空闲端口。 */
import * as http from 'node:http';
import { Service, ApiError, parseBigIntParam, parseIndex } from './service';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('BAD_JSON', '请求体不是合法 JSON');
  }
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const body = req.method === 'POST' ? await readBody(req) : {};

      // POST /arrays { values: string[] }
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'arrays') {
        if (!Array.isArray(body.values)) {
          throw new ApiError('BAD_REQUEST', '需要 values 数组（十进制整数字符串）');
        }
        const values = body.values.map((v: unknown, i: number) =>
          parseBigIntParam(v, `values[${i}]`));
        send(res, 201, service.createArray(values));
        return;
      }

      const id = parts[0] === 'arrays' && parts[1] ? Number(parts[1]) : NaN;
      if (!Number.isInteger(id)) throw new ApiError('NOT_FOUND', '路由不存在', 404);
      const sub = parts[2];

      // POST /arrays/:id/updates { expectedVersion, ops: [{l,r,delta}] }
      if (req.method === 'POST' && sub === 'updates') {
        const expectedVersion = parseIndex(body.expectedVersion, 'expectedVersion');
        if (!Array.isArray(body.ops)) throw new ApiError('BAD_REQUEST', '需要 ops 数组');
        const ops = body.ops.map((o: any, i: number) => ({
          l: parseIndex(o.l, `ops[${i}].l`),
          r: parseIndex(o.r, `ops[${i}].r`),
          delta: parseBigIntParam(o.delta, `ops[${i}].delta`),
        }));
        send(res, 200, service.add(id, expectedVersion, ops));
        return;
      }

      // GET /arrays/:id/query?l=&r=&version=
      if (req.method === 'GET' && sub === 'query') {
        const l = parseIndex(url.searchParams.get('l'), 'l');
        const r = parseIndex(url.searchParams.get('r'), 'r');
        const v = url.searchParams.get('version');
        send(res, 200, service.query(id, l, r, v === null ? undefined : parseIndex(v, 'version')));
        return;
      }

      // GET /arrays/:id/export?version=
      if (req.method === 'GET' && sub === 'export') {
        const v = url.searchParams.get('version');
        send(res, 200, service.exportArray(id, v === null ? undefined : parseIndex(v, 'version')));
        return;
      }

      // GET /arrays/:id/operations/:version/explain
      if (req.method === 'GET' && sub === 'operations' && parts[4] === 'explain') {
        send(res, 200, { explain: service.explain(id, parseIndex(parts[3], 'version')) });
        return;
      }

      // POST /arrays/:id/verify { version? }
      if (req.method === 'POST' && sub === 'verify') {
        const v = body.version === undefined ? undefined : parseIndex(body.version, 'version');
        send(res, 200, service.verify(id, v));
        return;
      }

      throw new ApiError('NOT_FOUND', '路由不存在', 404);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
      }
    }
  });
}

export function startServer(service: Service, port: number): Promise<http.Server> {
  const server = createServer(service);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${p}`);
      resolve(server);
    });
  });
}
