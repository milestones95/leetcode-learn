import { providerFor } from "../../config.js";
import { AnthropicConversation } from "./anthropic.js";
import { OpenAIConversation } from "./openai.js";
import type { ConversationOptions, ModelConversation } from "./types.js";

export function createConversation(opts: ConversationOptions): ModelConversation {
  return providerFor(opts.model) === "anthropic" ? new AnthropicConversation(opts) : new OpenAIConversation(opts);
}

export type * from "./types.js";
