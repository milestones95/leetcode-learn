// The analyzer agent: reads one finished session through MCP tools and saves an attempt.
// Runs automatically from the ingest server, or by hand: `npm run analyze -- <session_id>`.
import { pathToFileURL } from "node:url";
import { type Effort, config } from "../config.js";
import { Agent } from "./harness.js";
import { ANALYZER_SYSTEM, ANALYZER_TOOLS } from "./prompts.js";
import { formatCost, toolCalls } from "./trace.js";

export interface AnalyzeOptions {
  env?: Record<string, string>;
  tracesDir?: string;
  model?: string;
  effort?: Effort;
  verbose?: boolean;
}

export interface AnalyzeResult {
  saved: boolean;
  summary: string;
  stop: string;
  tracePath: string;
  costUsd: number | null;
}

export async function analyzeSession(sessionId: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const agent = await Agent.start({
    name: "analyzer",
    system: ANALYZER_SYSTEM,
    allowedTools: ANALYZER_TOOLS,
    maxTurns: 8,
    model: opts.model,
    effort: opts.effort,
    env: opts.env,
    tracesDir: opts.tracesDir,
    onEvent: opts.verbose
      ? (e) => console.log(e.type === "tool" ? `  → ${e.name}${e.is_error ? " (error)" : ""}` : `  model call ${e.call}: ${e.stop_reason}`)
      : undefined,
  });
  let result;
  try {
    result = await agent.send(`Analyze practice session ${sessionId} and save the attempt.`);
  } catch (err) {
    agent.recordError(err);
    await agent.close();
    throw err;
  }
  const tracePath = await agent.close();
  const saved = toolCalls(agent.trace).some((c) => c.name === "save_attempt" && !c.is_error);
  return { saved, summary: result.text, stop: result.stop, tracePath, costUsd: agent.trace.totals.cost_usd };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("usage: npm run analyze -- <session_id>");
    process.exit(1);
  }
  console.log(`Analyzing ${sessionId} with ${config.model} (effort ${config.effort})…`);
  const r = await analyzeSession(sessionId, { verbose: true });
  console.log(`\n${r.summary}\n\nsaved: ${r.saved} · stop: ${r.stop} · cost: ${formatCost(r.costUsd)}\ntrace: ${r.tracePath}`);
  if (!r.saved) process.exit(1);
}
