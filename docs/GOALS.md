# Goals

## Product goal

Practice LeetCode in the browser as usual. In the background, the tool:

1. Reads the problem and streams snapshots of your code as you write it.
2. When you finish, has an agent analyze the attempt: the approach you took, what went well, where the gaps were.
3. Saves the attempt to your practice log with the problem, category, difficulty, pass/fail, time taken, and date.
4. Coaches you over that log. It tells you which categories are weak, which mistakes keep coming up, and which problems are due for a repeat, so every category gets regular practice.

## Learning goals

### 1. Build an agent harness that uses MCP tools and runs somewhat on its own

The agent loop is written by hand on purpose. A framework or the SDK's Tool Runner would hide the parts worth learning.

| Concept | Where it lives |
|---|---|
| The loop itself: call the model, run requested tools, send results back, repeat until `end_turn` | `server/src/agent/harness.ts` → `Agent.send()` |
| MCP client: spawn a server over stdio, list its tools, call them | `Agent.start()`, `Agent.runTool()` |
| MCP server: expose capabilities as typed tools | `server/src/mcp/server.ts`, `server/src/mcp/tools/*.ts` |
| Turning MCP tool schemas into model tool definitions | `Agent.start()` (the `listTools()` mapping) |
| One loop, two providers: the same harness on Claude (Messages API) and OpenAI (Responses API) | `server/src/agent/providers/` |
| Tool errors the model can recover from (`isError` → `is_error`) | `mcp/result.ts` `fail()`, the `save_attempt` duplicate check |
| Guardrails: turn limit, tool timeouts, refusal and `max_tokens` handling, an allow-list per agent | `AgentOptions`, the `switch` in `send()` |
| Autonomy: an agent triggered by an event, with no human in the loop | `server/src/ingest.ts` → `Ingest.finish()` → `drain()` |
| One harness, two agents with different tools and prompts | `agent/analyze-session.ts`, `agent/coach.ts`, `agent/prompts.ts` |
| Observability: a trace of every call, tool, token, and dollar | `server/src/agent/trace.ts`, `traces/*.json` |
| Keeping the model out of jobs code does better (status, time, scoring) | `server/src/sessions.ts`, `server/src/mcp/scoring.ts` |

**I'll know I've learned this when I can:**
- [ ] Explain each step of `Agent.send()` and why tool results go back in a single user message.
- [ ] Add a new MCP tool, see it in `npm run inspect`, and watch the agent use it in a trace.
- [ ] Attach the same MCP server to a different client (Claude Desktop or Claude Code) without changing it.
- [ ] Read a trace and explain why the agent made each tool call.
- [ ] Break something on purpose (a tool that throws, a bad schema) and watch the harness recover.
- [ ] Explain why `save_attempt` computes status and time itself instead of trusting the model.

### 2. Build evals that measure how accurate and reliable the LLM's output is

| Concept | Where it lives |
|---|---|
| Fixtures: a known input plus a labeled expected output | `evals/suites/analyze/*.json`, `evals/suites/coach/*.json` |
| Isolation: each trial gets its own throwaway database | `evals/fixtures.ts` loaders, `evals/run.ts` |
| Code graders: exact, cheap checks (schema, enums, required gap tags, tool usage) | `evals/graders/code.ts` |
| LLM-as-judge: rubric criteria code can't check (found the real gap, grounded, actionable) | `evals/graders/judge.ts` |
| Reliability: does the agent give the same answer on repeated runs? | `evals/graders/consistency.ts` |
| Regression tracking: compare each run with the previous one | `evals/report.ts` |
| Growing the dataset from real use | `evals/capture.ts` (`npm run eval:capture`) |

**I'll know I've learned this when I can:**
- [ ] Explain when a check belongs in a code grader and when it needs the judge.
- [ ] Change a prompt, rerun the evals, and say from the report whether it helped.
- [ ] Compare two models or effort levels (`--model`, `--effort`) on quality and cost.
- [ ] Find a judge verdict I disagree with and fix the rubric wording.
- [ ] Capture one of my own sessions as a fixture, label it, and add it to the suite.
- [ ] Explain the difference between accuracy (pass rate) and reliability (consistency across trials).

## Out of scope for now

- Importing past attempts from a CSV. The schema's `source` column already leaves room for it.
- A dashboard UI. The coach CLI and SQL cover browsing for now.
