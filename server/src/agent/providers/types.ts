// The harness talks to models through this interface, so the loop in harness.ts doesn't change per provider.
// Each adapter owns its own conversation history, since providers shape messages and tool results differently.
import type { Effort } from "../../config.js";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input (from MCP's listTools). */
  input_schema: Record<string, unknown>;
}

export interface ToolResultInput {
  id: string;
  output: string;
  is_error: boolean;
}

/** Token usage normalized across providers; input_tokens excludes cached tokens. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ModelTurn {
  text: string;
  tool_calls: Array<{ id: string; name: string; input: unknown }>;
  /** `continue` means call next() again without adding anything (e.g. Anthropic's pause_turn). */
  stop: "end_turn" | "tool_use" | "refusal" | "max_tokens" | "continue" | "other";
  /** The provider's raw stop reason, for traces. */
  raw_stop: string;
  stop_detail?: string;
  usage: Usage;
}

export interface ConversationOptions {
  model: string;
  effort: Effort;
  system: string;
  tools: ToolDef[];
}

export interface ModelConversation {
  addUser(text: string): void;
  addToolResults(results: ToolResultInput[]): void;
  next(): Promise<ModelTurn>;
}
