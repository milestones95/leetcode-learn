// Eval fixtures and the loaders that turn them into a throwaway SQLite database.
import fs from "node:fs";
import path from "node:path";
import { type DB, type ProblemInput, createSession, endSession, insertAttempt, insertJudgeEvent, insertSnapshot, upsertProblem } from "../server/src/db.js";
import type { AttemptStatus, Category, GapTag } from "../server/src/taxonomy.js";

export interface HistoryAttempt {
  slug: string;
  date: string;
  status: AttemptStatus;
  category: Category;
  time_taken_min?: number;
  approach_pattern?: string;
  gaps?: Array<{ tag: GapTag; detail: string }>;
}

export interface AnalyzeFixture {
  id: string;
  description: string;
  problem: ProblemInput;
  /** Prior attempts already in the log (e.g. to test "same gap as last time"). */
  history?: HistoryAttempt[];
  session: { started_at: string; ended_minute: number; end_reason: "accepted" | "ended" | "gave_up" | "idle" };
  snapshots: Array<{ minute: number; language: string; code: string }>;
  judge_events: Array<{
    minute: number;
    kind: "run" | "submit";
    status: string;
    tests_passed?: number;
    tests_total?: number;
    error_detail?: string;
  }>;
  expected: {
    status: AttemptStatus;
    /** Any of these categories is acceptable. */
    category: Category[];
    /** Each entry must be covered by at least one saved gap whose tag is in `tags`. */
    required_gaps: Array<{ tags: GapTag[]; description: string }>;
    max_gaps?: number;
    /** At least one keyword must appear in approach_pattern or approach_summary. */
    pattern_keywords: string[];
    /** Optional substring check on the user's final time complexity, e.g. "log". */
    time_complexity_includes?: string;
    /** At least one gap detail must reference an earlier attempt (for repeat-gap fixtures). */
    mentions_repeat?: boolean;
    /** Claims the analysis must not make; graded by the LLM judge. */
    must_not_claim: string[];
  };
}

export interface CoachFixture {
  id: string;
  description: string;
  today: string;
  problems: ProblemInput[];
  attempts: HistoryAttempt[];
  question: string;
  expected: {
    must_call_tools: string[];
    /** Each inner list is a set of synonyms; the answer must mention one from every list. */
    must_mention: string[][];
    /** The answer must mention at least one of these problem slugs or titles, if given. */
    must_recommend_any?: string[];
    /** Rubric items for the LLM judge, in addition to the standard grounding check. */
    judge_criteria: string[];
  };
}

const minutesAfter = (start: string, minute: number) => new Date(Date.parse(start) + minute * 60_000).toISOString();

function loadHistory(db: DB, history: HistoryAttempt[]) {
  for (const h of history) {
    insertAttempt(
      db,
      {
        session_id: null,
        slug: h.slug,
        date: h.date,
        status: h.status,
        time_taken_min: h.time_taken_min ?? null,
        category: h.category,
        approach_pattern: h.approach_pattern ?? null,
        approach_summary: null,
        verdict_reason: null,
        strengths: [],
        optimal_approach: null,
        time_complexity: null,
        space_complexity: null,
        confidence: null,
        source: "fixture",
      },
      h.gaps ?? [],
    );
  }
}

/** Load an analyze fixture; returns the session id to analyze. */
export function loadAnalyzeFixture(db: DB, f: AnalyzeFixture): string {
  const { started_at } = f.session;
  db.transaction(() => {
    upsertProblem(db, f.problem);
    loadHistory(db, f.history ?? []);
    createSession(db, f.id, f.problem.slug, started_at);
    for (const s of f.snapshots) {
      insertSnapshot(db, { session_id: f.id, ts: minutesAfter(started_at, s.minute), language: s.language, code: s.code });
    }
    for (const j of f.judge_events) {
      insertJudgeEvent(db, {
        session_id: f.id,
        ts: minutesAfter(started_at, j.minute),
        kind: j.kind,
        status: j.status,
        tests_passed: j.tests_passed ?? null,
        tests_total: j.tests_total ?? null,
        runtime: null,
        memory: null,
        error_detail: j.error_detail ?? null,
        language: f.snapshots.at(-1)?.language ?? null,
      });
    }
    const last = [...f.snapshots.map((s) => s.minute), ...f.judge_events.map((j) => j.minute)].reduce((a, b) => Math.max(a, b), 0);
    db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(minutesAfter(started_at, last), f.id);
    endSession(db, f.id, minutesAfter(started_at, f.session.ended_minute), f.session.end_reason);
  })();
  return f.id;
}

export function loadCoachFixture(db: DB, f: CoachFixture): void {
  db.transaction(() => {
    for (const p of f.problems) upsertProblem(db, p);
    loadHistory(db, f.attempts);
  })();
}

export function readFixtures<T extends { id: string }>(dir: string): T[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T);
}
