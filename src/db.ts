import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      script_id TEXT NOT NULL REFERENCES scripts(id),
      number INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_review', 'changes_requested', 'superseded', 'approved')),
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reason TEXT,
      deadline_date TEXT,
      PRIMARY KEY (script_id, number),
      CHECK ((reason IS NULL AND deadline_date IS NULL) OR (reason IS NOT NULL AND deadline_date IS NOT NULL))
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
