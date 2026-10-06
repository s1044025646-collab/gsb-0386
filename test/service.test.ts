import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/store';
import { Service, ApiError } from '../src/service';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'segtree-'));
}

test('创建校验：空数组拒绝', () => {
  const s = new Service(new Store(tmpDir()));
  assert.throws(() => s.createArray([]), (e: ApiError) => e.code === 'EMPTY_ARRAY');
});

test('版本不符拒绝；批量内任一非法整体回滚', () => {
  const s = new Service(new Store(tmpDir()));
  const { id } = s.createArray([1n, 2n, 3n]);
  assert.throws(() => s.add(id, 5, [{ l: 0, r: 1, delta: 1n }]),
    (e: ApiError) => e.code === 'VERSION_MISMATCH');
  assert.throws(
    () => s.add(id, 0, [
      { l: 0, r: 2, delta: 10n },
      { l: 2, r: 9, delta: 1n },
    ]),
    (e: ApiError) => e.code === 'OUT_OF_RANGE');
  assert.equal(s.exportArray(id).version, 0);
  assert.deepEqual(s.exportArray(id).values, ['1', '2', '3']);
  assert.throws(() => s.add(id, 0, [{ l: 2, r: 1, delta: 1n }]),
    (e: ApiError) => e.code === 'INVERTED_RANGE');
});

test('查询与导出定位同一版本；历史版本可回放', () => {
  const s = new Service(new Store(tmpDir()));
  const { id } = s.createArray([5n, 1n, 4n, 1n]);
  s.add(id, 0, [{ l: 0, r: 3, delta: 2n }]);
  s.add(id, 1, [{ l: 1, r: 4, delta: -3n }]);
  assert.deepEqual(s.exportArray(id, 0).values, ['5', '1', '4', '1']);
  assert.deepEqual(s.exportArray(id, 1).values, ['7', '3', '6', '1']);
  assert.deepEqual(s.exportArray(id, 2).values, ['7', '0', '3', '-2']);
  assert.deepEqual(s.query(id, 0, 4, 1).result, { min: '1', index: 3 });
  assert.deepEqual(s.query(id, 0, 4, 2).result, { min: '-2', index: 3 });
  assert.throws(() => s.query(id, 0, 4, 99),
    (e: ApiError) => e.code === 'VERSION_NOT_FOUND');
});

test('重启后保留未下推效果，继续操作一致', () => {
  const dir = tmpDir();
  let s = new Service(new Store(dir));
  const { id } = s.createArray([5n, 1n, 4n, 1n]);
  s.add(id, 0, [{ l: 0, r: 4, delta: 10n }]);
  s = new Service(new Store(dir));
  assert.deepEqual(s.exportArray(id).values, ['15', '11', '14', '11']);
  s.add(id, 1, [{ l: 1, r: 2, delta: -20n }]);
  assert.deepEqual(s.exportArray(id).values, ['15', '-9', '14', '11']);
  assert.deepEqual(s.query(id, 0, 4).result, { min: '-9', index: 1 });
  assert.equal(s.verify(id).ok, true);
});

test('解释记录覆盖/下推/合并；核验通过', () => {
  const s = new Service(new Store(tmpDir()));
  const { id } = s.createArray([5n, 1n, 4n, 1n]);
  s.add(id, 0, [{ l: 0, r: 4, delta: 7n }]);
  const ex1 = s.explain(id, 1);
  assert.equal(ex1.length, 1);
  assert.equal(ex1[0].action, 'cover-hit');
  assert.equal(ex1[0].tagAfter, '7');
  s.add(id, 1, [{ l: 1, r: 2, delta: -1n }]);
  const ex2 = s.explain(id, 2);
  const actions = ex2.map((e) => e.action);
  assert.ok(actions.includes('pushdown'));
  assert.ok(actions.includes('merge'));
  assert.ok(actions.includes('cover-hit'));
  assert.equal(s.verify(id).ok, true);
});
