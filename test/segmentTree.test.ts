import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LazySegmentTree } from '../src/segmentTree.ts';

function naiveAdd(a: bigint[], l: number, r: number, d: bigint): void {
  for (let i = l; i < r; i++) a[i]! += d;
}

function naiveMin(a: bigint[], l: number, r: number): { min: bigint; pos: number } | null {
  if (l === r) return null;
  let min = a[l]!;
  let pos = l;
  for (let i = l + 1; i < r; i++) {
    if (a[i]! < min) {
      min = a[i]!;
      pos = i;
    }
  }
  return { min, pos };
}

test('演示序列 [5,1,4,1] +2[0,3) -3[1,4) => [7,0,3,-2]', () => {
  const tree = new LazySegmentTree([5n, 1n, 4n, 1n]);
  tree.rangeAdd(0, 3, 2n);
  tree.rangeAdd(1, 4, -3n);
  assert.deepEqual(tree.toLogicalArray().map(String), ['7', '0', '3', '-2']);
  const q = tree.rangeMin(0, 4).result!;
  assert.equal(q.min, -2n);
  assert.equal(q.pos, 3);
  assert.deepEqual(tree.verify(), { ok: true });
});

test('并列最小始终取最左，且全段标记未下推时局部查询正确', () => {
  const tree = new LazySegmentTree([3n, 1n, 1n, 1n, 2n]);
  const q = tree.rangeMin(0, 5).result!;
  assert.equal(q.min, 1n);
  assert.equal(q.pos, 1);
  // 子区间里的并列
  assert.equal(tree.rangeMin(1, 4).result!.pos, 1);
  assert.equal(tree.rangeMin(2, 4).result!.pos, 2);

  const t2 = new LazySegmentTree([0n, 0n, 0n, 0n]);
  t2.rangeAdd(0, 4, 10n);
  assert.equal(t2.rangeMin(0, 2).result!.min, 10n);
  assert.equal(t2.rangeMin(0, 2).result!.pos, 0);
  assert.equal(t2.rangeMin(2, 4).result!.min, 10n);
  assert.deepEqual(t2.verify(), { ok: true });
});

test('空区间：更新不变、查询返回 null', () => {
  const tree = new LazySegmentTree([1n, 2n]);
  tree.rangeAdd(1, 1, 99n);
  assert.deepEqual(tree.toLogicalArray().map(String), ['1', '2']);
  assert.equal(tree.rangeMin(0, 0).result, null);
  assert.deepEqual(tree.verify(), { ok: true });
});

test('非二次幂长度（3,5,6,7,9,10,100）逐区间对拍', () => {
  for (const n of [1, 2, 3, 5, 6, 7, 9, 10, 100]) {
    const seed = BigInt(n * 7 + 1);
    const init = Array.from({ length: n }, (_, i) => (BigInt(i) * seed) % 13n - 6n);
    const tree = new LazySegmentTree(init);
    const naive = init.slice();
    // 确定性伪随机操作
    let state = (n * 2654435761) >>> 0;
    const rand = () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return state / 0x100000000;
    };
    for (let step = 0; step < 200; step++) {
      let l = Math.floor(rand() * (n + 1));
      let r = Math.floor(rand() * (n + 1));
      if (l > r) [l, r] = [r, l];
      const d = BigInt(Math.floor(rand() * 21) - 10);
      tree.rangeAdd(l, r, d);
      naiveAdd(naive, l, r, d);
      assert.deepEqual(tree.toLogicalArray().map(String), naive.map(String), `n=${n} step=${step} 逻辑数组不一致`);
      // 每步对多个随机区间比较最小值与最左下标
      for (let k = 0; k < 6; k++) {
        let ql = Math.floor(rand() * (n + 1));
        let qr = Math.floor(rand() * (n + 1));
        if (ql > qr) [ql, qr] = [qr, ql];
        const got = tree.rangeMin(ql, qr).result;
        const want = naiveMin(naive, ql, qr);
        if (want === null) assert.equal(got, null);
        else {
          assert.equal(got!.min, want.min, `n=${n} step=${step} [${ql},${qr}) 最小值`);
          assert.equal(got!.pos, want.pos, `n=${n} step=${step} [${ql},${qr}) 最左位置`);
        }
      }
      assert.deepEqual(tree.verify(), { ok: true }, `n=${n} step=${step} 结构核验`);
    }
  }
});

test('先加 a 再加 b 等价于直接加 a+b（同一区间，标记累加语义）', () => {
  for (const n of [1, 4, 7, 13]) {
    const init = Array.from({ length: n }, (_, i) => BigInt((i * i) % 17) - 8n);
    const sequential = new LazySegmentTree(init);
    const combined = new LazySegmentTree(init);
    const naive = init.slice();
    const ops: Array<[number, number, bigint, bigint]> = [
      [0, n, 5n, -9n],
      [0, n > 1 ? 2 : 1, 3n, 4n],
      [1, Math.min(n, 4), 11n, -2n],
    ];
    for (const [l, r, a, b] of ops) {
      if (l > r) continue;
      sequential.rangeAdd(l, r, a);
      sequential.rangeAdd(l, r, b);
      combined.rangeAdd(l, r, a + b);
      naiveAdd(naive, l, r, a + b);
    }
    assert.deepEqual(sequential.toLogicalArray().map(String), naive.map(String));
    assert.deepEqual(combined.toLogicalArray().map(String), naive.map(String));
    assert.deepEqual(
      sequential.toLogicalArray().map(String),
      combined.toLogicalArray().map(String),
      `n=${n} 两种加法顺序结果应一致`,
    );
    for (let l = 0; l < n; l++) {
      for (let r = l + 1; r <= n; r++) {
        assert.equal(sequential.rangeMin(l, r).result!.min, combined.rangeMin(l, r).result!.min);
        assert.equal(sequential.rangeMin(l, r).result!.pos, combined.rangeMin(l, r).result!.pos);
      }
    }
  }
});

test('大整数与负数精确（超过 Number.MAX_SAFE_INTEGER）', () => {
  const big = 90071992547409930000000000n;
  const tree = new LazySegmentTree([big, -big]);
  tree.rangeAdd(0, 2, -1n);
  const arr = tree.toLogicalArray();
  assert.equal(arr[0], big - 1n);
  assert.equal(arr[1], -big - 1n);
  const q = tree.rangeMin(0, 2).result!;
  assert.equal(q.pos, 1);
  assert.equal(q.min, -big - 1n);
});
