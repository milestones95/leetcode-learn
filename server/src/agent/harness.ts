// The agent harness: a hand-written loop that connects a model to an MCP server's tools.
//
//   1. Spawn the MCP server over stdio and list its tools.
//   2. Send the conversation + tool definitions to the model.
//   3. If the model asks for tools, run them through MCP and send every result back together.
//   4. Repeat until the model ends its turn, or a guardrail (turn limit, refusal, max_tokens) stops it.
//
// Provider details (Claude Messages API, OpenAI Responses API) live in ./providers; this loop is the same for both.
// Everything that happens is recorded in a Trace.
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Effort, ROOT, config, providerFor } from "../config.js";
import { type ModelConversation, type ToolDef, createConversation } from "./providers/index.js";
import { type ToolCallRecord, type Trace, newTrace, recordStep, writeTrace } from "./trace.js";

export interface AgentOptions {
  name: string;
  system: string;
  /** Subset of MCP tools this agent may see and call. Omit for all. */
  allowedTools?: string[];
  /** Max model calls per `send()`. */
  maxTurns?: number;
  model?: string;
  effort?: Effort;
  /** Extra env for the MCP server process, e.g. LCA_DB for an eval's temp database. */
  env?: Record<string, string>;
  tracesDir?: string;
  toolTimeoutMs?: number;
  onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "model"; call: number; stop_reason: string; text: string }
  | { type: "tool"; name: string; input: unknown; is_error: boolean };

export interface SendResult {
  text: string;
  stop: "end_turn" | "max_turns" | "refusal" | "max_tokens" | "other";
  stop_detail?: string;
  tool_calls: ToolCallRecord[];
}

const MCP_SERVER = path.join(ROOT, "server", "src", "mcp", "server.ts");

export class Agent {
  readonly trace: Trace;
  private serverStderr = "";

  private constructor(
    private readonly opts: AgentOptions,
    private readonly mcp: Client,
    private readonly tools: ToolDef[],
    private readonly conversation: ModelConversation,
    model: string,
    effort: Effort,
  ) {
    this.trace = newTrace(opts.name, providerFor(model), model, effort, opts.system, tools.map((t) => t.name));
  }

  static async start(opts: AgentOptions): Promise<Agent> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", MCP_SERVER],
      env: { ...(process.env as Record<string, string>), ...opts.env },
      stderr: "pipe",
    });
    const mcp = new Client({ name: "lca-harness", version: "0.1.0" });
    await mcp.connect(transport);

    // MCP tool definitions (name, description, JSON Schema) map almost 1:1 onto model tool definitions.
    const { tools: mcpTools } = await mcp.listTools();
    const tools: ToolDef[] = mcpTools
      .filter((t) => !opts.allowedTools || opts.allowedTools.includes(t.name))
      .map((t) => {
        const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
        return { name: t.name, description: t.description ?? "", input_schema: schema };
      });

    const model = opts.model ?? config.model;
    const effort = opts.effort ?? config.effort;
    const conversation = createConversation({ model, effort, system: opts.system, tools });
    const agent = new Agent(opts, mcp, tools, conversation, model, effort);
    transport.stderr?.on("data", (chunk: Buffer) => {
      agent.serverStderr = (agent.serverStderr + chunk.toString()).slice(-4000);
    });
    return agent;
  }

  /** Add a user message and run the loop until the model ends its turn. */
  async send(userText: string): Promise<SendResult> {
    const maxTurns = this.opts.maxTurns ?? 10;
    const calls: ToolCallRecord[] = [];
    this.conversation.addUser(userText);
    recordStep(this.trace, { type: "user", text: userText });

    for (let turn = 1; turn <= maxTurns; turn++) {
      const started = Date.now();
      const response = await this.conversation.next();
      recordStep(this.trace, {
        type: "model",
        call: this.trace.totals.model_calls + 1,
        latency_ms: Date.now() - started,
        stop_reason: response.raw_stop,
        usage: response.usage,
        text: response.text,
        tool_uses: response.tool_calls,
      });
      this.opts.onEvent?.({ type: "model", call: this.trace.totals.model_calls, stop_reason: response.raw_stop, text: response.text });

      switch (response.stop) {
        case "end_turn":
        case "refusal":
        case "max_tokens":
        case "other":
          return { text: response.text, stop: response.stop, stop_detail: response.stop_detail ?? response.raw_stop, tool_calls: calls };
        case "continue":
          continue;
        case "tool_use":
          break;
      }

      // Run all requested tools concurrently and return every result together.
      const results = await Promise.all(response.tool_calls.map((t) => this.runTool(t)));
      calls.push(...results);
      this.conversation.addToolResults(results);
    }
    return { text: "", stop: "max_turns", tool_calls: calls };
  }

  private async runTool(use: { id: string; name: string; input: unknown }): Promise<ToolCallRecord> {
    const started = Date.now();
    let output: string;
    let isError = false;
    if (!this.tools.some((t) => t.name === use.name)) {
      output = `Tool ${use.name} is not available to this agent.`;
      isError = true;
    } else {
      try {
        const result = await this.mcp.callTool(
          { name: use.name, arguments: use.input as Record<string, unknown> },
          undefined,
          { timeout: this.opts.toolTimeoutMs ?? 30_000 },
        );
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        output = content.map((c) => (c.type === "text" ? c.text : `[${c.type} content]`)).join("\n");
        isError = Boolean(result.isError);
      } catch (err) {
        // Transport failures and timeouts go back to the model as tool errors rather than crashing the run.
        output = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
    }
    const record: ToolCallRecord = { id: use.id, name: use.name, input: use.input, output, is_error: isError, latency_ms: Date.now() - started };
    recordStep(this.trace, { type: "tool", ...record });
    this.opts.onEvent?.({ type: "tool", name: use.name, input: use.input, is_error: isError });
    return record;
  }

  recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    recordStep(this.trace, { type: "error", message: this.serverStderr ? `${message}\nMCP stderr:\n${this.serverStderr}` : message });
  }

  /** Close the MCP connection and write the trace. Returns the trace file path. */
  async close(): Promise<string> {
    this.trace.ended_at = new Date().toISOString();
    await this.mcp.close().catch(() => {});
    return writeTrace(this.trace, this.opts.tracesDir ?? config.tracesDir);
  }
}
