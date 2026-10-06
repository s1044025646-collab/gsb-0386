/**
 * 懒标记段树（区间加 / 区间最左最小值）。
 *
 * 不变量：
 * - mn[v] 已经包含 lazy[v]：节点对外暴露的最小值 = mn[v]，不需要再加 lazy。
 * - lazy[v] 是“只作用在整段、尚未下传给孩子”的累计加量；
 *   因此孩子缓存 mn[child] 不含 lazy[v]，必须先 push 才能用孩子合并。
 * - pos[v] 是该节点最小逻辑值对应的最左下标；并列时始终靠左。
 */

export interface TraceEvent {
  kind:
    | 'enter'
    | 'full-cover'
    | 'push'
    | 'recurse-left'
    | 'recurse-right'
    | 'merge'
    | 'query-hit'
    | 'query-miss';
  node: number;
  segL: number;
  segR: number;
  lazyBefore?: string;
  lazyAfter?: string;
  minBefore?: string;
  minAfter?: string;
  posBefore?: number | null;
  posAfter?: number | null;
  note?: string;
}

export interface MinResult {
  min: bigint;
  pos: number;
}

export class LazySegmentTree {
  readonly n: number;
  private readonly mn: bigint[];
  private readonly pos: number[];
  private readonly lazy: bigint[];

  constructor(initial: bigint[]) {
    this.n = initial.length;
    const size = 4 * this.n + 5;
    this.mn = new Array<bigint>(size).fill(0n);
    this.lazy = new Array<bigint>(size).fill(0n);
    this.pos = new Array<number>(size).fill(-1);
    this.build(1, 0, this.n, initial);
  }

  private build(v: number, l: number, r: number, a: bigint[]): void {
    if (r - l === 1) {
      this.mn[v] = a[l]!;
      this.pos[v] = l;
      return;
    }
    const m = (l + r) >> 1;
    this.build(v * 2, l, m, a);
    this.build(v * 2 + 1, m, r, a);
    this.pull(v);
  }

  /** 序列化（快照）：导出缓存数组，懒标记随之保留，重启后效果不丢。 */
  snapshot(): { n: number; mn: string[]; pos: number[]; lazy: string[] } {
    return {
      n: this.n,
      mn: this.mn.map(String),
      pos: this.pos.slice(),
      lazy: this.lazy.map(String),
    };
  }

  static fromSnapshot(snap: { n: number; mn: string[]; pos: number[]; lazy: string[] }): LazySegmentTree {
    const tree = Object.create(LazySegmentTree.prototype) as LazySegmentTree;
    (tree as unknown as { n: number }).n = snap.n;
    (tree as unknown as { mn: bigint[] }).mn = snap.mn.map(BigInt);
    (tree as unknown as { pos: number[] }).pos = snap.pos.slice();
    (tree as unknown as { lazy: bigint[] }).lazy = snap.lazy.map(BigInt);
    return tree;
  }

  private apply(v: number, delta: bigint): void {
    // 整段覆盖：最小值与“未下传累计加量”都做累加，绝不是覆盖旧标记。
    this.mn[v] = (this.mn[v] ?? 0n) + delta;
    this.lazy[v] = (this.lazy[v] ?? 0n) + delta;
  }

  private push(v: number, l: number, r: number, trace?: TraceEvent[]): void {
    const tag = this.lazy[v]!;
    if (tag === 0n || r - l === 1) return;
    const lc = v * 2;
    const rc = lc + 1;
    const event: TraceEvent = {
      kind: 'push',
      node: v,
      segL: l,
      segR: r,
      lazyBefore: String(tag),
      minBefore: String(this.mn[v]),
      note: `把累计标记 ${tag} 传给左右孩子，本节点标记清零；节点最小值 ${this.mn[v]} 已含该标记，孩子此前不含`,
    };
    this.apply(lc, tag);
    this.apply(rc, tag);
    this.lazy[v] = 0n;
    event.lazyAfter = '0';
    event.minAfter = String(this.mn[v]);
    trace?.push(event);
  }

