import { Store } from './store.js';
import { LazySegmentTree, type TraceEvent } from './segmentTree.js';
import {
  AppError,
  MAX_LEN,
  MIN_LEN,
  checkInterval,
  parseBigInt,
} from './errors.js';

export interface AddInput {
  l: number;
  r: number;
  delta: string;
}

export interface ServiceMeta {
  id: string;
  length: number;
  version: number;
}

export class TreeService {
  constructor(private readonly store: Store) {}

  create(id: string, lengthInput: unknown, valuesInput?: unknown): ServiceMeta {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_\-]{1,64}$/.test(id)) {
      throw new AppError('VALIDATION_ERROR', 'id 必须是 1-64 位字母/数字/下划线/连字符', { id });
    }
    if (typeof lengthInput !== 'number' || !Number.isSafeInteger(lengthInput)) {
      throw new AppError('LENGTH_OUT_OF_RANGE', `length 必须是 [${MIN_LEN},${MAX_LEN}] 的整数`, { lengthInput });
    }
    const length = lengthInput;
    if (length < MIN_LEN || length > MAX_LEN) {
      throw new AppError('LENGTH_OUT_OF_RANGE', `length 必须在 [${MIN_LEN},${MAX_LEN}]，收到 ${length}`, { length });
    }
    let values: bigint[];
    if (valuesInput === undefined || valuesInput === null) {
      values = new Array<bigint>(length).fill(0n);
    } else {
      if (!Array.isArray(valuesInput) || valuesInput.length !== length) {
        throw new AppError('VALIDATION_ERROR', 'values 必须是与 length 等长的十进制字符串数组', {
          gotLength: Array.isArray(valuesInput) ? valuesInput.length : null,
        });
      }
      values = valuesInput.map((v, i) => parseBigInt(v, `values[${i}]`));
    }
    this.store.createArray(id, length, values);
    return { id, length, version: 0 };
  }

  meta(id: string): ServiceMeta {
    return this.store.getMeta(id);
  }

  /** 单次区间加；空区间返回“未改变”且不产生新版本。 */
  add(id: string, expectedVersion: unknown, input: AddInput): {
    version: number;
    unchanged: boolean;
    trace: TraceEvent[];
  } {
    const { length, version } = this.store.getMeta(id);
    const expect = this.checkExpectedVersion(expectedVersion, version);
    const { l, r } = checkInterval(input.l, input.r, length);
    const delta = parseBigInt(input.delta, 'delta');
    if (l === r) {
      return {
        version,
        unchanged: true,
        trace: [
          {
            kind: 'full-cover',
            node: 1,
            segL: 0,
            segR: length,
            note: '空区间更新：合法但不改变任何元素，不创建新版本',
          },
        ],
      };
    }
    const { tree } = this.store.loadTree(id);
    const trace = tree.rangeAdd(l, r, delta);
    const newVersion = this.store.commit(id, expect, tree, [
      { kind: 'add', payload: { l, r, delta: delta.toString() }, trace },
    ]);
    return { version: newVersion, unchanged: false, trace };
  }

  /**
   * 批量区间加：先做全部参数校验（任一非法直接拒绝，不动状态），
   * 再在内存树上顺序应用，最后用一次条件 UPDATE + 事务提交；
   * 提交失败（版本不符）整体回滚，绝不留下半个批次。
   */
  batchAdd(id: string, expectedVersion: unknown, opsInput: unknown): {
    version: number;
    applied: number;
    traces: TraceEvent[][];
  } {
    const { length, version } = this.store.getMeta(id);
    const expect = this.checkExpectedVersion(expectedVersion, version);
    if (!Array.isArray(opsInput) || opsInput.length === 0) {
      throw new AppError('BATCH_REJECTED', '批量操作 ops 必须是非空数组');
    }
    const parsed = opsInput.map((op, i) => {
      if (op === null || typeof op !== 'object') {
        throw new AppError('BATCH_REJECTED', `第 ${i} 个操作格式错误`);
      }
      const o = op as AddInput;
      const { l, r } = checkInterval(o.l, o.r, length);
      const delta = parseBigInt(o.delta, `ops[${i}].delta`);
      return { l, r, delta, index: i };
    });
    const { tree } = this.store.loadTree(id);
    const traces: TraceEvent[][] = [];
    const effective = parsed
      .filter((p) => {
        if (p.l === p.r) {
          traces.push([
            {
              kind: 'full-cover',
              node: 1,
              segL: 0,
              segR: length,
              note: `批量第 ${p.index} 项为空区间，跳过且不产生版本`,
            },
          ]);
          return false;
        }
        return true;
      })
      .map((p) => {
        const trace = tree.rangeAdd(p.l, p.r, p.delta);
        traces.push(trace);
        return { l: p.l, r: p.r, delta: p.delta.toString() };
      });
    if (effective.length === 0) {
      return { version, applied: 0, traces };
    }
    const newVersion = this.store.commit(id, expect, tree, [
      { kind: 'batch-add', payload: { l: effective[0]!.l, r: effective[0]!.r, delta: effective[0]!.delta, ops: effective }, trace: traces },
    ]);
    return { version: newVersion, applied: effective.length, traces };
  }

  query(
    id: string,
    lRaw: unknown,
    rRaw: unknown,
    atVersion?: unknown,
  ): { min: string | null; pos: number | null; version: number; trace: TraceEvent[] } {
    const { length } = this.store.getMeta(id);
    const { l, r } = checkInterval(lRaw, rRaw, length);
    const version = atVersion === undefined ? this.store.getMeta(id).version : this.checkVersion(atVersion);
    const { tree } =
      atVersion === undefined ? this.store.loadTree(id) : this.store.loadTreeAtVersion(id, version);
    const { result, trace } = tree.rangeMin(l, r);
    return {
      min: result ? result.min.toString() : null,
      pos: result ? result.pos : null,
      version,
      trace,
    };
  }

  explain(id: string, version: unknown): {
    version: number;
    kind: string;
    payload: unknown;
    trace: unknown;
    createdAt: string;
  } {
    const v = this.checkVersion(version);
    const op = this.store.getOperation(id, v);
    return { version: op.version, kind: op.kind, payload: op.payload, trace: op.trace, createdAt: op.createdAt };
  }

  export(id: string, atVersion?: unknown): { values: string[]; version: number } {
    const version = atVersion === undefined ? this.store.getMeta(id).version : this.checkVersion(atVersion);
    const { tree } =
      atVersion === undefined ? this.store.loadTree(id) : this.store.loadTreeAtVersion(id, version);
    return { values: tree.toLogicalArray().map(String), version };
  }

  verify(id: string): { ok: true; version: number } | { ok: false; problems: string[] } {
    const { tree, version } = this.store.loadTree(id);
    const result = tree.verify();
    if (!result.ok) {
      throw new AppError('VERIFY_FAILED', '段树内部结构核验失败', result.problems);
    }
    return { ok: true, version };
  }

  listVersions(id: string): Array<{ version: number; kind: string }> {
    this.store.getMeta(id);
    return this.store.listVersions(id);
  }
  private checkExpectedVersion(raw: unknown, current: number): number {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      throw new AppError('VERSION_MISMATCH', 'expectedVersion 必须是非负整数', { received: String(raw) });
    }
    if (raw !== current) {
      throw new AppError('VERSION_MISMATCH', `期望版本 ${raw} 与当前版本 ${current} 不一致，操作被拒绝`, {
        expected: raw,
        current,
      });
    }
    return raw;
  }

  private checkVersion(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      throw new AppError('VERSION_NOT_FOUND', 'version 必须是非负整数', { received: String(raw) });
    }
    return raw;
  }
}

export { LazySegmentTree };
