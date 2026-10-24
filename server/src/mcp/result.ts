import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

/** A domain error the model should read and react to (e.g. bad session id). */
export const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});
