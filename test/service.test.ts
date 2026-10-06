import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { TreeService } from '../src/service.js';
import { AppError } from '../src/errors.js';

let dir: string;
let dbPath: string;

function makeService(): TreeService {
  return new TreeService(new Store(dbPath));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lst-'));
  dbPath = join(dir, 'test.db');
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('创建校验：空数组拒绝、长度越界拒绝、非法整数拒绝', () => {
  const s = makeService();
  assert.throws(() => s.create('x', 0), (e: AppError) => e.code === 'LENGTH_OUT_OF_RANGE');
  assert.throws(() => s.create('x', 100001), (e: AppError) => e.code === 'LENGTH_OUT_OF_RANGE');
  assert.throws(() => s.create('x', 2, ['1', '1.5']), (e: AppError) => e.code === 'INVALID_INTEGER');
  assert.throws(() => s.create('x', 2, ['1']), (e: AppError) => e.code === 'VALIDATION_ERROR');
});

test('越界、左右颠倒、小数下标均被拒绝', () => {
  const s = makeService();
  s.create('a', 4, ['5', '1', '4', '1']);
  assert.throws(() => s.add('a', 0, { l: 0, r: 5, delta: '1' }), (e: AppError) => e.code === 'INDEX_OUT_OF_BOUNDS');
  assert.throws(() => s.add('a', 0, { l: 3, r: 1, delta: '1' }), (e: AppError) => e.code === 'L_GT_R');
  assert.throws(() => s.add('a', 0, { l: 0.5, r: 2, delta: '1' } as never), (e: AppError) => e.code === 'INVALID_INDEX');
  assert.throws(() => s.add('a', 0, { l: 0, r: 2, delta: '2.0' }), (e: AppError) => e.code === 'INVALID_INTEGER');
  assert.throws(() => s.query('missing', 0, 1), (e: AppError) => e.code === 'ARRAY_NOT_FOUND');
});

test('版本不符拒绝更新；空区间更新不产生版本', () => {
  const s = makeService();
  s.create('a', 3);
  s.add('a', 0, { l: 0, r: 3, delta: '5' });
  assert.throws(() => s.add('a', 0, { l: 0, r: 1, delta: '1' }), (e: AppError) => e.code === 'VERSION_MISMATCH');
  const empty = s.add('a', 1, { l: 2, r: 2, delta: '9' });
  assert.equal(empty.unchanged, true);
  assert.equal(empty.version, 1);
  assert.equal(s.meta('a').version, 1);
});

test('批量内任一非法 => 整批回滚，状态与版本不变', () => {
  const s = makeService();
  s.create('a', 4, ['0', '0', '0', '0']);
  assert.throws(
    () =>
      s.batchAdd('a', 0, [
        { l: 0, r: 2, delta: '1' },
        { l: 3, r: 1, delta: '1' },
      ]),
    (e: AppError) => e.code === 'L_GT_R',
  );
  assert.deepEqual(s.export('a').values, ['0', '0', '0', '0']);
  assert.equal(s.meta('a').version, 0);

  // 参数合法但版本不符：同样整体回滚
  s.batchAdd('a', 0, [
    { l: 0, r: 1, delta: '2' },
    { l: 1, r: 3, delta: '4' },
  ]);
  assert.equal(s.meta('a').version, 1);
  assert.throws(
    () => s.batchAdd('a', 0, [{ l: 0, r: 4, delta: '1' }]),
    (e: AppError) => e.code === 'VERSION_MISMATCH',
  );
  assert.deepEqual(s.export('a').values, ['2', '4', '4', '0']);
  assert.equal(s.meta('a').version, 1);
});

test('重启后保留未下推效果；历史版本回放一致；解释可查', () => {
  let s = makeService();
  s.create('a', 4, ['5', '1', '4', '1']);
  // 全段加，标记停在根节点（未下推）
  s.add('a', 0, { l: 0, r: 4, delta: '7' });
  s.add('a', 1, { l: 1, r: 3, delta: '-2' });

  // 模拟重启：重新打开同一个 SQLite 文件
  s = makeService();
  assert.deepEqual(s.export('a').values, ['12', '6', '9', '8']);
  assert.deepEqual(s.verify('a'), { ok: true, version: 2 });
  // 重启后继续操作，与不中断一致
  s.add('a', 2, { l: 0, r: 4, delta: '1' });
  assert.deepEqual(s.export('a').values, ['13', '7', '10', '9']);

  // 历史版本通过回放恢复
  assert.deepEqual(s.export('a', 0).values, ['5', '1', '4', '1']);
  assert.deepEqual(s.export('a', 1).values, ['12', '8', '11', '8']);
  assert.deepEqual(s.export('a', 2).values, ['12', '6', '9', '8']);
  assert.equal(s.query('a', 0, 4, 1).min, '8');
  assert.throws(() => s.export('a', 99), (e: AppError) => e.code === 'VERSION_NOT_FOUND');

  const ex = s.explain('a', 1);
  assert.equal(ex.kind, 'add');
  assert.ok(Array.isArray(ex.trace));
});

test('全段与窄段交错、负加量、单元素', () => {
  const s = makeService();
  s.create('one', 1, ['100']);
  s.add('one', 0, { l: 0, r: 1, delta: '-200' });
  const q = s.query('one', 0, 1);
  assert.equal(q.min, '-100');
  assert.equal(q.pos, 0);
  assert.deepEqual(s.verify('one'), { ok: true, version: 1 });

  s.create('mix', 5);
  s.batchAdd('mix', 0, [
    { l: 0, r: 5, delta: '10' },
    { l: 2, r: 3, delta: '-10' },
    { l: 0, r: 5, delta: '-3' },
    { l: 0, r: 1, delta: '3' },
  ]);
  assert.deepEqual(s.export('mix').values, ['10', '7', '-3', '7', '7']);
  assert.equal(s.query('mix', 0, 5).pos, 2);
});
