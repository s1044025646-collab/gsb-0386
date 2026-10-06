/** 业务层：参数校验、错误码、版本控制、批量原子性、回放。 */
import { SegTree, TraceEvent } from './segtree';
import { Store } from './store';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export const MAX_LEN = 100000;

export function parseBigIntParam(v: unknown, name: string): bigint {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) {
    throw new ApiError('INVALID_INTEGER', `${name} 必须是十进制整数字符串`);
  }
  return BigInt(v);
}

export function parseIndex(v: unknown, name: string): number {
  if (typeof v === 'string') {
    if (!/^\d+$/.test(v)) throw new ApiError('INVALID_INDEX', `${name} 必须是非负整数下标`);
    v = Number(v);
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ApiError('INVALID_INDEX', `${name} 必须是非负整数下标（拒绝小数）`);
  }
  return v;
}

export class Service {
  private trees = new Map<number, SegTree>();

  constructor(readonly store: Store) {}

  createArray(values: bigint[]): { id: number; version: number; n: number } {
    if (values.length === 0) throw new ApiError('EMPTY_ARRAY', '空数组不允许创建');
    if (values.length > MAX_LEN) throw new ApiError('ARRAY_TOO_LARGE', `长度上限 ${MAX_LEN}`);
    const id = this.store.createArray(values);
    this.trees.set(id, new SegTree(values));
    return { id, version: 0, n: values.length };
  }

  /** 加载（必要时回放）指定版本的树。version 缺省为当前版本。 */
  private loadTree(id: number, version?: number): { tree: SegTree; version: number } {
    const current = this.store.currentVersion(id);
    const target = version === undefined ? current : version;
    if (!Number.isInteger(target) || target < 0 || target > current) {
      throw new ApiError('VERSION_NOT_FOUND', `版本 ${target} 不存在（当前版本 ${current}）`, 404);
    }
    if (target === current && this.trees.has(id)) {
      return { tree: this.trees.get(id)!, version: current };
    }
    const values = this.store.getArray(id);
    if (!values) throw new ApiError('NOT_FOUND', `数组 ${id} 不存在`, 404);
    const tree = new SegTree(values);
    for (const op of this.store.listOps(id, target)) {
      tree.update(op.l, op.r, BigInt(op.delta));
    }
    if (target === current) this.trees.set(id, tree);
    return { tree, version: target };
  }

  private checkRange(id: number, l: number, r: number): void {
    const values = this.store.getArray(id);
    if (!values) throw new ApiError('NOT_FOUND', `数组 ${id} 不存在`, 404);
    if (l > r) throw new ApiError('INVERTED_RANGE', `左端点 ${l} 大于右端点 ${r}`);
    if (r > values.length) {
      throw new ApiError('OUT_OF_RANGE', `区间 [${l}, ${r}) 越界（长度 ${values.length}）`);
    }
  }

  /**
   * 批量区间加。要求 expectedVersion 匹配；先整体校验再整体应用，
   * 任一非法操作使整批回滚（不落库、不改树）。
   */
  add(
    id: number,
    expectedVersion: number,
    ops: { l: number; r: number; delta: bigint }[],
  ): { version: number; results: { changed: boolean; explain: TraceEvent[] }[] } {
    const current = this.store.currentVersion(id);
    if (expectedVersion !== current) {
      throw new ApiError('VERSION_MISMATCH',
        `期望版本 ${expectedVersion} 与当前版本 ${current} 不符`, 409);
    }
    if (ops.length === 0) throw new ApiError('EMPTY_BATCH', '批量操作不能为空');
    for (const op of ops) this.checkRange(id, op.l, op.r); // 先全部校验

    const { tree } = this.loadTree(id);
    const results = ops.map((op) => {
      const explain: TraceEvent[] = [];
      if (op.l >= op.r) return { changed: false, explain }; // 空区间：未改变
      tree.update(op.l, op.r, op.delta, explain);
      return { changed: true, explain };
    });
    const newVersion = this.store.appendOps(id,
      ops.map((op, i) => ({ ...op, explain: JSON.stringify(results[i].explain) })));
    return { version: newVersion, results };
  }

  query(id: number, l: number, r: number, version?: number):
    { version: number; result: { min: string; index: number } | null; explain: TraceEvent[] } {
    this.checkRange(id, l, r);
    const { tree, version: v } = this.loadTree(id, version);
    const explain: TraceEvent[] = [];
    const res = tree.query(l, r, explain);
    return {
      version: v,
      result: res ? { min: res.min.toString(), index: res.index } : null,
      explain,
    };
  }

  exportArray(id: number, version?: number): { version: number; values: string[] } {
    const { tree, version: v } = this.loadTree(id, version);
    return { version: v, values: tree.toArray().map(String) };
  }

  explain(id: number, version: number): TraceEvent[] {
    const json = this.store.getExplain(id, version);
    if (json === null) throw new ApiError('NOT_FOUND', `版本 ${version} 的操作不存在`, 404);
    return JSON.parse(json);
  }

  verify(id: number, version?: number): { version: number; ok: boolean; mismatches: unknown[] } {
    const { tree, version: v } = this.loadTree(id, version);
    const mismatches = tree.verify();
    return { version: v, ok: mismatches.length === 0, mismatches };
  }
}
