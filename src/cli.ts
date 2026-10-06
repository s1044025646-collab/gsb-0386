import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from './store.js';
import { TreeService } from './service.js';
import type { TraceEvent } from './segmentTree.js';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'cli-segment-tree.db');

function openService(reset = false): TreeService {
  if (reset) {
    try {
      rmSync(DB_PATH, { force: true });
      rmSync(DB_PATH + '-wal', { force: true });
      rmSync(DB_PATH + '-shm', { force: true });
    } catch {
      /* 忽略 */
    }
  }
  return new TreeService(new Store(DB_PATH));
}

function fmt(v: string | undefined | null): string {
  return v === undefined || v === null ? '·' : v;
}

/** 以节点变化表打印解释。 */
export function renderTraceTable(trace: TraceEvent[]): string {
  const lines: string[] = [];
  lines.push(
    ['事件', '节点', '区间', 'lazy:前->后', 'min:前->后', 'pos:前->后', '说明']
      .join(' | '),
  );
  lines.push('-'.repeat(110));
  for (const e of trace) {
    const lazy = e.lazyBefore !== undefined || e.lazyAfter !== undefined
      ? `${fmt(e.lazyBefore)} -> ${fmt(e.lazyAfter)}`
      : '·';
    const min = e.minBefore !== undefined || e.minAfter !== undefined
      ? `${fmt(e.minBefore)} -> ${fmt(e.minAfter)}`
      : '·';
    const pos = e.posBefore !== undefined || e.posAfter !== undefined
      ? `${e.posBefore ?? '·'} -> ${e.posAfter === undefined ? '·' : e.posAfter}`
      : '·';
    lines.push(
      [
        e.kind.padEnd(13),
        String(e.node).padStart(3),
        `[${e.segL},${e.segR})`.padEnd(9),
        lazy.padEnd(14),
        min.padEnd(18),
        pos.padEnd(10),
        e.note ?? '',
      ].join(' | '),
    );
  }
  return lines.join('\n');
}

function demo(): void {
  const service = openService(true);
  console.log('=== 演示 1：[5,1,4,1]，[0,3)+2，[1,4)-3 ===');
  console.log('创建数组 demo，长度 4，初值 [5,1,4,1]');
  service.create('demo', 4, ['5', '1', '4', '1']);

  console.log('\n--- 操作 v1：[0,3) += 2 的节点变化表 ---');
  const v1 = service.add('demo', 0, { l: 0, r: 3, delta: '2' });
  console.log(renderTraceTable(v1.trace));
  console.log('v1 后逻辑数组:', service.export('demo', 1).values);

  console.log('\n--- 操作 v2：[1,4) += -3 的节点变化表 ---');
  const v2 = service.add('demo', 1, { l: 1, r: 4, delta: '-3' });
  console.log(renderTraceTable(v2.trace));
  const finalArr = service.export('demo', 2);
  console.log('最终逻辑数组（v2）:', finalArr.values, '（期望 7,0,3,-2）');

  const q = service.query('demo', 0, 4);
  console.log(`全段最小值 = ${q.min}，最左位置 = ${q.pos}（期望 -2 @ 3）`);

  console.log('\n=== 演示 2：并列最小选最左 ===');
  service.create('tie', 5, ['3', '1', '1', '1', '2']);
  const tq = service.query('tie', 0, 5);
  console.log(`[3,1,1,1,2] 最小值=${tq.min} 位置=${tq.pos}（期望 1 @ 1，而不是 2 或 3）`);

  console.log('\n=== 演示 3：全段标记未下推时的局部查询 ===');
  service.create('tag', 4, ['0', '0', '0', '0']);
  const addAll = service.add('tag', 0, { l: 0, r: 4, delta: '10' });
  console.log(renderTraceTable(addAll.trace));
  const verify = service.verify('tag');
  console.log('全段 +10 后核验:', JSON.stringify(verify), '（标记仍留在根节点，未下推）');
  const local = service.query('tag', 0, 2);
  console.log('只查询 [0,2)：', JSON.stringify({ min: local.min, pos: local.pos }), '（期望 10 @ 0；查询不改树、不下推落盘）');
  console.log('查询后再次核验:', JSON.stringify(service.verify('tag')));

  console.log('\n=== 演示 4：历史版本读取（回放恢复）===');
  console.log('v0:', service.export('demo', 0).values, ' v1:', service.export('demo', 1).values, ' v2:', service.export('demo', 2).values);

  console.log('\n=== 演示 5：批量失败整体回滚 ===');
  try {
    service.batchAdd('demo', 2, [{ l: 0, r: 2, delta: '1' }, { l: 3, r: 1, delta: '1' }]);
  } catch (err) {
    console.log('批量被拒绝:', (err as Error).message);
  }
  console.log('回滚后数组仍是:', service.export('demo').values, '版本仍是:', service.meta('demo').version);

  console.log('\n=== 演示 6：大整数（超过安全整数）===');
  service.create('big', 2, ['9007199254740993', '-9007199254740993']);
  service.add('big', 0, { l: 1, r: 2, delta: '-9007199254740997' });
  const bq = service.query('big', 0, 2);
  console.log('最小值:', bq.min, '@', bq.pos, '（期望 -18014398509481990 @ 1）');

  console.log('\n演示完成。数据库文件:', DB_PATH);
}

