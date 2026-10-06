import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LazySegmentTree } from './segmentTree.js';
import { AppError } from './errors.js';

export interface OperationRow {
  id: number;
  arrayId: string;
  version: number;
  kind: 'add' | 'batch-add';
  payload: { l: number; r: number; delta: string; ops?: Array<{ l: number; r: number; delta: string }> };
  trace: unknown;
  createdAt: string;
}

interface SnapshotRow {
  array_id: string;
  length: number;
  version: number;
  initial_json: string;
  tree_json: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arrays (
        id TEXT PRIMARY KEY,
        length INTEGER NOT NULL,
        created_version INTEGER NOT NULL DEFAULT 0,
        initial_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        array_id TEXT PRIMARY KEY,
        length INTEGER NOT NULL,
        version INTEGER NOT NULL,
        initial_json TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(array_id) REFERENCES arrays(id)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        array_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        trace_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(array_id, version),
        FOREIGN KEY(array_id) REFERENCES arrays(id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createArray(id: string, length: number, initial: bigint[]): void {
    const exists = this.db.prepare('SELECT id FROM arrays WHERE id = ?').get(id);
    if (exists) throw new AppError('ARRAY_ALREADY_EXISTS', `数组 ${id} 已存在`, { id });
    const now = new Date().toISOString();
    const initialJson = JSON.stringify(initial.map(String));
    const tree = new LazySegmentTree(initial);
    const tx = this.db.prepare(
      `INSERT INTO arrays(id, length, created_version, initial_json, created_at)
       VALUES (?, ?, 0, ?, ?)`,
    );
    const txSnap = this.db.prepare(
      `INSERT INTO snapshots(array_id, length, version, initial_json, tree_json, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      tx.run(id, length, initialJson, now);
      txSnap.run(id, length, initialJson, JSON.stringify(tree.snapshot()), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  arrayExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM arrays WHERE id = ?').get(id);
  }

  private requireSnapshot(id: string): SnapshotRow {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE array_id = ?').get(id) as
      | SnapshotRow
      | undefined;
    if (!row) throw new AppError('ARRAY_NOT_FOUND', `数组 ${id} 不存在`, { id });
    return row;
  }

  getMeta(id: string): { id: string; length: number; version: number } {
    const snap = this.requireSnapshot(id);
    return { id: snap.array_id, length: snap.length, version: snap.version };
  }

  /** 载入最新树（含尚未下推的标记）与版本号。 */
  loadTree(id: string): { tree: LazySegmentTree; version: number } {
    const snap = this.requireSnapshot(id);
    return { tree: LazySegmentTree.fromSnapshot(JSON.parse(snap.tree_json)), version: snap.version };
  }

  loadInitial(id: string): bigint[] {
    const snap = this.requireSnapshot(id);
    return (JSON.parse(snap.initial_json) as string[]).map(BigInt);
  }

  /**
   * 原子提交：先用条件 UPDATE 做乐观版本校验，版本不符则整批回滚。
   */
  commit(
    id: string,
    expectedVersion: number,
    tree: LazySegmentTree,
    operations: Array<{ kind: 'add' | 'batch-add'; payload: OperationRow['payload']; trace: unknown }>,
  ): number {
    const newVersion = expectedVersion + operations.length;
    const now = new Date().toISOString();
    const bump = this.db.prepare(
      `UPDATE snapshots SET version = ?, tree_json = ?, updated_at = ?
       WHERE array_id = ? AND version = ?`,
    );
    const insertOp = this.db.prepare(
      `INSERT INTO operations(array_id, version, kind, payload_json, trace_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      const result = bump.run(JSON.stringify(newVersion), JSON.stringify(tree.snapshot()), now, id, expectedVersion);
      if (Number(result.changes) !== 1) {
        throw new AppError('VERSION_MISMATCH', `期望版本 ${expectedVersion} 与当前版本不一致，操作被拒绝`, {
          expectedVersion,
        });
      }
      operations.forEach((op, i) => {
        insertOp.run(
          id,
          expectedVersion + i + 1,
          op.kind,
          JSON.stringify(op.payload),
          JSON.stringify(op.trace, bigIntReplacer),
          now,
        );
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return newVersion;
  }

  getOperation(id: string, version: number): OperationRow {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE array_id = ? AND version = ?')
      .get(id, version) as
      | {
          id: number;
          array_id: string;
          version: number;
          kind: 'add' | 'batch-add';
          payload_json: string;
          trace_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) throw new AppError('OP_NOT_FOUND', `数组 ${id} 不存在版本 ${version} 的操作`, { version });
    return {
      id: row.id,
      arrayId: row.array_id,
      version: row.version,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      trace: JSON.parse(row.trace_json),
      createdAt: row.created_at,
    };
  }

  listVersions(id: string): Array<{ version: number; kind: string }> {
    return (
      this.db
        .prepare('SELECT version, kind FROM operations WHERE array_id = ? ORDER BY version')
        .all(id) as Array<{ version: number; kind: string }>
    );
  }

  /**
   * 读取指定历史版本：从初始数组重建并按操作日志回放到目标版本。
   * 历史版本“可通过回放恢复”，不为每个版本另存一套持久化树。
   */
  loadTreeAtVersion(id: string, targetVersion: number): { tree: LazySegmentTree; version: number } {
    const meta = this.getMeta(id);
    if (targetVersion < 0 || targetVersion > meta.version) {
      throw new AppError('VERSION_NOT_FOUND', `版本 ${targetVersion} 不存在，当前最新版本为 ${meta.version}`, {
        targetVersion,
        latest: meta.version,
      });
    }
    const tree = new LazySegmentTree(this.loadInitial(id));
    const ops = this.db
      .prepare('SELECT kind, payload_json FROM operations WHERE array_id = ? AND version <= ? ORDER BY version')
      .all(id, targetVersion) as Array<{ kind: string; payload_json: string }>;
    for (const op of ops) {
      const payload = JSON.parse(op.payload_json) as OperationRow['payload'];
      if (op.kind === 'add') {
        tree.rangeAdd(payload.l, payload.r, BigInt(payload.delta));
      } else {
        for (const sub of payload.ops ?? []) {
          tree.rangeAdd(sub.l, sub.r, BigInt(sub.delta));
        }
      }
    }
    return { tree, version: targetVersion };
  }
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
