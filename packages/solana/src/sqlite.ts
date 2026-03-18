import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export type SqliteStatementLike = {
  run: (...args: any[]) => { changes?: number; lastInsertRowid?: number | bigint } | void;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any[];
};

export type DatabaseSyncLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatementLike;
  close: () => void;
};

export function isEphemeralSqlitePath(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath.startsWith('file:');
}

export function resolveSqlitePath(dbPath: string): string {
  return isEphemeralSqlitePath(dbPath) ? dbPath : resolve(dbPath);
}

export function openSqliteDatabase(dbPath: string): DatabaseSyncLike {
  const resolved = resolveSqlitePath(dbPath);
  if (!isEphemeralSqlitePath(resolved)) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSyncLike };
  return new sqlite.DatabaseSync(resolved);
}

export function initializeWalMode(db: DatabaseSyncLike): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}
