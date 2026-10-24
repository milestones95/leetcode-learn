// MCP server exposing the practice database as tools. The agent harness spawns this over stdio;
// you can also attach it to any MCP client (`npm run inspect`, Claude Desktop, Claude Code).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../db.js";
import { registerCoachingTools } from "./tools/coaching.js";
import { registerSessionTools } from "./tools/session.js";

const db = openDb();
const server = new McpServer({ name: "leetcode-practice", version: "0.1.0" });
registerSessionTools(server, db);
registerCoachingTools(server, db);

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so diagnostics go to stderr.
console.error(`leetcode-practice MCP server ready (db: ${db.name})`);
