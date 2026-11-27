import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.ts';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
  }
  return db;
}

export function transaction<T>(work: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','annotator')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT UNIQUE NOT NULL,
      tool_version TEXT,
      manifest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'imported',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batch_asset_basis (
      batch_id TEXT NOT NULL REFERENCES batches(batch_id),
      source TEXT NOT NULL,
      translation TEXT NOT NULL,
      PRIMARY KEY (batch_id, source)
    );

    CREATE TABLE IF NOT EXISTS batch_delivery_tasks (
      batch_id TEXT NOT NULL REFERENCES batches(batch_id),
      task TEXT NOT NULL,
      PRIMARY KEY (batch_id, task)
    );

    CREATE TABLE IF NOT EXISTS batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT,
      lang TEXT,
      duration_s REAL,
      episode_id TEXT,
      second_review INTEGER NOT NULL DEFAULT 0,
      UNIQUE (batch_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      task TEXT NOT NULL,
      mode TEXT NOT NULL,
      item_id TEXT NOT NULL,
      assignee_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'assigned',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
      assigned_at TEXT NOT NULL,
      submitted_at TEXT,
      UNIQUE (batch_id, task, mode, item_id, assignee_id)
    );

    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      task TEXT NOT NULL,
      mode TEXT NOT NULL,
      operator TEXT NOT NULL,
      assignee_id INTEGER NOT NULL,
      item_ids TEXT NOT NULL,
      file_name TEXT,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assignment_reviews (
      assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
      reviewer_id INTEGER REFERENCES users(id),
      state TEXT NOT NULL CHECK (state IN ('assigned','unassigned','review','rework','approved')),
      version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS review_versions (
      assignment_id INTEGER NOT NULL REFERENCES assignment_reviews(assignment_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('submitted','pass','fixed','return','reworked')),
      author_id INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      result_id INTEGER REFERENCES results(id),
      payload TEXT,
      timing_csv TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (assignment_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_assignment_reviews_reviewer ON assignment_reviews (reviewer_id);

    -- Restore the first recorded result as the starting point for previously submitted work.
    INSERT OR IGNORE INTO assignment_reviews (assignment_id, state, version)
    SELECT a.id, 'unassigned', 1 FROM assignments a
    WHERE a.mode = 'primary' AND a.status = 'submitted' AND EXISTS (
      SELECT 1 FROM results r, json_each(r.item_ids) item
      WHERE r.batch_id = a.batch_id AND r.task = a.task AND r.mode = a.mode
        AND r.assignee_id = a.assignee_id AND item.value = a.item_id
    );

    INSERT OR IGNORE INTO review_versions (assignment_id, version, kind, author_id, result_id, created_at)
    SELECT a.id, 1, 'submitted', a.assignee_id, r.id, r.uploaded_at
    FROM assignment_reviews w JOIN assignments a ON a.id = w.assignment_id
    JOIN results r ON r.id = (
      SELECT MIN(old.id) FROM results old, json_each(old.item_ids) item
      WHERE old.batch_id = a.batch_id AND old.task = a.task AND old.mode = a.mode
        AND old.assignee_id = a.assignee_id AND item.value = a.item_id
    )
    WHERE w.version > 0 AND NOT EXISTS (SELECT 1 FROM review_versions v WHERE v.assignment_id = a.id AND v.version = 1);

    CREATE INDEX IF NOT EXISTS idx_assignments_assignee ON assignments (assignee_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_batch ON assignments (batch_id);
    CREATE INDEX IF NOT EXISTS idx_results_batch ON results (batch_id);
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS supplier_jobs (
      id INTEGER PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      task TEXT NOT NULL,
      priority TEXT NOT NULL,
      dispatched_at TEXT NOT NULL,
      assignment_id INTEGER UNIQUE REFERENCES assignments(id) ON DELETE SET NULL,
      started_at TEXT,
      review_started_at TEXT,
      rework_started_at TEXT,
      UNIQUE (batch_id, item_id, task),
      FOREIGN KEY (batch_id, item_id) REFERENCES batch_items(batch_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_jobs_org ON supplier_jobs(supplier_id);
    CREATE TABLE IF NOT EXISTS supplier_transfers (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES supplier_jobs(id),
      stage TEXT NOT NULL, previous_id INTEGER, next_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_confirmations (
      batch_id TEXT NOT NULL, item_id TEXT NOT NULL, manifest TEXT NOT NULL,
      actor_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, item_id, manifest)
    );
    CREATE TABLE IF NOT EXISTS company_checks (
      id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assignments(id),
      version INTEGER NOT NULL, actor_id INTEGER NOT NULL, outcome TEXT NOT NULL,
      note TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_review_timings (
      assignment_id INTEGER NOT NULL, version INTEGER NOT NULL, elapsed_seconds INTEGER NOT NULL,
      PRIMARY KEY (assignment_id, version)
    );
  `);
  const users = d.prepare('PRAGMA table_info(users)').all();
  if (!users.some(column => column.name === 'supplier_id')) {
    d.exec('ALTER TABLE users ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)');
  }
  if (!users.some(column => column.name === 'work_role')) {
    d.exec("ALTER TABLE users ADD COLUMN work_role TEXT NOT NULL DEFAULT 'legacy'");
  }
  const columns = d.prepare('PRAGMA table_info(assignments)').all();
  if (!columns.some(column => column.name === 'priority')) {
    d.exec("ALTER TABLE assignments ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent'))");
  }
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: 'admin' | 'annotator';
  created_at: string;
  supplier_id: number | null;
  work_role: 'legacy' | 'annotation' | 'review' | 'supplier_manager';
}

export interface AssignmentRow {
  id: number;
  batch_id: string;
  task: string;
  mode: string;
  item_id: string;
  assignee_id: number;
  status: 'assigned' | 'submitted';
  priority: 'normal' | 'high' | 'urgent';
  assigned_at: string;
  submitted_at: string | null;
}

export interface BatchItemRow {
  id: number;
  batch_id: string;
  item_id: string;
  title: string | null;
  lang: string | null;
  duration_s: number | null;
  episode_id: string | null;
  second_review: number;
}
