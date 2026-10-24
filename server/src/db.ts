import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import type { AttemptStatus, Category, GapTag } from "./taxonomy.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS problems (
  slug         TEXT PRIMARY KEY,
  frontend_id  TEXT,
  title        TEXT NOT NULL,
  difficulty   TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',   -- JSON array of LeetCode topic tag slugs
  category     TEXT,                          -- taxonomy hint derived from tags
  description  TEXT,                          -- plain text, filled when you open the problem
  paid_only    INTEGER NOT NULL DEFAULT 0,
  ac_rate      REAL,
  updated_at   TEXT NOT NULL
);

-- One sitting on one problem.
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at         TEXT,
  end_reason       TEXT,                         -- accepted | ended | gave_up | idle
  analysis_status  TEXT NOT NULL DEFAULT 'open', -- open | pending | running | done | skipped | error
  analysis_error   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_slug ON sessions(slug, ended_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts         TEXT NOT NULL,
  language   TEXT,
  code       TEXT NOT NULL,
  partial    INTEGER NOT NULL DEFAULT 0  -- 1 if read from the DOM fallback (may miss off-screen lines)
);
CREATE INDEX IF NOT EXISTS snapshots_session ON snapshots(session_id, ts);

-- A single Run or Submit result from LeetCode's judge.
CREATE TABLE IF NOT EXISTS judge_events (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- run | submit
  status       TEXT NOT NULL,   -- Accepted, Wrong Answer, Time Limit Exceeded, ...
  tests_passed INTEGER,
  tests_total  INTEGER,
  runtime      TEXT,
  memory       TEXT,
  error_detail TEXT,
  language     TEXT
);
CREATE INDEX IF NOT EXISTS judge_session ON judge_events(session_id, ts);

-- One analyzed record per session: the practice log.
CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT UNIQUE REFERENCES sessions(id),
  slug             TEXT NOT NULL,
  date             TEXT NOT NULL,      -- YYYY-MM-DD local
  status           TEXT NOT NULL,      -- passed | failed | gave_up
  time_taken_min   REAL,
  category         TEXT NOT NULL,
  approach_pattern TEXT,
  approach_summary TEXT,
  strengths        TEXT NOT NULL DEFAULT '[]',
  optimal_approach TEXT,
  time_complexity  TEXT,
  space_complexity TEXT,
  confidence       REAL,
  source           TEXT NOT NULL DEFAULT 'extension',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_slug ON attempts(slug, date);
CREATE INDEX IF NOT EXISTS attempts_category ON attempts(category, date);

