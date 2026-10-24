// A trace is the full record of one agent run: every model call, tool call, token count, and latency.
// Traces are how you debug the agent and what the evals grade.
import fs from "node:fs";
import path from "node:path";
import type { Usage } from "./providers/types.js";

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: string;
  is_error: boolean;
  latency_ms: number;
}

export type TraceStep =
  | { type: "user"; text: string }
  | {
      type: "model";
      call: number;
      latency_ms: number;
      stop_reason: string | null;
      usage: Usage;
      text: string;
      tool_uses: Array<{ id: string; name: string; input: unknown }>;
    }
  | ({ type: "tool" } & ToolCallRecord)
  | { type: "error"; message: string };

export interface Trace {
  id: string;
  agent: string;
  provider: string;
  model: string;
  effort: string;
  started_at: string;
  ended_at: string | null;
  tools: string[];
  system: string;
  steps: TraceStep[];
  totals: {
    model_calls: number;
    tool_calls: number;
    tool_errors: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    /** null when the model has no known price (set LCA_PRICE_PER_MTOK). */
    cost_usd: number | null;
  };
}

// $ per million tokens: [input, output, cache read, cache write]. Add your model here, or set
// LCA_PRICE_PER_MTOK="input,output,cached_input" to price any model not listed.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

function priceFor(model: string): [number, number, number, number] | undefined {
  if (PRICES[model]) return PRICES[model];
  const override = process.env.LCA_PRICE_PER_MTOK?.split(",").map(Number);
  if (override?.length === 3 && override.every((n) => Number.isFinite(n))) return [override[0], override[1], override[2], override[0]];
  return undefined;
}

/** Dollar cost of one response's usage, or null for a model with no known price. */
export function usageCost(model: string, u: Usage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (u.input_tokens * p[0] + u.output_tokens * p[1] + u.cache_read_input_tokens * p[2] + u.cache_creation_input_tokens * p[3]) / 1e6;
}

export function newTrace(agent: string, provider: string, model: string, effort: string, system: string, tools: string[]): Trace {
  const started = new Date().toISOString();
  return {
    id: `${agent}-${started.replace(/[:.]/g, "-")}`,
    agent,
    provider,
    model,
    effort,
    started_at: started,
    ended_at: null,
    tools,
    system,
    steps: [],
    totals: {
      model_calls: 0,
      tool_calls: 0,
      tool_errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: priceFor(model) ? 0 : null,
    },
  };
}

export function recordStep(trace: Trace, step: TraceStep): void {
  trace.steps.push(step);
  const t = trace.totals;
  if (step.type === "model") {
    t.model_calls++;
    const u = step.usage;
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.cache_read_input_tokens += u.cache_read_input_tokens;
    t.cache_creation_input_tokens += u.cache_creation_input_tokens;
    const cost = usageCost(trace.model, u);
    if (cost !== null && t.cost_usd !== null) t.cost_usd += cost;
  } else if (step.type === "tool") {
    t.tool_calls++;
    if (step.is_error) t.tool_errors++;
  }
}

export function writeTrace(trace: Trace, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${trace.id}.json`);
  fs.writeFileSync(file, JSON.stringify(trace, null, 2));
  return file;
}

export const formatCost = (usd: number | null) => (usd === null ? "n/a (no price; set LCA_PRICE_PER_MTOK)" : `$${usd.toFixed(4)}`);

export const toolCalls = (trace: Trace) => trace.steps.filter((s): s is Extract<TraceStep, { type: "tool" }> => s.type === "tool");
