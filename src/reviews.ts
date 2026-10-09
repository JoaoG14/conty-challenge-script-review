import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isPastDeadline, isValidDeadline } from "./deadlines.ts";
import { transaction } from "./db.ts";

type VersionStatus = "in_review" | "changes_requested" | "superseded" | "approved";
type ScriptRow = { id: string; campaign_id: string; creator_id: string; created_at: string };
type VersionRow = {
  script_id: string;
  number: number;
  content: string;
  status: VersionStatus;
  submitted_at: string;
  reviewed_at: string | null;
  reason: string | null;
  deadline_date: string | null;
};

export class ReviewError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) {
    super(message);
  }
}

export function getScript(db: DatabaseSync, id: string, now: Date) {
  const script = db.prepare("SELECT * FROM scripts WHERE id = ?").get(id) as ScriptRow | undefined;
  if (!script) throw new ReviewError("roteiro não encontrado", 404);

  const rows = db.prepare("SELECT * FROM versions WHERE script_id = ? ORDER BY number").all(id) as VersionRow[];
  const versions = rows.map((row) => ({
    number: row.number,
    content: row.content,
    status: row.status === "changes_requested" && isPastDeadline(row.deadline_date!, now)
      ? "expired" as const
      : row.status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    change_request: row.reason === null ? null : {
      reason: row.reason,
      deadline_date: row.deadline_date!,
    },
  }));
  const current = versions[versions.length - 1];
  return { ...script, status: current.status, current_version: current.number, versions };
}

function currentVersion(db: DatabaseSync, id: string, number: number, now: Date) {
  const script = getScript(db, id, now);
  const version = script.versions.find((item) => item.number === number);
  if (!version) throw new ReviewError("versão não encontrada", 404);
  if (script.current_version !== number) throw new ReviewError("só a versão atual pode ser revisada", 409);
  return version;
}

function insertVersion(db: DatabaseSync, id: string, number: number, content: string, now: Date): void {
  db.prepare(`
    INSERT INTO versions (script_id, number, content, status, submitted_at)
    VALUES (?, ?, ?, 'in_review', ?)
  `).run(id, number, content, now.toISOString());
}

export function createScript(
  db: DatabaseSync,
  input: { campaign_id: string; creator_id: string; content: string },
  now: Date,
) {
  return transaction(db, () => {
    const id = randomUUID();
    db.prepare("INSERT INTO scripts (id, campaign_id, creator_id, created_at) VALUES (?, ?, ?, ?)")
      .run(id, input.campaign_id, input.creator_id, now.toISOString());
    insertVersion(db, id, 1, input.content, now);
    return getScript(db, id, now);
  });
}

export function requestChanges(
  db: DatabaseSync,
  id: string,
  number: number,
  input: { reason: string; deadline_date: string },
  now: Date,
) {
  if (!isValidDeadline(input.deadline_date)) throw new ReviewError("prazo deve ser uma data válida no formato YYYY-MM-DD", 400);
  if (isPastDeadline(input.deadline_date, now)) throw new ReviewError("prazo já passou", 409);

  return transaction(db, () => {
    const version = currentVersion(db, id, number, now);
    if (version.status !== "in_review") throw new ReviewError("versão não está em revisão", 409);
    db.prepare(`
      UPDATE versions SET status = 'changes_requested', reason = ?, deadline_date = ?, reviewed_at = ?
      WHERE script_id = ? AND number = ?
    `).run(input.reason, input.deadline_date, now.toISOString(), id, number);
    return getScript(db, id, now);
  });
}

export function submitVersion(db: DatabaseSync, id: string, content: string, now: Date) {
  return transaction(db, () => {
    const script = getScript(db, id, now);
    if (script.status === "expired") throw new ReviewError("prazo para enviar nova versão encerrado", 409);
    if (script.status !== "changes_requested") throw new ReviewError("roteiro não aguarda nova versão", 409);
    db.prepare("UPDATE versions SET status = 'superseded' WHERE script_id = ? AND number = ?")
      .run(id, script.current_version);
    insertVersion(db, id, script.current_version + 1, content, now);
    return getScript(db, id, now);
  });
}

export function approveVersion(db: DatabaseSync, id: string, number: number, now: Date) {
  return transaction(db, () => {
    const version = currentVersion(db, id, number, now);
    if (version.status !== "in_review") throw new ReviewError("versão não está em revisão", 409);
    db.prepare("UPDATE versions SET status = 'approved', reviewed_at = ? WHERE script_id = ? AND number = ?")
      .run(now.toISOString(), id, number);
    return getScript(db, id, now);
  });
}
