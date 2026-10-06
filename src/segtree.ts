/**
 * 懒标记段树：区间加法 + 区间最小值（含最左来源下标）。
 * 所有值使用 BigInt 精确运算。
 *
 * 节点不变式：
 *  - min[node] 已经包含 tag[node] 的效果（即“节点最小值已含自己的标记”）。
 *  - tag[node] 是尚未下推给孩子的累计加量；孩子的缓存值尚未包含它。
 */

export interface TraceEvent {
  node: number;
  l: number;
  r: number; // 半开 [l, r)
  action: 'cover-hit' | 'pushdown' | 'merge' | 'query-hit' | 'visit';
  tagBefore: string;
  tagAfter: string;
  minBefore: string | null;
  minAfter: string | null;
  srcIndex: number | null;
  note?: string;
}

export interface QueryResult {
  min: bigint;
  index: number;
}

export interface VerifyMismatch {
  node: number;
  l: number;
  r: number;
  expectedMin: string;
  actualMin: string;
  expectedIndex: number;
  actualIndex: number;
}

export class SegTree {
  readonly n: number;
  private readonly min: bigint[];
  private readonly idx: number[];
  private readonly tag: bigint[];

  constructor(values: bigint[]) {
    if (values.length < 1) throw new Error('EMPTY_ARRAY');
    if (values.length > 100000) throw new Error('ARRAY_TOO_LARGE');
    this.n = values.length;
    const size = 4 * this.n + 8;
    this.min = new Array<bigint>(size).fill(0n);
    this.idx = new Array<number>(size).fill(-1);
    this.tag = new Array<bigint>(size).fill(0n);
    this.build(1, 0, this.n, values);
  }

  private build(node: number, l: number, r: number, values: bigint[]): void {
    if (r - l === 1) {
      this.min[node] = values[l];
      this.idx[node] = l;
      return;
    }
    const m = (l + r) >> 1;
    this.build(node * 2, l, m, values);
    this.build(node * 2 + 1, m, r, values);
    this.pull(node);
  }

  /** 合并孩子：同值取最左下标。 */
  private pull(node: number): void {
    const a = node * 2;
    const b = node * 2 + 1;
    if (this.min[a] <= this.min[b]) {
      this.min[node] = this.min[a];
      this.idx[node] = this.idx[a];
    } else {
      this.min[node] = this.min[b];
      this.idx[node] = this.idx[b];
    }
  }

  /** 整段覆盖：直接更新本节点，标记累加（绝不覆盖旧标记）。 */
  private apply(node: number, delta: bigint): void {
    this.min[node] += delta;
    this.tag[node] += delta;
  }

  /** 下推：把本节点累计标记传给两个孩子，然后清零。 */
  private push(node: number): void {
    const t = this.tag[node];
    if (t !== 0n) {
      this.apply(node * 2, t);
      this.apply(node * 2 + 1, t);
      this.tag[node] = 0n;
    }
  }

  update(ql: number, qr: number, delta: bigint, trace?: TraceEvent[]): void {
    if (ql >= qr) return; // 空区间：未改变
    this.updateRec(1, 0, this.n, ql, qr, delta, trace);
  }

  private updateRec(
    node: number, l: number, r: number,
    ql: number, qr: number, delta: bigint,
    trace?: TraceEvent[],
  ): void {
    if (ql <= l && r <= qr) {
      const before = this.snapshot(node);
      this.apply(node, delta);
      trace?.push(this.event(node, l, r, 'cover-hit', before,
        `整段覆盖，标记累加 ${delta}`));
      return;
    }
    const before = this.snapshot(node);
    const hadTag = this.tag[node] !== 0n;
    this.push(node);
    if (hadTag) {
      trace?.push(this.event(node, l, r, 'pushdown', before, '部分覆盖，先下推累计标记'));
    }
    const m = (l + r) >> 1;
    if (ql < m) this.updateRec(node * 2, l, m, ql, qr, delta, trace);
    if (qr > m) this.updateRec(node * 2 + 1, m, r, ql, qr, delta, trace);
    this.pull(node);
    trace?.push(this.event(node, l, r, 'merge', before, '由孩子合并（同值取最左）'));
  }