  /** 由孩子合并：值相等时选更左下标。 */
  private pull(v: number): void {
    const lc = v * 2;
    const rc = lc + 1;
    const leftMin = this.mn[lc]!;
    const rightMin = this.mn[rc]!;
    if (leftMin <= rightMin) {
      this.mn[v] = leftMin;
      this.pos[v] = this.pos[lc]!;
    } else {
      this.mn[v] = rightMin;
      this.pos[v] = this.pos[rc]!;
    }
  }

  rangeAdd(ql: number, qr: number, delta: bigint): TraceEvent[] {
    const trace: TraceEvent[] = [];
    if (ql === qr) {
      trace.push({
        kind: 'full-cover',
        node: 1,
        segL: 0,
        segR: this.n,
        note: '空区间 [l,l)：未改变任何元素，未访问树',
      });
      return trace;
    }
    this.add(1, 0, this.n, ql, qr, delta, trace);
    return trace;
  }

  private add(
    v: number,
    l: number,
    r: number,
    ql: number,
    qr: number,
    delta: bigint,
    trace: TraceEvent[],
  ): void {
    trace.push({ kind: 'enter', node: v, segL: l, segR: r, lazyBefore: String(this.lazy[v]), minBefore: String(this.mn[v]), posBefore: this.pos[v] });
    if (ql <= l && r <= qr) {
      const before = { min: this.mn[v]!, lazy: this.lazy[v]!, pos: this.pos[v]! };
      this.apply(v, delta);
      trace.push({
        kind: 'full-cover',
        node: v,
        segL: l,
        segR: r,
        lazyBefore: String(before.lazy),
        lazyAfter: String(this.lazy[v]),
        minBefore: String(before.min),
        minAfter: String(this.mn[v]),
        posBefore: before.pos,
        posAfter: this.pos[v],
        note: `整段命中：标记累加 ${delta}（${before.lazy} -> ${this.lazy[v]}），最小值同步 ${before.min} -> ${this.mn[v]}，来源下标不变`,
      });
      return;
    }
    this.push(v, l, r, trace);
    const m = (l + r) >> 1;
    if (ql < m) {
      trace.push({ kind: 'recurse-left', node: v, segL: l, segR: r, note: `更新与左半 [${l},${m}) 相交，递归` });
      this.add(v * 2, l, m, ql, qr, delta, trace);
    }
    if (qr > m) {
      trace.push({ kind: 'recurse-right', node: v, segL: l, segR: r, note: `更新与右半 [${m},${r}) 相交，递归` });
      this.add(v * 2 + 1, m, r, ql, qr, delta, trace);
    }
    const beforeMin = this.mn[v]!;
    const beforePos = this.pos[v]!;
    this.pull(v);
    trace.push({
      kind: 'merge',
      node: v,
      segL: l,
      segR: r,
      minBefore: String(beforeMin),
      minAfter: String(this.mn[v]),
      posBefore: beforePos,
      posAfter: this.pos[v],
      note: '部分覆盖后由孩子重新合并（相等取左孩子下标）',
    });
  }

  rangeMin(ql: number, qr: number): { result: MinResult | null; trace: TraceEvent[] } {
    const trace: TraceEvent[] = [];
    if (ql === qr) {
      trace.push({ kind: 'query-miss', node: 1, segL: 0, segR: this.n, note: '空区间查询：无最小值（不是 0，也不是数值无穷大）' });
      return { result: null, trace };
    }
    const result = this.query(1, 0, this.n, ql, qr, trace);
    return { result, trace };
  }