CREATE TABLE IF NOT EXISTS attempt_gaps (
  id         INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  detail     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gaps_attempt ON attempt_gaps(attempt_id);
`;

export type DB = Database.Database;

export function openDb(dbPath = config.dbPath): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL lets the ingest server and the MCP server process read and write the same file concurrently.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

let shared: DB | undefined;
export function getDb(): DB {
  shared ??= openDb();
  return shared;
}

// ---- Row types ----

export interface ProblemRow {
  slug: string;
  frontend_id: string | null;
  title: string;
  difficulty: string | null;
  tags: string;
  category: string | null;
  description: string | null;
  paid_only: number;
  ac_rate: number | null;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  slug: string;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  end_reason: string | null;
  analysis_status: string;
  analysis_error: string | null;
}

export interface SnapshotRow {
  id: number;
  session_id: string;
  ts: string;
  language: string | null;
  code: string;
  partial: number;
}

export interface JudgeEventRow {
  id: number;
  session_id: string;
  ts: string;
  kind: "run" | "submit";
  status: string;
  tests_passed: number | null;
  tests_total: number | null;
  runtime: string | null;
  memory: string | null;
  error_detail: string | null;
  language: string | null;
}

export interface AttemptRow {
  id: number;
  session_id: string | null;
  slug: string;
  date: string;
  status: AttemptStatus;
  time_taken_min: number | null;
  category: Category;
  approach_pattern: string | null;
  approach_summary: string | null;
  strengths: string;
  optimal_approach: string | null;
  time_complexity: string | null;
  space_complexity: string | null;
  confidence: number | null;
  source: string;
  created_at: string;
}

export interface GapInput {
  tag: GapTag;
  detail: string;
}

// ---- Problems ----

export interface ProblemInput {
  slug: string;
  title: string;
  frontend_id?: string | null;
  difficulty?: string | null;
  tags?: string[];
  category?: string | null;
  description?: string | null;
  paid_only?: boolean;
  ac_rate?: number | null;
}

/** Insert or update a problem. Fields left undefined keep their stored value. */
export function upsertProblem(db: DB, p: ProblemInput): void {
  db.prepare(
    `INSERT INTO problems (slug, frontend_id, title, difficulty, tags, category, description, paid_only, ac_rate, updated_at)
     VALUES (@slug, @frontend_id, @title, @difficulty, @tags, @category, @description, @paid_only, @ac_rate, @updated_at)
     ON CONFLICT(slug) DO UPDATE SET
       frontend_id = COALESCE(excluded.frontend_id, frontend_id),
       title       = excluded.title,
       difficulty  = COALESCE(excluded.difficulty, difficulty),
       tags        = CASE WHEN excluded.tags = '[]' THEN tags ELSE excluded.tags END,
       category    = COALESCE(excluded.category, category),
       description = COALESCE(excluded.description, description),
       paid_only   = excluded.paid_only,
       ac_rate     = COALESCE(excluded.ac_rate, ac_rate),
       updated_at  = excluded.updated_at`,
  ).run({
    slug: p.slug,
    frontend_id: p.frontend_id ?? null,
    title: p.title,
    difficulty: p.difficulty ?? null,
    tags: JSON.stringify(p.tags ?? []),
    category: p.category ?? null,
    description: p.description ?? null,
    paid_only: p.paid_only ? 1 : 0,
    ac_rate: p.ac_rate ?? null,
    updated_at: new Date().toISOString(),
  });
}

export function getProblem(db: DB, slug: string): ProblemRow | undefined {
  return db.prepare(`SELECT * FROM problems WHERE slug = ?`).get(slug) as ProblemRow | undefined;
}

// ---- Sessions ----

export function getSession(db: DB, id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function findOpenSession(db: DB, slug: string): SessionRow | undefined {
  return db
    .prepare(`SELECT * FROM sessions WHERE slug = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`)
    .get(slug) as SessionRow | undefined;
}

export function createSession(db: DB, id: string, slug: string, ts: string): SessionRow {
  db.prepare(`INSERT INTO sessions (id, slug, started_at, last_activity_at) VALUES (?, ?, ?, ?)`).run(id, slug, ts, ts);
  return getSession(db, id)!;
}

export function touchSession(db: DB, id: string, ts: string): void {
  db.prepare(`UPDATE sessions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`).run(ts, id);
}

export function endSession(db: DB, id: string, ts: string, reason: string): void {
  db.prepare(
    `UPDATE sessions SET ended_at = ?, end_reason = ?, analysis_status = 'pending' WHERE id = ? AND ended_at IS NULL`,
  ).run(ts, reason, id);
}

export function setAnalysisStatus(db: DB, id: string, status: string, error: string | null = null): void {
  db.prepare(`UPDATE sessions SET analysis_status = ?, analysis_error = ? WHERE id = ?`).run(status, error, id);
}

export function listSnapshots(db: DB, sessionId: string): SnapshotRow[] {
  return db.prepare(`SELECT * FROM snapshots WHERE session_id = ? ORDER BY ts, id`).all(sessionId) as SnapshotRow[];
}

export function lastSnapshot(db: DB, sessionId: string): SnapshotRow | undefined {
  return db
    .prepare(`SELECT * FROM snapshots WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1`)
    .get(sessionId) as SnapshotRow | undefined;
}

export function insertSnapshot(
  db: DB,
  s: { session_id: string; ts: string; language: string | null; code: string; partial?: boolean },
): void {
  db.prepare(`INSERT INTO snapshots (session_id, ts, language, code, partial) VALUES (?, ?, ?, ?, ?)`).run(
    s.session_id,
    s.ts,
    s.language,
    s.code,
    s.partial ? 1 : 0,
  );
}

export function listJudgeEvents(db: DB, sessionId: string): JudgeEventRow[] {
  return db.prepare(`SELECT * FROM judge_events WHERE session_id = ? ORDER BY ts, id`).all(sessionId) as JudgeEventRow[];
}

export function insertJudgeEvent(db: DB, e: Omit<JudgeEventRow, "id">): void {
  db.prepare(
    `INSERT INTO judge_events (session_id, ts, kind, status, tests_passed, tests_total, runtime, memory, error_detail, language)
     VALUES (@session_id, @ts, @kind, @status, @tests_passed, @tests_total, @runtime, @memory, @error_detail, @language)`,
  ).run(e);
}

// ---- Attempts ----

export type AttemptInput = Omit<AttemptRow, "id" | "created_at" | "strengths"> & { strengths: string[] };

export function insertAttempt(db: DB, a: AttemptInput, gaps: GapInput[]): number {
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO attempts (session_id, slug, date, status, time_taken_min, category, approach_pattern, approach_summary,
           strengths, optimal_approach, time_complexity, space_complexity, confidence, source, created_at)
         VALUES (@session_id, @slug, @date, @status, @time_taken_min, @category, @approach_pattern, @approach_summary,
           @strengths, @optimal_approach, @time_complexity, @space_complexity, @confidence, @source, @created_at)`,
      )
      .run({ ...a, strengths: JSON.stringify(a.strengths), created_at: new Date().toISOString() });
    const insertGap = db.prepare(`INSERT INTO attempt_gaps (attempt_id, tag, detail) VALUES (?, ?, ?)`);
    for (const g of gaps) insertGap.run(lastInsertRowid, g.tag, g.detail);
    return Number(lastInsertRowid);
  })();
}

export function getAttemptBySession(db: DB, sessionId: string): AttemptRow | undefined {
  return db.prepare(`SELECT * FROM attempts WHERE session_id = ?`).get(sessionId) as AttemptRow | undefined;
}

export function gapsForAttempts(db: DB, attemptIds: number[]): Map<number, GapInput[]> {
  const out = new Map<number, GapInput[]>();
  if (attemptIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT attempt_id, tag, detail FROM attempt_gaps WHERE attempt_id IN (${attemptIds.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...attemptIds) as Array<{ attempt_id: number; tag: GapTag; detail: string }>;
  for (const r of rows) {
    const list = out.get(r.attempt_id) ?? [];
    list.push({ tag: r.tag, detail: r.detail });
    out.set(r.attempt_id, list);
  }
  return out;
}
