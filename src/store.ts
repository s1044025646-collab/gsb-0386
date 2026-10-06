/**
 * SQLite 持久化：保存初始数组（快照）与操作日志。
 * 重启后通过确定性回放恢复段树状态（含尚未下推的懒标记），
 * 与不中断执行完全一致；历史版本通过回放前 v 条操作恢复。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OpRow {
  version: number;
  l: number;
  r: number;
  delta: string;
  explain: string; // JSON
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'segtree.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS arrays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        values_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        array_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        l INTEGER NOT NULL,
        r INTEGER NOT NULL,
        delta TEXT NOT NULL,
        explain TEXT NOT NULL,
        PRIMARY KEY (array_id, version)
      );
    `);
  }

  createArray(values: bigint[]): number {
    const stmt = this.db.prepare(
      'INSERT INTO arrays (values_json, created_at) VALUES (?, ?)');
    const res = stmt.run(JSON.stringify(values.map(String)), new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getArray(id: number): bigint[] | null {
    const row = this.db.prepare('SELECT values_json FROM arrays WHERE id = ?')
      .get(id) as { values_json: string } | undefined;
    if (!row) return null;
    return (JSON.parse(row.values_json) as string[]).map(BigInt);
  }

  listOps(arrayId: number, upToVersion?: number): OpRow[] {
    if (upToVersion === undefined) {
      return this.db.prepare(
        'SELECT version, l, r, delta, explain FROM ops WHERE array_id = ? ORDER BY version')
        .all(arrayId) as unknown as OpRow[];
    }
    return this.db.prepare(
      'SELECT version, l, r, delta, explain FROM ops WHERE array_id = ? AND version <= ? ORDER BY version')
      .all(arrayId, upToVersion) as unknown as OpRow[];
  }

  currentVersion(arrayId: number): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM ops WHERE array_id = ?')
      .get(arrayId) as { v: number };
    return Number(row.v);
  }

  /** 批量追加操作：单事务，任一失败整体回滚。 */
  appendOps(arrayId: number, ops: { l: number; r: number; delta: bigint; explain: string }[]): number {
    const base = this.currentVersion(arrayId);
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare(
        'INSERT INTO ops (array_id, version, l, r, delta, explain) VALUES (?, ?, ?, ?, ?, ?)');
      ops.forEach((op, i) => {
        stmt.run(arrayId, base + i + 1, op.l, op.r, op.delta.toString(), op.explain);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return base + ops.length;
  }

  getExplain(arrayId: number, version: number): string | null {
    const row = this.db.prepare(
      'SELECT explain FROM ops WHERE array_id = ? AND version = ?')
      .get(arrayId, version) as { explain: string } | undefined;
    return row ? row.explain : null;
  }

  close(): void {
    this.db.close();
  }
}
