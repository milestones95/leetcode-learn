// OpenAI via the Responses API. (Chat Completions rejects function tools combined with reasoning on gpt-5.5.)
import OpenAI from "openai";
import type { ConversationOptions, ModelConversation, ModelTurn, ToolResultInput } from "./types.js";

type InputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;

export class OpenAIConversation implements ModelConversation {
  private readonly client = new OpenAI({ maxRetries: 4 });
  private readonly input: InputItem[] = [];
  private readonly tools: FunctionTool[];

  constructor(private readonly opts: ConversationOptions) {
    this.tools = opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
  }

  addUser(text: string) {
    this.input.push({ role: "user", content: text });
  }

  addToolResults(results: ToolResultInput[]) {
    // The Responses API has no is_error flag, so errors are marked in the output text.
    for (const r of results) {
      this.input.push({ type: "function_call_output", call_id: r.id, output: r.is_error ? `ERROR: ${r.output}` : r.output });
    }
  }

  async next(): Promise<ModelTurn> {
    const response = await this.client.responses.create({
      model: this.opts.model,
      instructions: this.opts.system,
      input: this.input,
      tools: this.tools,
      reasoning: { effort: this.opts.effort },
      max_output_tokens: 16000,
      // Keep no state on OpenAI's side; we resend the history, and encrypted reasoning carries over between calls.
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    // Output items (reasoning, messages, function calls) are valid input items for the next call.
    this.input.push(...(response.output as InputItem[]));

    const toolCalls = response.output
      .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call")
      .map((o) => ({ id: o.call_id, name: o.name, input: parseArgs(o.arguments) }));
    const refusal = response.output
      .flatMap((o) => (o.type === "message" ? o.content : []))
      .find((c): c is OpenAI.Responses.ResponseOutputRefusal => c.type === "refusal");

    const incomplete = response.status === "incomplete" ? (response.incomplete_details?.reason ?? "incomplete") : undefined;
    const stop: ModelTurn["stop"] = refusal
      ? "refusal"
      : incomplete === "max_output_tokens"
        ? "max_tokens"
        : incomplete === "content_filter"
          ? "refusal"
          : toolCalls.length
            ? "tool_use"
            : response.status === "completed"
              ? "end_turn"
              : "other";

    const u = response.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    return {
      text: refusal ? refusal.refusal : response.output_text,
      tool_calls: toolCalls,
      stop,
      raw_stop: incomplete ?? (toolCalls.length ? "function_call" : (response.status ?? "unknown")),
      usage: {
        input_tokens: (u?.input_tokens ?? 0) - cached,
        output_tokens: u?.output_tokens ?? 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      },
    };
  }
}

/** Arguments arrive as a JSON string. Bad JSON becomes {} so the MCP server's validation reports the problem to the model. */
function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