  query(ql: number, qr: number, trace?: TraceEvent[]): QueryResult | null {
    if (ql >= qr) return null; // 空区间：无最小值
    return this.queryRec(1, 0, this.n, ql, qr, trace);
  }

  private queryRec(
    node: number, l: number, r: number,
    ql: number, qr: number,
    trace?: TraceEvent[],
  ): QueryResult {
    if (ql <= l && r <= qr) {
      trace?.push(this.event(node, l, r, 'query-hit', this.snapshot(node),
        '查询整段命中，min 已含本节点标记'));
      return { min: this.min[node], index: this.idx[node] };
    }
    const before = this.snapshot(node);
    const hadTag = this.tag[node] !== 0n;
    this.push(node);
    if (hadTag) {
      trace?.push(this.event(node, l, r, 'pushdown', before, '查询经过，下推累计标记'));
    }
    const m = (l + r) >> 1;
    let best: QueryResult | null = null;
    if (ql < m) best = this.queryRec(node * 2, l, m, ql, qr, trace);
    if (qr > m) {
      const right = this.queryRec(node * 2 + 1, m, r, ql, qr, trace);
      if (best === null || right.min < best.min) best = right;
      // right.min === best.min 时保留左侧结果，保证最左下标
    }
    return best!;
  }

  /** 导出逻辑数组（沿树下推展开到叶子）。 */
  toArray(): bigint[] {
    const out = new Array<bigint>(this.n).fill(0n);
    const walk = (node: number, l: number, r: number, acc: bigint): void => {
      const cur = acc + this.tag[node];
      if (r - l === 1) {
        // 叶子 min 已含自身标记，但不含祖先尚未下推的标记 acc
        out[l] = this.min[node] + acc;
        return;
      }
      const m = (l + r) >> 1;
      walk(node * 2, l, m, cur);
      walk(node * 2 + 1, m, r, cur);
    };
    walk(1, 0, this.n, 0n);
    return out;
  }

  /**
   * 独立结构核验：递归展开到叶子，用“孩子缓存 + 路径累计标记”
   * 重新计算每个区间的最小值与最左下标，核对树内缓存。
   */
  verify(): VerifyMismatch[] {
    const mismatches: VerifyMismatch[] = [];
    const walk = (node: number, l: number, r: number): { min: bigint; index: number } => {
      let expected: { min: bigint; index: number };
      if (r - l === 1) {
        // 叶子：缓存值即逻辑值（已含自身标记）
        expected = { min: this.min[node], index: l };
      } else {
        const m = (l + r) >> 1;
        const left = walk(node * 2, l, m);
        const right = walk(node * 2 + 1, m, r);
        // 孩子缓存尚未包含本节点标记，需加上 tag[node]
        const lm = left.min + this.tag[node];
        const rm = right.min + this.tag[node];
        expected = lm <= rm ? { min: lm, index: left.index } : { min: rm, index: right.index };
      }
      if (expected.min !== this.min[node] || expected.index !== this.idx[node]) {
        mismatches.push({
          node, l, r,
          expectedMin: expected.min.toString(),
          actualMin: this.min[node].toString(),
          expectedIndex: expected.index,
          actualIndex: this.idx[node],
        });
      }
      // 父节点会自行加上它自己的标记，这里返回缓存原值
      return { min: this.min[node], index: this.idx[node] };
    };
    walk(1, 0, this.n);
    return mismatches;
  }

  private snapshot(node: number): { tag: bigint; min: bigint; idx: number } {
    return { tag: this.tag[node], min: this.min[node], idx: this.idx[node] };
  }

  private event(
    node: number, l: number, r: number,
    action: TraceEvent['action'],
    before: { tag: bigint; min: bigint; idx: number },
    note: string,
  ): TraceEvent {
    return {
      node, l, r, action,
      tagBefore: before.tag.toString(),
      tagAfter: this.tag[node].toString(),
      minBefore: before.min.toString(),
      minAfter: this.min[node].toString(),
      srcIndex: this.idx[node],
      note,
    };
  }
}
