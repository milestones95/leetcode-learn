// Eval runner. Each case runs against its own throwaway database, N trials, then code graders, the LLM judge,
// and consistency across trials.
//
//   npm run eval                                  all suites, 3 trials
//   npm run eval -- --suite analyze --trials 1    one suite, one trial
//   npm run eval -- --only two-sum-clean --no-judge
//   npm run eval -- --model claude-haiku-5-5      compare a cheaper model
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeSession } from "../server/src/agent/analyze-session.js";
import { startCoach } from "../server/src/agent/coach.js";
import type { Trace } from "../server/src/agent/trace.js";
import { toolCalls } from "../server/src/agent/trace.js";
import { type Effort, ROOT, config } from "../server/src/config.js";
import { type AttemptRow, type GapInput, gapsForAttempts, getSession, listJudgeEvents, listSnapshots, openDb } from "../server/src/db.js";
import { renderTimeline } from "../server/src/mcp/tools/session.js";
import { computeMetrics } from "../server/src/sessions.js";
import { type AnalyzeFixture, type CoachFixture, loadAnalyzeFixture, loadCoachFixture, readFixtures } from "./fixtures.js";
import { gradeAnalyze, gradeCoach, mentionedProblems } from "./graders/code.js";
import { meanPairwiseJaccard, modalAgreement } from "./graders/consistency.js";
import { type Criterion, judge } from "./graders/judge.js";
import type { GradeResult } from "./graders/types.js";
import { type RunResults, type TrialResult, latestPreviousResults, printReport } from "./report.js";

const { values: args } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    trials: { type: "string", default: "3" },
    only: { type: "string" },
    "no-judge": { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
    model: { type: "string" },
    effort: { type: "string" },
  },
});
const trials = Number(args.trials);
const model = args.model ?? config.model;
const effort = (args.effort ?? config.effort) as Effort;
const only = args.only?.split(",");
const useJudge = !args["no-judge"];

const RESULTS_DIR = path.join(ROOT, "evals", "results");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(RESULTS_DIR, runId);
const tracesDir = path.join(outDir, "traces");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lca-eval-"));

const suites = args.suite === "all" ? ["analyze", "coach"] : [args.suite];
const pick = <T extends { id: string }>(xs: T[]) => (only ? xs.filter((x) => only.includes(x.id)) : xs);
const analyzeCases = suites.includes("analyze") ? pick(readFixtures<AnalyzeFixture>(path.join(ROOT, "evals/suites/analyze"))) : [];
const coachCases = suites.includes("coach") ? pick(readFixtures<CoachFixture>(path.join(ROOT, "evals/suites/coach"))) : [];

const readTrace = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")) as Trace;
const tokensOf = (t: Trace) => ({ input: t.totals.input_tokens, output: t.totals.output_tokens, cached: t.totals.cache_read_input_tokens });
const money = (c: number | null) => (c === null ? "$?" : `$${c.toFixed(3)}`);

// ---- analyze suite ----

async function runAnalyzeTrial(f: AnalyzeFixture, trial: number): Promise<TrialResult> {
  const dbPath = path.join(scratch, `${f.id}-${trial}.db`);
  const setup = openDb(dbPath);
  const sessionId = loadAnalyzeFixture(setup, f);
  setup.close();

  const started = Date.now();
  const r = await analyzeSession(sessionId, { env: { LCA_DB: dbPath }, tracesDir, model, effort });
  const trace = readTrace(r.tracePath);

  const db = openDb(dbPath);
  const attempts = db.prepare(`SELECT * FROM attempts WHERE session_id = ?`).all(sessionId) as AttemptRow[];
  const gaps: GapInput[] = attempts.length ? gapsForAttempts(db, [attempts[0].id]).get(attempts[0].id) ?? [] : [];
  const session = getSession(db, sessionId)!;
  const snapshots = listSnapshots(db, sessionId);
  const judgeEvents = listJudgeEvents(db, sessionId);
  db.close();

  const graders: GradeResult[] = gradeAnalyze(f, { attempts, gaps, summary: r.summary, stop: r.stop, trace });
  let judgeCost: number | null = 0;
  if (useJudge && attempts.length) {
    const e = f.expected;
    const criteria: Criterion[] = [
      ...e.required_gaps.map((g, i) => ({ id: `finds_gap_${i}`, text: `The analysis identifies this gap (in a gap entry or the summary): ${g.description}` })),
      ...e.must_not_claim.map((c, i) => ({ id: `avoids_claim_${i}`, text: `The analysis does NOT claim ${c}.` })),
      { id: "grounded", text: "Every factual claim about what the user did (code, runs, submissions, timing) is supported by the session data. Fail if any claim is contradicted or unsupported." },
      { id: "actionable", text: "Each gap's detail says concretely what to do differently next time. Pass if there are no gaps." },
      { id: "optimal_correct", text: "optimal_approach describes a correct best-known approach for this problem with its correct complexity." },
    ];
    const evidence = [
      `Problem: ${f.problem.title} (${f.problem.difficulty})\n${f.problem.description}`,
      `Session metrics: ${JSON.stringify(computeMetrics(session, snapshots, judgeEvents))}`,
      f.history?.length ? `Earlier attempts at this problem: ${JSON.stringify(f.history)}` : "Earlier attempts at this problem: none",
      `Code timeline:\n${renderTimeline(session.started_at, snapshots, judgeEvents, 40)}`,
    ].join("\n\n");
    const output = JSON.stringify({ attempt: { ...attempts[0], strengths: JSON.parse(attempts[0].strengths) }, gaps, summary_to_user: r.summary }, null, 2);
    const j = await judge(criteria, evidence, output);
    graders.push(...j.results);
    judgeCost = j.costUsd;
  }

  return {
    suite: "analyze",
    case: f.id,
    trial,
    graders,
    cost_usd: trace.totals.cost_usd,
    judge_cost_usd: judgeCost,
    tokens: tokensOf(trace),
    latency_ms: Date.now() - started,
    model_calls: trace.totals.model_calls,
    tool_calls: trace.totals.tool_calls,
    trace: path.relative(ROOT, r.tracePath),
    fingerprint: attempts[0] ? { category: attempts[0].category, gap_tags: [...new Set(gaps.map((g) => g.tag))].sort() } : undefined,
  };
}

