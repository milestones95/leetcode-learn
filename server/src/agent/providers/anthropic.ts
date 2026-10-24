// Claude via the Messages API.
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationOptions, ModelConversation, ModelTurn, ToolResultInput } from "./types.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Tool = Anthropic.Beta.Messages.BetaTool;

export class AnthropicConversation implements ModelConversation {
  private readonly client = new Anthropic({ maxRetries: 4 });
  private readonly messages: MessageParam[] = [];
  private readonly tools: Tool[];

  constructor(private readonly opts: ConversationOptions) {
    this.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Tool["input_schema"] }));
  }

  addUser(text: string) {
    this.messages.push({ role: "user", content: text });
  }

  addToolResults(results: ToolResultInput[]) {
    // Every result goes back in one user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.output, is_error: r.is_error })),
    });
  }

  async next(): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: 16000,
      system: this.opts.system,
      tools: this.tools,
      messages: this.messages,
      thinking: { type: "adaptive" },
      output_config: { effort: this.opts.effort },
      // Caches the growing conversation prefix, so each loop iteration only pays full price for new tokens.
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    // Keep the full content (thinking blocks included) so the conversation stays valid on the next call.
    this.messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const raw = response.stop_reason ?? "null";
    const stop: ModelTurn["stop"] =
      raw === "end_turn" || raw === "stop_sequence"
        ? "end_turn"
        : raw === "tool_use"
          ? "tool_use"
          : raw === "refusal"
            ? "refusal"
            : raw === "max_tokens"
              ? "max_tokens"
              : raw === "pause_turn"
                ? "continue"
                : "other";
    const u = response.usage;
    return {
      text,
      tool_calls: toolCalls,
      stop,
      raw_stop: raw,
      stop_detail: response.stop_details?.category ?? undefined,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
