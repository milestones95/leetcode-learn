// LLM-as-judge for what code can't check: did the analysis find the real gap, is every claim grounded,
// is the advice specific. Each criterion is a separate pass/fail with a reason, so failures are debuggable.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z } from "zod";
import type { Usage } from "../../server/src/agent/providers/types.js";
import { usageCost } from "../../server/src/agent/trace.js";
import { config, providerFor } from "../../server/src/config.js";
import { type GradeResult, grade } from "./types.js";

export interface Criterion {
  id: string;
  text: string;
}

const Verdicts = z.object({
  verdicts: z.array(z.object({ id: z.string(), reason: z.string(), pass: z.boolean() })),
});
type Verdicts = z.infer<typeof Verdicts>;

// The same shape as JSON Schema, for OpenAI's strict structured outputs.
const VERDICTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason", "pass"],
        properties: { id: { type: "string" }, reason: { type: "string" }, pass: { type: "boolean" } },
      },
    },
  },
};

const SYSTEM = `You grade the output of an AI system against a rubric. You are given the evidence (the data the system had) and the system's output.

For each criterion, decide pass or fail using only the evidence provided. Be strict: if the output's claim isn't supported by the evidence, it fails. Give a one or two sentence reason that points to the specific text, and decide the verdict after the reason. Return one verdict for every criterion id, in order.`;

interface JudgeCall {
  verdicts: Verdicts | null;
  usage: Usage;
  stop: string;
}

async function callAnthropic(prompt: string): Promise<JudgeCall> {
  const client = new Anthropic({ maxRetries: 4 });
  const response = await client.beta.messages.parse({
    model: config.judgeModel,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(Verdicts) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: prompt }],
  });
  const u = response.usage;
  return {
    verdicts: response.stop_reason === "refusal" ? null : response.parsed_output,
    stop: response.stop_reason ?? "null",
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

async function callOpenAI(prompt: string): Promise<JudgeCall> {
  const client = new OpenAI({ maxRetries: 4 });
  const response = await client.responses.create({
    model: config.judgeModel,
    instructions: SYSTEM,
    input: prompt,
    reasoning: { effort: "medium" },
    max_output_tokens: 8000,
    store: false,
    text: { format: { type: "json_schema", name: "verdicts", schema: VERDICTS_SCHEMA, strict: true } },
  });
  const parsed = response.status === "completed" ? Verdicts.safeParse(safeJson(response.output_text)) : undefined;
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    verdicts: parsed?.success ? parsed.data : null,
    stop: response.status ?? "unknown",
    usage: {
      input_tokens: (response.usage?.input_tokens ?? 0) - cached,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export async function judge(criteria: Criterion[], evidence: string, output: string): Promise<{ results: GradeResult[]; costUsd: number | null }> {
  const prompt =
    `<evidence>\n${evidence}\n</evidence>\n\n<output>\n${output}\n</output>\n\n<criteria>\n` +
    criteria.map((c) => `${c.id}: ${c.text}`).join("\n") +
    `\n</criteria>`;
  const call = providerFor(config.judgeModel) === "anthropic" ? await callAnthropic(prompt) : await callOpenAI(prompt);
  const costUsd = usageCost(config.judgeModel, call.usage);

  if (!call.verdicts) {
    return { results: criteria.map((c) => grade(`judge:${c.id}`, false, `judge produced no verdict (stop: ${call.stop})`)), costUsd };
  }
  const byId = new Map(call.verdicts.verdicts.map((v) => [v.id, v]));
  return {
    results: criteria.map((c) => {
      const v = byId.get(c.id);
      return v ? grade(`judge:${c.id}`, v.pass, v.reason) : grade(`judge:${c.id}`, false, "judge omitted this criterion");
    }),
    costUsd,
  };
}
