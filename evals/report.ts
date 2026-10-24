// Prints an eval run's pass rates, cost, and consistency, compared with the previous run.
//   npm run eval                     prints this automatically
//   npx tsx evals/report.ts [dir]    re-print a saved run
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/src/config.js";
import type { GradeResult } from "./graders/types.js";

export interface TrialResult {
  suite: string;
  case: string;
  trial: number;
  graders: GradeResult[];
  cost_usd: number | null;
  judge_cost_usd: number | null;
  tokens?: { input: number; output: number; cached: number };
  latency_ms: number;
  model_calls: number;
  tool_calls: number;
  trace: string;
  error?: string;
  fingerprint?: { category?: string; gap_tags?: string[]; recommended?: string[] };
}

export interface RunResults {
  run_id: string;
  model: string;
  effort: string;
  judge_model: string | null;
  trials: number;
  results: TrialResult[];
  consistency: Array<{ case: string; metrics: Record<string, number> }>;
}

/** Pass rate per "suite/grader", with judge criteria grouped under one prefix per suite. */
export function graderPassRates(run: RunResults): Map<string, { pass: number; total: number }> {
  const out = new Map<string, { pass: number; total: number }>();
  for (const r of run.results) {
    for (const g of r.graders) {
      // Per-fixture criteria (required_gap_0, judge:finds_gap_1, …) share a name across cases by index, which is fine.
      const key = `${r.suite}/${g.name}`;
      const e = out.get(key) ?? { pass: 0, total: 0 };
      e.total++;
      if (g.pass) e.pass++;
      out.set(key, e);
    }
  }
  return out;
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

export function printReport(run: RunResults, previous?: RunResults) {
  const rates = graderPassRates(run);
  const prevRates = previous ? graderPassRates(previous) : undefined;

  console.log(`\n== Eval report ${run.run_id} · ${run.model} (effort ${run.effort}) · ${run.trials} trial(s) ==`);
  if (previous) console.log(`   compared with ${previous.run_id} (${previous.model}, effort ${previous.effort})`);

  console.log(`\nGraders (pass rate${previous ? ", change vs previous" : ""})`);
  for (const [key, e] of [...rates.entries()].sort()) {
    const rate = e.pass / e.total;
    const prev = prevRates?.get(key);
    const delta = prev ? rate - prev.pass / prev.total : undefined;
    const change = delta === undefined ? "" : delta === 0 ? "   =" : `${delta > 0 ? "  +" : "  "}${Math.round(delta * 100)}%`;
    console.log(`  ${pct(rate)} ${`(${e.pass}/${e.total})`.padEnd(8)} ${key.padEnd(48)}${change}`);
  }

  console.log(`\nCases (all graders passed / trials)`);
  for (const id of [...new Set(run.results.map((r) => `${r.suite}/${r.case}`))].sort()) {
    const rs = run.results.filter((r) => `${r.suite}/${r.case}` === id);
    const clean = rs.filter((r) => r.graders.every((g) => g.pass)).length;
    const failing = [...new Set(rs.flatMap((r) => r.graders.filter((g) => !g.pass).map((g) => g.name)))];
    console.log(`  ${clean}/${rs.length}  ${id}${failing.length ? `  failing: ${failing.join(", ")}` : ""}`);
  }

  if (run.consistency.length) {
    console.log(`\nConsistency across trials (1.0 = identical every time)`);
    for (const c of run.consistency) {
      console.log(`  ${c.case.padEnd(40)} ${Object.entries(c.metrics).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ")}`);
    }
  }

  const n = Math.max(run.results.length, 1);
  const sum = (pick: (r: TrialResult) => number | null) =>
    run.results.some((r) => r.error === undefined && pick(r) === null) ? null : run.results.reduce((a, r) => a + (pick(r) ?? 0), 0);
  const agentCost = sum((r) => r.cost_usd);
  const judgeCost = sum((r) => r.judge_cost_usd);
  const money = (c: number | null) => (c === null ? "n/a" : `$${c.toFixed(3)}`);
  const tokens = run.results.reduce((a, r) => ({ input: a.input + (r.tokens?.input ?? 0), output: a.output + (r.tokens?.output ?? 0), cached: a.cached + (r.tokens?.cached ?? 0) }), { input: 0, output: 0, cached: 0 });
  const avgLatency = run.results.reduce((a, r) => a + r.latency_ms, 0) / n;
  const avgCalls = run.results.reduce((a, r) => a + r.model_calls, 0) / n;
  console.log(
    `\nCost: agent ${money(agentCost)} + judge ${money(judgeCost)}${agentCost === null || judgeCost === null ? " (unpriced model; set LCA_PRICE_PER_MTOK)" : ""}\n` +
      `Agent tokens: ${tokens.input} input + ${tokens.cached} cached input, ${tokens.output} output · ` +
      `avg ${(avgLatency / 1000).toFixed(1)}s, ${avgCalls.toFixed(1)} model calls per trial`,
  );
}

export function latestPreviousResults(resultsDir: string, excludeRunId: string): RunResults | undefined {
  if (!fs.existsSync(resultsDir)) return undefined;
  const runs = fs
    .readdirSync(resultsDir)
    .filter((d) => d !== excludeRunId && fs.existsSync(path.join(resultsDir, d, "results.json")))
    .sort();
  const last = runs.at(-1);
  return last ? (JSON.parse(fs.readFileSync(path.join(resultsDir, last, "results.json"), "utf8")) as RunResults) : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultsDir = path.join(ROOT, "evals", "results");
  const dir = process.argv[2] ?? fs.readdirSync(resultsDir).sort().at(-1);
  if (!dir) throw new Error("No eval results yet. Run `npm run eval`.");
  const runDir = path.isAbsolute(dir) ? dir : path.join(resultsDir, path.basename(dir));
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")) as RunResults;
  printReport(run, latestPreviousResults(resultsDir, run.run_id));
}