// ---- coach suite ----

async function runCoachTrial(f: CoachFixture, trial: number): Promise<TrialResult> {
  const dbPath = path.join(scratch, `${f.id}-${trial}.db`);
  const setup = openDb(dbPath);
  loadCoachFixture(setup, f);
  setup.close();

  const started = Date.now();
  const agent = await startCoach({ env: { LCA_DB: dbPath, LCA_TODAY: f.today }, tracesDir, model, effort });
  let answer = "";
  let stop = "error";
  try {
    const r = await agent.send(f.question);
    answer = r.text;
    stop = r.stop;
  } catch (err) {
    agent.recordError(err);
    throw err;
  } finally {
    await agent.close();
  }
  const trace = agent.trace;
  const tracePath = path.join(tracesDir, `${trace.id}.json`);

  const graders = gradeCoach(f, { answer, stop, trace });
  let judgeCost: number | null = 0;
  if (useJudge) {
    const criteria: Criterion[] = [
      ...f.expected.judge_criteria.map((text, i) => ({ id: `criterion_${i}`, text })),
      {
        id: "grounded",
        text:
          "Every stat about the user's history (counts, pass rates, dates, scores, gap frequencies) and every problem named is supported by the tool outputs. " +
          "Fail on any invented or misquoted stat or problem. General practice advice (e.g. a suggested time box) is not a stat and needs no support.",
      },
    ];
    const evidence =
      `Today: ${f.today}\nUser question: ${f.question}\n\nTool calls the coach made and their outputs:\n` +
      toolCalls(trace)
        .map((c) => `## ${c.name}(${JSON.stringify(c.input)})\n${c.output.slice(0, 8000)}`)
        .join("\n\n");
    const j = await judge(criteria, evidence, answer);
    graders.push(...j.results);
    judgeCost = j.costUsd;
  }

  return {
    suite: "coach",
    case: f.id,
    trial,
    graders,
    cost_usd: trace.totals.cost_usd,
    judge_cost_usd: judgeCost,
    tokens: tokensOf(trace),
    latency_ms: Date.now() - started,
    model_calls: trace.totals.model_calls,
    tool_calls: trace.totals.tool_calls,
    trace: path.relative(ROOT, tracePath),
    fingerprint: { recommended: mentionedProblems(f, answer).map((p) => p.slug).sort() },
  };
}

// ---- orchestration ----

type Job = { suite: string; id: string; trial: number; run: () => Promise<TrialResult> };
const jobs: Job[] = [];
for (let t = 1; t <= trials; t++) {
  for (const f of analyzeCases) jobs.push({ suite: "analyze", id: f.id, trial: t, run: () => runAnalyzeTrial(f, t) });
  for (const f of coachCases) jobs.push({ suite: "coach", id: f.id, trial: t, run: () => runCoachTrial(f, t) });
}
if (jobs.length === 0) {
  console.error("No cases matched.");
  process.exit(1);
}

console.log(`Running ${jobs.length} trials (${analyzeCases.length} analyze + ${coachCases.length} coach cases × ${trials}) with ${model}, effort ${effort}${useJudge ? `, judge ${config.judgeModel}` : ", no judge"}`);
const results: TrialResult[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    try {
      const r = await job.run();
      results.push(r);
      const failed = r.graders.filter((g) => !g.pass).length;
      console.log(`  ${failed ? "✗" : "✓"} ${job.suite}/${job.id} #${job.trial}  ${r.graders.length - failed}/${r.graders.length} graders  ${r.cost_usd === null || r.judge_cost_usd === null ? `${r.tokens?.input ?? 0}+${r.tokens?.output ?? 0} tok` : money(r.cost_usd + r.judge_cost_usd)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${job.suite}/${job.id} #${job.trial}  error: ${message}`);
      results.push({ suite: job.suite, case: job.id, trial: job.trial, graders: [{ name: "ran_without_error", pass: false, detail: message }], cost_usd: 0, judge_cost_usd: 0, latency_ms: 0, model_calls: 0, tool_calls: 0, trace: "", error: message });
    }
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

// Consistency: compare trials of the same case.
const consistency: RunResults["consistency"] = [];
for (const id of new Set(results.map((r) => r.case))) {
  const rs = results.filter((r) => r.case === id && r.fingerprint);
  if (rs.length < 2) continue;
  const fp = rs.map((r) => r.fingerprint!);
  if (rs[0].suite === "analyze") {
    consistency.push({
      case: id,
      metrics: {
        category_agreement: modalAgreement(fp.map((x) => x.category ?? "")),
        gap_tag_jaccard: meanPairwiseJaccard(fp.map((x) => new Set(x.gap_tags ?? []))),
      },
    });
  } else {
    consistency.push({ case: id, metrics: { recommendation_jaccard: meanPairwiseJaccard(fp.map((x) => new Set(x.recommended ?? []))) } });
  }
}

const run: RunResults = { run_id: runId, model, effort, judge_model: useJudge ? config.judgeModel : null, trials, results, consistency };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(run, null, 2));
printReport(run, latestPreviousResults(RESULTS_DIR, runId));
console.log(`\nresults: ${path.relative(ROOT, path.join(outDir, "results.json"))}`);
fs.rmSync(scratch, { recursive: true, force: true });
