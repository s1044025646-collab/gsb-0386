/**
 * CLI：
 *   node dist/src/cli.js serve [--port N] [--data DIR]
 *   node dist/src/cli.js create --values "5,1,4,1" [--data DIR]
 *   node dist/src/cli.js add --id 1 --expect 0 --l 0 --r 3 --delta 2
 *   node dist/src/cli.js query --id 1 --l 0 --r 4 [--version 2] [--trace]
 *   node dist/src/cli.js explain --id 1 --version 1
 *   node dist/src/cli.js export --id 1 [--version 2]
 *   node dist/src/cli.js verify --id 1 [--version 2]
 *   node dist/src/cli.js demo
 */
import * as path from 'node:path';
import { Store } from './store';
import { Service, parseBigIntParam, parseIndex } from './service';
import { TraceEvent } from './segtree';
import { startServer } from './server';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

function parseArgs(argv: string[]): { cmd: string; opts: Map<string, string> } {
  const [cmd = 'help', ...rest] = argv;
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts.set(key, next);
        i++;
      } else {
        opts.set(key, 'true');
      }
    }
  }
  return { cmd, opts };
}

function opt(opts: Map<string, string>, key: string, dflt?: string): string {
  const v = opts.get(key);
  if (v === undefined) {
    if (dflt !== undefined) return dflt;
    throw new Error(`缺少参数 --${key}`);
  }
  return v;
}

function printTraceTable(events: TraceEvent[]): void {
  if (events.length === 0) {
    console.log('（无节点访问：空区间）');
    return;
  }
  const rows = events.map((e) => ({
    节点: e.node,
    区间: `[${e.l}, ${e.r})`,
    动作: e.action,
    标记前: e.tagBefore,
    标记后: e.tagAfter,
    最小值前: e.minBefore,
    最小值后: e.minAfter,
    来源下标: e.srcIndex,
  }));
  console.table(rows);
}

async function main(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const dataDir = opt(opts, 'data', DEFAULT_DATA_DIR);

  if (cmd === 'serve') {
    const port = Number(opt(opts, 'port', '0'));
    const service = new Service(new Store(dataDir));
    await startServer(service, port);
    return;
  }

  const store = new Store(dataDir);
  const service = new Service(store);
  try {
    switch (cmd) {
      case 'create': {
        const values = opt(opts, 'values').split(',').filter((s) => s.length > 0)
          .map((s, i) => parseBigIntParam(s.trim(), `values[${i}]`));
        console.log(JSON.stringify(service.createArray(values)));
        break;
      }
      case 'add': {
        const id = parseIndex(opt(opts, 'id'), 'id');
        const expect = parseIndex(opt(opts, 'expect'), 'expect');
        const l = parseIndex(opt(opts, 'l'), 'l');
        const r = parseIndex(opt(opts, 'r'), 'r');
        const delta = parseBigIntParam(opt(opts, 'delta'), 'delta');
        const res = service.add(id, expect, [{ l, r, delta }]);
        console.log(`新版本: ${res.version}`);
        printTraceTable(res.results[0]?.explain ?? []);
        break;
      }
      case 'query': {
        const id = parseIndex(opt(opts, 'id'), 'id');
        const l = parseIndex(opt(opts, 'l'), 'l');
        const r = parseIndex(opt(opts, 'r'), 'r');
        const v = opts.has('version') ? parseIndex(opt(opts, 'version'), 'version') : undefined;
        const res = service.query(id, l, r, v);
        console.log(res.result === null
          ? `版本 ${res.version}: 空区间，无最小值`
          : `版本 ${res.version}: min=${res.result.min} 最左下标=${res.result.index}`);
        if (opts.has('trace')) printTraceTable(res.explain);
        break;
      }
      case 'explain': {
        const id = parseIndex(opt(opts, 'id'), 'id');
        const v = parseIndex(opt(opts, 'version'), 'version');
        printTraceTable(service.explain(id, v));
        break;
      }
      case 'export': {
        const id = parseIndex(opt(opts, 'id'), 'id');
        const v = opts.has('version') ? parseIndex(opt(opts, 'version'), 'version') : undefined;
        const res = service.exportArray(id, v);
        console.log(`版本 ${res.version}: [${res.values.join(', ')}]`);
        break;
      }
      case 'verify': {
        const id = parseIndex(opt(opts, 'id'), 'id');
        const v = opts.has('version') ? parseIndex(opt(opts, 'version'), 'version') : undefined;
        const res = service.verify(id, v);
        console.log(res.ok
          ? `版本 ${res.version}: 结构核验通过`
          : `版本 ${res.version}: 核验失败 ${JSON.stringify(res.mismatches)}`);
        break;
      }
      case 'demo': {
        runDemo(service);
        break;
      }
      default:
        console.log('命令: serve | create | add | query | explain | export | verify | demo');
    }
  } finally {
    store.close();
  }
}

function runDemo(service: Service): void {
  console.log('=== 演示 1: [5,1,4,1] 上 [0,3)+2，再 [1,4)-3 ===');
  const { id } = service.createArray([5n, 1n, 4n, 1n]);
  const u1 = service.add(id, 0, [{ l: 0, r: 3, delta: 2n }]);
  console.log(`\n更新1 [0,3)+2 -> 版本 ${u1.version}`);
  printTraceTable(u1.results[0].explain);
  const u2 = service.add(id, 1, [{ l: 1, r: 4, delta: -3n }]);
  console.log(`\n更新2 [1,4)-3 -> 版本 ${u2.version}`);
  printTraceTable(u2.results[0].explain);
  const exp = service.exportArray(id);
  console.log(`\n最终数组: [${exp.values.join(', ')}]（期望 [7, 0, 3, -2]）`);

  console.log('\n=== 演示 2: 并列最小取最左 ===');
  const { id: d2 } = service.createArray([2n, 2n, 2n]);
  service.add(d2, 0, [{ l: 0, r: 3, delta: 1n }]);
  const q2 = service.query(d2, 0, 3);
  console.log(`[2,2,2] 全段+1 后查询: min=${q2.result!.min} 下标=${q2.result!.index}（应为最左 0）`);

  console.log('\n=== 演示 3: 全段标记未下推时的局部查询 ===');
  const { id: d3 } = service.createArray([5n, 1n, 4n, 1n]);
  service.add(d3, 0, [{ l: 0, r: 4, delta: 10n }]);
  const q3 = service.query(d3, 1, 2);
  console.log('全段 +10（标记留在根）后查询 [1,2)（触发下推）:');
  printTraceTable(q3.explain);
  console.log(`结果: min=${q3.result!.min} 下标=${q3.result!.index}`);
  const v = service.verify(d3);
  console.log(`结构核验: ${v.ok ? '通过' : '失败'}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
