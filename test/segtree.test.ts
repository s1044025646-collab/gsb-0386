import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegTree } from '../src/segtree';

function bruteForce(values: bigint[], l: number, r: number): { min: bigint; index: number } | null {
  if (l >= r) return null;
  let min = values[l];
  let index = l;
  for (let i = l + 1; i < r; i++) {
    if (values[i] < min) { min = values[i]; index = i; }
  }
  return { min, index };
}

test('演示场景: [5,1,4,1] [0,3)+2 [1,4)-3 => [7,0,3,-2]', () => {
  const t = new SegTree([5n, 1n, 4n, 1n]);
  t.update(0, 3, 2n);
  t.update(1, 4, -3n);
  assert.deepEqual(t.toArray(), [7n, 0n, 3n, -2n]);
  assert.deepEqual(t.query(0, 4), { min: -2n, index: 3 });
});

test('非二次幂长度与单元素', () => {
  const t = new SegTree([3n, 1n, 4n, 1n, 5n, 9n, 2n]);
  t.update(2, 7, -4n);
  assert.deepEqual(t.toArray(), [3n, 1n, 0n, -3n, 1n, 5n, -2n]);
  const s = new SegTree([42n]);
  s.update(0, 1, -100n);
  assert.deepEqual(s.query(0, 1), { min: -58n, index: 0 });
});

test('全段与窄段交错、并列最小取最左', () => {
  const t = new SegTree([2n, 2n, 2n, 2n]);
  t.update(0, 4, 5n);
  t.update(1, 2, -3n);
  assert.deepEqual(t.toArray(), [7n, 4n, 7n, 7n]);
  assert.deepEqual(t.query(0, 4), { min: 4n, index: 1 });
  const t2 = new SegTree([1n, 1n, 1n]);
  assert.equal(t2.query(0, 3)!.index, 0);
});

test('负加量与大整数（超过安全整数）', () => {
  const big = 2n ** 70n;
  const t = new SegTree([big, -big, 0n]);
  t.update(0, 2, big);
  assert.deepEqual(t.query(0, 3), { min: 0n, index: 1 });
  t.update(2, 3, -(2n ** 70n) - 1n);
  assert.deepEqual(t.query(0, 3), { min: -(2n ** 70n) - 1n, index: 2 });
});

test('空区间更新未改变、空区间查询无最小值', () => {
  const t = new SegTree([1n, 2n]);
  t.update(1, 1, 99n);
  assert.deepEqual(t.toArray(), [1n, 2n]);
  assert.equal(t.query(2, 2), null);
});

test('先加 a 再加 b 等价于加 a+b', () => {
  const a = 12345678901234567890n;
  const b = -9876543210987654321n;
  const t1 = new SegTree([5n, 1n, 4n, 1n, 6n]);
  const t2 = new SegTree([5n, 1n, 4n, 1n, 6n]);
  t1.update(1, 4, a);
  t1.update(1, 4, b);
  t2.update(1, 4, a + b);
  assert.deepEqual(t1.toArray(), t2.toArray());
  assert.deepEqual(t1.query(0, 5), t2.query(0, 5));
});

test('随机小样本基准：逐步对比普通数组', () => {
  let seed = 42;
  const rand = (m: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % m;
  };
  for (let trial = 0; trial < 20; trial++) {
    const n = 1 + rand(13);
    const arr = Array.from({ length: n }, () => BigInt(rand(21) - 10));
    const t = new SegTree([...arr]);
    for (let step = 0; step < 30; step++) {
      const l = rand(n);
      const r = l + rand(n - l + 1);
      const delta = BigInt(rand(41) - 20);
      t.update(l, r, delta);
      for (let i = l; i < r; i++) arr[i] += delta;
      for (let q = 0; q < 4; q++) {
        const ql = rand(n);
        const qr = ql + rand(n - ql + 1);
        const got = t.query(ql, qr);
        const want = bruteForce(arr, ql, qr);
        if (want === null) assert.equal(got, null);
        else assert.deepEqual(got, want, `trial=${trial} step=${step}`);
      }
      assert.equal(t.verify().length, 0, '结构核验应通过');
    }
    assert.deepEqual(t.toArray(), arr);
  }
});

test('结构核验能发现被篡改的缓存', () => {
  const t = new SegTree([3n, 1n, 2n]);
  t.update(0, 2, 5n);
  assert.equal(t.verify().length, 0);
  (t as any).min[1] = 999n;
  assert.ok(t.verify().length > 0);
});