  private query(v: number, l: number, r: number, ql: number, qr: number, trace: TraceEvent[]): MinResult {
    if (ql <= l && r <= qr) {
      trace.push({
        kind: 'query-hit',
        node: v,
        segL: l,
        segR: r,
        minAfter: String(this.mn[v]),
        posAfter: this.pos[v],
        lazyBefore: String(this.lazy[v]),
        note: `整段命中：直接用节点缓存最小值 ${this.mn[v]}（已含本节点标记 ${this.lazy[v]}，不再重复加）`,
      });
      return { min: this.mn[v]!, pos: this.pos[v]! };
    }
    // 注意：查询只读，不修改树。部分覆盖时按孩子缓存 + 本节点标记就地比较，
    // 不做会落盘的结构性改动（逻辑数组当然也不变）。
    const tag = this.lazy[v]!;
    const m = (l + r) >> 1;
    let best: MinResult | null = null;
    if (ql < m) {
      const left = this.query(v * 2, l, m, ql, qr, trace);
      best = better(best, { min: left.min + tag, pos: left.pos });
    }
    if (qr > m) {
      const right = this.query(v * 2 + 1, m, r, ql, qr, trace);
      best = better(best, { min: right.min + tag, pos: right.pos });
    }
    trace.push({
      kind: 'merge',
      node: v,
      segL: l,
      segR: r,
      lazyBefore: String(tag),
      minAfter: best === null ? undefined : String(best.min),
      posAfter: best === null ? null : best.pos,
      note: tag === 0n ? '查询路径上合并两侧候选（相等取左）' : `查询路径未下推：孩子候选临时加上未传标记 ${tag} 后比较，树状态不变`,
    });
    return best!;
  }

  /** 导出当前逻辑数组：把所有未下传标记一路带到叶子。O(n)。 */
  toLogicalArray(): bigint[] {
    const out = new Array<bigint>(this.n);
    const walk = (v: number, l: number, r: number, carried: bigint): void => {
      if (r - l === 1) {
        // mn[叶子] 已含叶子自身标记；carried 是沿途祖先尚未下传的标记之和。
        out[l] = this.mn[v]! + carried;
        return;
      }
      const m = (l + r) >> 1;
      walk(v * 2, l, m, carried + this.lazy[v]!);
      walk(v * 2 + 1, m, r, carried + this.lazy[v]!);
    };
    walk(1, 0, this.n, 0n);
    return out;
  }

  /**
   * 独立结构核验（诊断入口，不是查询的替代实现）：
   * 递归展开全部节点到叶子，重算每个区间的最小值与最左下标，
   * 并校验 mn[v] == min(叶子逻辑值) 以及缓存一致性。
   */
  verify(): { ok: true } | { ok: false; problems: string[] } {
    const problems: string[] = [];
    // 返回该节点在“自身缓存视角”下的最小值，即递归孩子值 + 本节点 lazy。
    const walk = (v: number, l: number, r: number): MinResult => {
      if (r - l === 1) {
        if (this.pos[v] !== l) problems.push(`叶子 [${l},${r}) pos=${this.pos[v]}，应为 ${l}`);
        return { min: this.mn[v]!, pos: this.pos[v]! };
      }
      const lc = v * 2;
      const rc = lc + 1;
      const m = (l + r) >> 1;
      const left = walk(lc, l, m);
      const right = walk(rc, m, r);
      const tag = this.lazy[v]!;
      // 孩子缓存不含本节点 lazy，所以本节点应有最小值 = min(孩子最小值) + lazy[v]。
      const childBest = better(left, right)!;
      const expectMin = childBest.min + tag;
      const expectPos = childBest.pos;
      if (this.mn[v] !== expectMin) {
        problems.push(`节点 [${l},${r}) 缓存最小值 ${this.mn[v]} != 递归重算 ${expectMin}（lazy=${tag}）`);
      }
      // 整段标记平移不改最左位置；pos[v] 应为孩子比较结果的位置。
      const childExpect = better(
        { min: this.mn[lc]!, pos: this.pos[lc]! },
        { min: this.mn[rc]!, pos: this.pos[rc]! },
      )!;
      if (this.pos[v] !== expectPos || this.pos[v] !== childExpect.pos) {
        problems.push(`节点 [${l},${r}) 缓存来源下标 ${this.pos[v]} != 应为 ${childExpect.pos}`);
      }
      return { min: expectMin, pos: expectPos };
    };
    walk(1, 0, this.n);
    return problems.length === 0 ? { ok: true } : { ok: false, problems };
  }
}

function better(a: MinResult | null, b: MinResult | null): MinResult | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.min < b.min) return a;
  if (b.min < a.min) return b;
  return a.pos <= b.pos ? a : b;
}
