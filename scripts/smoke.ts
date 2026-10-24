// End-to-end smoke test with no Claude calls: simulated extension events → ingest → SQLite → every MCP tool
// over a real stdio connection. `npm run smoke`
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../server/src/config.js";
import { getSession, openDb } from "../server/src/db.js";
import { Ingest, createServer } from "../server/src/ingest.js";
import { type CoachFixture, loadCoachFixture, readFixtures } from "../evals/fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lca-smoke-"));
const dbPath = path.join(dir, "smoke.db");
const db = openDb(dbPath);
let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---- Ingest: a session from page view to Accepted ----
console.log("ingest");
const analyzed: string[] = [];
const ingest = new Ingest(db, async (id) => {
  analyzed.push(id);
  return { saved: true };
});
const t0 = Date.parse("2026-10-20T15:00:00.000Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();

const { session_id } = ingest.handle({
  type: "problem_view",
  slug: "two-sum",
  ts: at(0),
  problem: { title: "Two Sum", difficulty: "Easy", tags: ["array", "hash-table"], content_html: "<p>Given an array of integers <code>nums</code>&nbsp;and…</p>" },
});
assert.ok(session_id);
ingest.handle({ type: "snapshot", slug: "two-sum", ts: at(0.1), language: "python3", code: "class Solution:\n    def twoSum(self, nums, target):\n        " });
ingest.handle({ type: "snapshot", slug: "two-sum", ts: at(0.2), language: "python3", code: "class Solution:\n    def twoSum(self, nums, target):\n        " }); // unchanged → ignored
ingest.handle({
  type: "snapshot",
  slug: "two-sum",
  ts: at(4),
  language: "python3",
  code: "class Solution:\n    def twoSum(self, nums, target):\n        for i in range(len(nums)):\n            for j in range(len(nums)):\n                if nums[i] + nums[j] == target:\n                    return [i, j]",
});
ingest.handle({
  type: "judge",
  slug: "two-sum",
  ts: at(5),
  url: "/submissions/detail/runcode_1729_abc/check/",
  data: { state: "SUCCESS", status_msg: "Accepted", correct_answer: false, code_answer: ["[0,0]"], expected_code_answer: ["[0,1]"], total_correct: 1, total_testcases: 3, lang: "python3" },
});
ingest.handle({
  type: "judge",
  slug: "two-sum",
  ts: at(9),
  url: "/submissions/detail/1234567/check/",
  code: "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i",
  data: { state: "SUCCESS", status_msg: "Wrong Answer", total_correct: 50, total_testcases: 63, last_testcase: "[3,3]\n6", code_output: "[]", expected_output: "[0,1]", lang: "python3" },
});
const end = ingest.handle({
  type: "judge",
  slug: "two-sum",
  ts: at(12),
  url: "/submissions/detail/1234568/check/",
  data: { state: "SUCCESS", status_msg: "Accepted", total_correct: 63, total_testcases: 63, status_runtime: "52 ms", status_memory: "17.1 MB", lang: "python3" },
});
await new Promise((r) => setTimeout(r, 20)); // let the analysis queue drain

check("Accepted submit ends the session and queues analysis", () => {
  assert.equal(end.ended, true);
  assert.deepEqual(analyzed, [session_id]);
  const s = getSession(db, session_id!)!;
  assert.equal(s.end_reason, "accepted");
  assert.equal(s.analysis_status, "done");
});
check("unchanged snapshots are deduplicated", () => {
  const n = (db.prepare(`SELECT COUNT(*) n FROM snapshots WHERE session_id = ?`).get(session_id) as { n: number }).n;
  assert.equal(n, 3); // starter, brute force, code captured with the WA submit
});
check("judge results are normalized (run vs submit, WA detail)", () => {
  const rows = db.prepare(`SELECT kind, status, tests_passed, error_detail FROM judge_events WHERE session_id = ? ORDER BY ts`).all(session_id) as Array<Record<string, unknown>>;
  assert.equal(rows[0].kind, "run");
  assert.equal(rows[0].status, "Wrong Answer (sample tests)");
  assert.equal(rows[1].status, "Wrong Answer");
  assert.match(String(rows[1].error_detail), /Expected: \[0,1\]/);
  assert.equal(rows[2].status, "Accepted");
});
check("problem description is stored as plain text", () => {
  const p = db.prepare(`SELECT description, category FROM problems WHERE slug = 'two-sum'`).get() as { description: string; category: string };
  assert.equal(p.description, "Given an array of integers nums and…");
  assert.equal(p.category, "Arrays & Hashing");
});

ingest.handle({ type: "problem_view", slug: "climbing-stairs", ts: at(20), problem: { title: "Climbing Stairs", difficulty: "Easy", tags: ["dynamic-programming"] } });
ingest.handle({ type: "snapshot", slug: "climbing-stairs", ts: at(20.1), language: "python3", code: "class Solution:\n    pass" });
ingest.sweepIdle(new Date(t0 + 60 * 60_000));
check("idle page views are ended and skipped", () => {
  const s = db.prepare(`SELECT * FROM sessions WHERE slug = 'climbing-stairs'`).get() as { end_reason: string; analysis_status: string };
  assert.equal(s.end_reason, "idle");
  assert.equal(s.analysis_status, "skipped");
});

// ---- HTTP ----
console.log("http");
const server = createServer(ingest);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = await fetch(`${base}/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ events: [{ type: "snapshot", slug: "valid-anagram", language: "python3", code: "x = 1" }] }),
}).then((r) => r.json());
const current = await fetch(`${base}/sessions/current?slug=valid-anagram`).then((r) => r.json());
server.close();
check("POST /events and GET /sessions/current", () => {
  assert.equal(post.ok, true);
  assert.equal(current.open, true);
  assert.equal(current.metrics.snapshot_count, 1);
});

// ---- MCP tools over stdio ----
async function connect(env: Record<string, string>) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(ROOT, "server/src/mcp/server.ts")],
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "ignore",
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
    return { isError: Boolean(r.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call };
}

console.log("mcp (session tools)");
const s = await connect({ LCA_DB: dbPath });
const { tools } = await s.client.listTools();
check("lists all 9 tools", () => assert.equal(tools.length, 9));

const sess = (await s.call("get_session", { session_id })).json();
check("get_session reports computed metrics", () => {
  assert.equal(sess.metrics.status, "passed");
  assert.equal(sess.metrics.submit_count, 2);
  assert.equal(sess.metrics.failed_submit_count, 1);
  assert.equal(sess.metrics.wall_minutes, 12);
});
const timeline = (await s.call("get_code_timeline", { session_id })).text;
check("get_code_timeline interleaves diffs and judge results", () => {
  assert.match(timeline, /^Language: python3\./);
  assert.match(timeline, /First snapshot/);
  assert.match(timeline, /^\+ +for j in range/m);
  assert.match(timeline, /SUBMIT → Wrong Answer \(50\/63 tests\)/);
  assert.match(timeline, /Final code/);
});
const problem = (await s.call("get_problem", { slug: "two-sum" })).json();
check("get_problem", () => assert.deepEqual(problem.tags, ["array", "hash-table"]));

const attempt = {
  session_id,
  category: "Arrays & Hashing",
  approach_pattern: "hash map, one pass",
  approach_summary: "Started brute force, switched to a hash map.",
  strengths: ["Switched to the optimal approach"],
  gaps: [{ tag: "edge-cases", detail: "Missed duplicate values like [3,3]." }],
  optimal_approach: "One-pass hash map, O(n).",
  time_complexity: "O(n)",
  space_complexity: "O(n)",
  confidence: 0.8,
};
const saved = await s.call("save_attempt", attempt);
const again = await s.call("save_attempt", attempt);
const invalid = await s.call("save_attempt", { ...attempt, session_id: "nope", category: "Not A Category" });
check("save_attempt writes once, fills status/time from data, rejects repeats and bad enums", () => {
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.json().status, "passed");
  assert.equal(again.isError, true);
  assert.equal(invalid.isError, true);
});
const history = (await s.call("get_attempt_history", { slug: "two-sum" })).json();
check("get_attempt_history returns the attempt with gaps", () => {
  assert.equal(history.count, 1);
  assert.equal(history.attempts[0].gaps[0].tag, "edge-cases");
});
await s.client.close();

console.log("mcp (coaching tools, coach fixture db)");
const coachDb = path.join(dir, "coach.db");
const fixture = readFixtures<CoachFixture>(path.join(ROOT, "evals/suites/coach"))[0];
const cdb = openDb(coachDb);
loadCoachFixture(cdb, fixture);
cdb.close();
const c = await connect({ LCA_DB: coachDb, LCA_TODAY: fixture.today });
const stats = (await c.call("get_category_stats")).json();
check("get_category_stats covers every category, with known numbers", () => {
  assert.equal(stats.categories.length, 18);
  const dp = stats.categories.find((x: { category: string }) => x.category === "1-D DP");
  assert.equal(dp.attempts, 3);
  assert.equal(dp.pass_rate, 0);
});
const gaps = (await c.call("get_common_gaps")).json();
check("get_common_gaps ranks pattern-recognition first", () => assert.equal(gaps.gaps[0].tag, "pattern-recognition"));
const recs = (await c.call("recommend_practice", { count: 5 })).json();
check("recommend_practice is deterministic and spreads categories", () => {
  assert.equal(recs.recommendations.length, 5);
  assert.equal(recs.top_categories[0].category, "1-D DP");
  const perCat = new Map<string, number>();
  for (const r of recs.recommendations) perCat.set(r.category, (perCat.get(r.category) ?? 0) + 1);
  assert.ok(Math.max(...perCat.values()) <= 2);
});
const search = (await c.call("search_problems", { category: "Graphs", unattempted_only: true })).json();
check("search_problems filters unattempted", () => {
  assert.ok(search.problems.length > 0);
  assert.ok(search.problems.every((p: { times_attempted: number }) => p.times_attempted === 0));
});
await c.client.close();

console.log("\nrecommend_practice sample:");
for (const r of recs.recommendations) console.log(`  ${r.score.toFixed(2)} ${r.kind.padEnd(6)} ${r.title} (${r.category}) — ${r.reasons[0]}`);
console.log(`\ntimeline sample:\n${timeline.split("\n").slice(0, 24).join("\n")}\n…`);
console.log(`\n${passed} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
