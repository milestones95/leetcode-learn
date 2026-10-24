// Turns a real captured session into an analyze-suite fixture, so your own practice becomes eval data.
//   npm run eval:capture -- <session_id>
// Then open the file and fill in `expected` by hand: what a correct analysis must find.
import fs from "node:fs";
import path from "node:path";
import { ROOT, localDate } from "../server/src/config.js";
import { getDb, getProblem, getSession, listJudgeEvents, listSnapshots } from "../server/src/db.js";
import { computeMetrics } from "../server/src/sessions.js";
import { type Category, categoryFromTags } from "../server/src/taxonomy.js";
import type { AnalyzeFixture } from "./fixtures.js";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: npm run eval:capture -- <session_id>");
  process.exit(1);
}
const db = getDb();
const session = getSession(db, sessionId);
if (!session?.ended_at) throw new Error(`Session ${sessionId} not found or still open`);
const problem = getProblem(db, session.slug);
const snapshots = listSnapshots(db, sessionId);
const judge = listJudgeEvents(db, sessionId);
const m = computeMetrics(session, snapshots, judge);
const minute = (ts: string) => Math.round(((Date.parse(ts) - Date.parse(session.started_at)) / 60_000) * 10) / 10;
const tags: string[] = problem ? JSON.parse(problem.tags) : [];

const fixture: AnalyzeFixture & { _todo: string } = {
  _todo: "Fill in expected.required_gaps, pattern_keywords, and must_not_claim, check expected.category, then delete this line.",
  id: `${session.slug}-${localDate(new Date(session.started_at))}`,
  description: "Captured from a real session.",
  problem: {
    slug: session.slug,
    title: problem?.title ?? session.slug,
    difficulty: problem?.difficulty,
    tags,
    category: problem?.category,
    description: problem?.description,
  },
  session: { started_at: session.started_at, ended_minute: minute(session.ended_at), end_reason: session.end_reason as AnalyzeFixture["session"]["end_reason"] },
  snapshots: snapshots.map((s) => ({ minute: minute(s.ts), language: s.language ?? "unknown", code: s.code })),
  judge_events: judge.map((j) => ({
    minute: minute(j.ts),
    kind: j.kind,
    status: j.status,
    ...(j.tests_total != null ? { tests_passed: j.tests_passed ?? 0, tests_total: j.tests_total } : {}),
    ...(j.error_detail ? { error_detail: j.error_detail } : {}),
  })),
  expected: {
    status: m.status,
    category: [(problem?.category as Category) ?? categoryFromTags(tags, problem?.title)],
    required_gaps: [],
    pattern_keywords: [],
    must_not_claim: [],
  },
};

const file = path.join(ROOT, "evals", "suites", "analyze", `${fixture.id}.json`);
fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${path.relative(ROOT, file)}; fill in "expected" before running evals`);
