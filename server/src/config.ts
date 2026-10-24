import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// API keys can live in .env at the project root. Variables already set in the shell win.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "anthropic" | "openai";

/** The provider is implied by the model name, so `--model claude-…` or `--model gpt-…` just works. */
export function providerFor(model: string): Provider {
  return model.startsWith("claude") ? "anthropic" : "openai";
}

const DEFAULT_MODELS: Record<Provider, string> = { anthropic: "claude-opus-5-5", openai: "gpt-5.5" };
// Default provider: LCA_PROVIDER if set, otherwise whichever API key is present (Anthropic first).
const provider: Provider =
  (process.env.LCA_PROVIDER as Provider | undefined) ??
  (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "anthropic");

export const config = {
  port: Number(process.env.PORT ?? 7777),
  // Every process (ingest server, MCP server, evals) resolves the DB from LCA_DB so evals can point at a temp copy.
  dbPath: process.env.LCA_DB ?? path.join(ROOT, "data", "leetcode.db"),
  tracesDir: process.env.LCA_TRACES ?? path.join(ROOT, "traces"),
  model: process.env.LCA_MODEL ?? DEFAULT_MODELS[provider],
  effort: (process.env.LCA_EFFORT ?? "medium") as Effort,
  judgeModel: process.env.LCA_JUDGE_MODEL ?? DEFAULT_MODELS[provider],
  idleMinutes: Number(process.env.LCA_IDLE_MINUTES ?? 30),
  // Gaps longer than this between activity events don't count toward active time.
  activityGapCapMinutes: 5,
};

/** "Today" as YYYY-MM-DD. LCA_TODAY pins it so recommendation evals are deterministic. */
export function today(): string {
  return process.env.LCA_TODAY ?? localDate(new Date());
}

export function localDate(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}
