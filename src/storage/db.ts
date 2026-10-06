import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { Logger } from '../utils/logger';

export interface AccountRow {
  id: string;
  username: string;
  label: string | null;
  enabled: number;
  authenticated: number;
  status: string | null;
  safety_profile: string;
  account_context: string | null;
  target_hashtags: string | null;
  last_health_check: string | null;
  created_at: string;
}

export interface QuotaRow {
  account_id: string;
  likes_today: number;
  comments_today: number;
  dms_today: number;
  likes_this_hour: number;
  comments_this_hour: number;
  dms_this_hour: number;
  last_reset_day: string;
  last_reset_hour: string;
}

export interface ActionJobRow {
  id: string;
  type: string;
  payload: string;
  assigned_account_id: string | null;
  status: string;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface InteractionRow {
  account_id: string;
  post_id: string;
  action_type: string;
  interacted_at: string;
}

export interface AccountLogRow {
  id: number;
  account_id: string;
  level: string;
  message: string;
  created_at: string;
}

let _db: Database.Database | null = null;
let _migrated = false;

function getDataDir(): string {
  return path.join(config.paths.dataDir, 'accounts');
}

export function getDb(): Database.Database {
  if (_db) return _db;

  try {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dbPath = path.join(dir, 'instagram.db');
    _db = new Database(dbPath);

    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');

    if (!_migrated) {
      _migrated = true;
      runMigrationsInternal(_db);
    }

    Logger.info(`SQLite DB opened: ${dbPath} (WAL mode enabled)`);
    return _db;
  } catch (err: any) {
    Logger.error(`Failed to open SQLite database: ${err.message}`);
    throw err;
  }
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
      Logger.info('SQLite DB closed.');
    } catch (err: any) {
      Logger.error(`Error closing DB: ${err.message}`);
    } finally {
      _db = null;
      _migrated = false;
    }
  }
}

const MIGRATIONS: Record<string, string> = {
  accounts: `
    CREATE TABLE IF NOT EXISTS accounts (
      id              TEXT    PRIMARY KEY,
      username        TEXT    NOT NULL UNIQUE,
      label           TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      authenticated   INTEGER NOT NULL DEFAULT 0,
      status          TEXT,
      safety_profile  TEXT    NOT NULL DEFAULT 'balanced',
      account_context TEXT,
      target_hashtags TEXT,
      last_health_check TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `,
  quotas: `
    CREATE TABLE IF NOT EXISTS quotas (
      account_id            TEXT PRIMARY KEY,
      likes_today           INTEGER NOT NULL DEFAULT 0,
      comments_today        INTEGER NOT NULL DEFAULT 0,
      dms_today             INTEGER NOT NULL DEFAULT 0,
      likes_this_hour       INTEGER NOT NULL DEFAULT 0,
      comments_this_hour    INTEGER NOT NULL DEFAULT 0,
      dms_this_hour         INTEGER NOT NULL DEFAULT 0,
      last_reset_day        TEXT    NOT NULL,
      last_reset_hour       TEXT    NOT NULL DEFAULT '',
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `,
  action_jobs: `
    CREATE TABLE IF NOT EXISTS action_jobs (
      id                    TEXT PRIMARY KEY,
      type                  TEXT NOT NULL,
      payload               TEXT NOT NULL DEFAULT '{}',
      assigned_account_id   TEXT,
      status                TEXT NOT NULL DEFAULT 'QUEUED',
      attempts              INTEGER NOT NULL DEFAULT 0,
      error_message         TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (assigned_account_id) REFERENCES accounts(id) ON DELETE SET NULL
    )
  `,
  interactions: `
    CREATE TABLE IF NOT EXISTS interactions (
      account_id    TEXT NOT NULL,
      post_id       TEXT NOT NULL,
      action_type   TEXT NOT NULL,
      interacted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, post_id, action_type),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `,
  account_logs: `
    CREATE TABLE IF NOT EXISTS account_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT NOT NULL,
      level       TEXT NOT NULL DEFAULT 'info',
      message     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `,
};

function runMigrationsInternal(db: Database.Database): void {
  const tx = db.transaction(() => {
    for (const [name, sql] of Object.entries(MIGRATIONS)) {
      try {
        db.exec(sql);
      } catch (err: any) {
        Logger.error(`Migration failed for ${name}: ${err.message}`);
        throw err;
      }
    }
  });
  tx();
}

export function runMigrations(): void {
  const db = getDb();
  runMigrationsInternal(db);
}