function printUsage(): void {
  console.log(`用法:
  npm run demo                                  运行内置演示
  npm run cli -- create <id> <n> [v0,v1,...]    创建长度 n 的数组（默认全 0）
  npm run cli -- add <id> <expectedVer> <l> <r> <delta>      单次区间加（半开 [l,r)）
  npm run cli -- batch <id> <expectedVer> <jsonOps>          批量区间加
  npm run cli -- query <id> <l> <r> [version]   查区间最小值与最左位置
  npm run cli -- export <id> [version]          导出逻辑数组
  npm run cli -- explain <id> <version>         查看某次更新的节点变化表
  npm run cli -- verify <id>                    独立结构核验
  npm run cli -- versions <id>                  列出历史版本

示例:
  npm run cli -- create a 4 5,1,4,1
  npm run cli -- add a 0 0 3 2
  npm run cli -- query a 0 4`);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }
  if (cmd === 'demo') {
    demo();
    return;
  }
  const service = openService(false);
  try {
    switch (cmd) {
      case 'create': {
        const [id, nStr, values] = rest;
        const n = Number(nStr);
        const vals = values === undefined ? undefined : values.split(',').map((s) => s.trim());
        console.log(JSON.stringify(service.create(id!, n, vals)));
        break;
      }
      case 'add': {
        const [id, ver, l, r, delta] = rest;
        const out = service.add(id!, Number(ver), { l: Number(l), r: Number(r), delta: delta! });
        console.log(JSON.stringify({ version: out.version, unchanged: out.unchanged }));
        console.log(renderTraceTable(out.trace));
        break;
      }
      case 'batch': {
        const [id, ver, opsJson] = rest;
        const out = service.batchAdd(id!, Number(ver), JSON.parse(opsJson!));
        console.log(JSON.stringify({ version: out.version, applied: out.applied }));
        break;
      }
      case 'query': {
        const [id, l, r, ver] = rest;
        console.log(JSON.stringify(service.query(id!, Number(l), Number(r), ver === undefined ? undefined : Number(ver)), null, 2));
        break;
      }
      case 'export': {
        const [id, ver] = rest;
        console.log(JSON.stringify(service.export(id!, ver === undefined ? undefined : Number(ver))));
        break;
      }
      case 'explain': {
        const [id, ver] = rest;
        const ex = service.explain(id!, Number(ver));
        console.log(`版本 ${ex.version}（${ex.kind}） payload=${JSON.stringify(ex.payload)}`);
        console.log(renderTraceTable(ex.trace as TraceEvent[]));
        break;
      }
      case 'verify':
        console.log(JSON.stringify(service.verify(rest[0]!)));
        break;
      case 'versions':
        console.log(JSON.stringify(service.listVersions(rest[0]!)));
        break;
      default:
        printUsage();
    }
  } catch (err) {
    const e = err as { code?: string; message: string };
    console.error(`错误 [${e.code ?? 'UNKNOWN'}]: ${e.message}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
