# LeetCode Practice Analyzer

Watches your LeetCode practice in the browser and keeps a practice log. An agent (Claude or OpenAI) analyzes each attempt and saves it: your approach, strengths, gaps, pass/fail, time, and category. A coach agent then tells you what to practice next. See [docs/GOALS.md](docs/GOALS.md) for the product and learning goals.

```
Chrome extension ──POST /events──▶ Ingest server ──▶ SQLite (data/leetcode.db)
                                         │ session finished
                                         ▼
                 Agent harness (hand-written loop) ◀── coach CLI
                                         │ MCP client (stdio)
                                         ▼
                 MCP server: session tools + stats/recommendation tools
                                         │
                                         ▼
                        attempts + traces/*.json ──▶ evals
```

## Terminology

- **Session**: one sitting on one problem, from opening the problem until you get Accepted, click End or Give up, or go idle for 30 minutes.
- **Judge event**: one Run or Submit result from LeetCode. A session usually has several.
- **Attempt**: the agent's analysis of a session, one row per session. This is your practice log.

## Setup

Requires Node 20+ and Chrome.

```sh
npm install
npm run seed:problems                 # one-time: loads ~4,000 problems into the catalog
npm run dev                           # ingest server on http://localhost:7777
```

API keys go in `.env` at the project root, which is loaded automatically and gitignored:

```sh
OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY=sk-ant-...
LCA_PROVIDER=openai            # optional: pick the provider when both keys are set
```

The provider follows the model name: `claude-*` models use the Anthropic Messages API, and anything else uses the OpenAI Responses API. Defaults are `claude-opus-5-5` and `gpt-5.5`. The loop in `server/src/agent/harness.ts` is the same for both; the per-provider request and response mapping lives in `server/src/agent/providers/`.

Load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension/` folder.

Then solve a problem on leetcode.com. The extension's popup shows the session timer, plus **End session** and **Give up** buttons. When you get Accepted, the server runs the analyzer and prints the result. If the server isn't running, the extension queues events and sends them later.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Ingest server; runs the analyzer when a session ends |
| `npm run coach "what should I work on this week?"` | Multi-turn coach chat over your log |
| `npm run analyze -- <session_id>` | Re-run the analyzer on a stored session |
| `npm run inspect` | Open the MCP server in the MCP Inspector |
| `npm run eval` | Run the eval suites (see below) |
| `npm run eval:capture -- <session_id>` | Turn a real session into an eval fixture |
| `npm run smoke` | End-to-end test with no Claude calls |
| `npm run typecheck` | TypeScript check |

To browse the log directly:

```sh
sqlite3 data/leetcode.db "select date, slug, status, time_taken_min, category from attempts order by date desc"
sqlite3 data/leetcode.db "select a.slug, g.tag, g.detail from attempt_gaps g join attempts a on a.id = g.attempt_id"
```

## How the code is captured

Nothing uses screenshots. `extension/page-hook.js` runs in the page's own JavaScript context and reads the full editor text from Monaco's model (`monaco.editor.getModels()`). The editor's DOM only contains the lines on screen, so reading the DOM would have the same scrolling problem screenshots do. The model always holds the whole buffer. If Monaco isn't reachable, it falls back to the visible DOM lines and marks the snapshot `partial`.

The problem description, difficulty, and tags come from LeetCode's GraphQL API. Run/Submit results come from wrapping `fetch` and reading LeetCode's `/submissions/detail/<id>/check/` responses.

## MCP tools

| Tool | Used by | Purpose |
|---|---|---|
| `get_session` | analyzer | Session facts and metrics computed in code (status, active minutes, submits) |
| `get_code_timeline` | analyzer | First and final code, diffs between them, interleaved with Run/Submit results |
| `get_problem` | both | Description, tags, category hint |
| `save_attempt` | analyzer | Writes the attempt; status, date, and time come from the data, not the model |
| `get_attempt_history` | both | Past attempts with gaps |
| `get_category_stats` | coach | Per-category pass rate, average time, staleness, last 30 days |
| `get_common_gaps` | coach | Gap tags ranked by frequency, with examples |
| `recommend_practice` | coach | Deterministic scorer: weakness × spaced-repetition staleness, plus retries and reviews |
| `search_problems` | coach | Catalog search |

Categories and gap tags are fixed lists in `server/src/taxonomy.ts`, so stats group cleanly.

The MCP server is a standalone stdio server, so you can attach it to other clients too. For example, with Claude Code: `claude mcp add leetcode -- npx tsx /path/to/server/src/mcp/server.ts`.

## Evals

```sh
npm run eval                                   # both suites, 3 trials each
npm run eval -- --suite analyze --trials 1     # quick pass
npm run eval -- --only two-sum-clean --no-judge
npm run eval -- --model claude-haiku-5-5       # compare a cheaper model
npx tsx evals/report.ts                        # re-print the latest report
```

- **analyze** (6 synthetic sessions): a clean solve, an off-by-one, a TLE brute force, giving up, a correct but suboptimal solution, and a gap repeated from an earlier attempt.
- **coach** (3 questions over a seeded log): weakest categories, a weekly plan, recurring mistakes.

Each trial runs against its own temporary database. Code graders check exact facts. An LLM judge (the default model for your provider; `LCA_JUDGE_MODEL` overrides it) grades rubric criteria with a reason for each verdict. The report shows pass rates per grader, changes since the previous run, consistency across trials, and cost. Results and traces go to `evals/results/<run>/`.

Each trial makes about 3 to 4 model calls plus one judge call, around 6,000 input tokens. Use `--trials 1` or `--only` while iterating. The report shows dollar costs only for models with a known price (see `PRICES` in `server/src/agent/trace.ts`). For others, set `LCA_PRICE_PER_MTOK="input,output,cached_input"`, e.g. from your provider's pricing page.

## Configuration

Environment variables:

| Variable | Default | |
|---|---|---|
| `LCA_PROVIDER` | from the keys present | `anthropic` or `openai`; sets the default models |
| `LCA_MODEL` | `claude-opus-5-5` / `gpt-5.5` | Model for both agents |
| `LCA_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max` |
| `LCA_JUDGE_MODEL` | same as `LCA_MODEL`'s default | Eval judge model |
| `LCA_PRICE_PER_MTOK` | unset | `input,output,cached_input` $/M tokens for models not in the price table |
| `LCA_DB` | `data/leetcode.db` | Database path |
| `LCA_TRACES` | `traces/` | Where agent traces are written |
| `LCA_IDLE_MINUTES` | `30` | Idle time before a session auto-ends |
| `PORT` | `7777` | Ingest server port. The extension's `manifest.json` and `background.js` also hard-code 7777 |

Claude requests opt into server-side refusal fallbacks (`fallbacks: "default"`), so if a safety classifier declines a request, it's retried on Anthropic's recommended fallback model. To turn this off, remove the `betas`/`fallbacks` lines in `server/src/agent/providers/anthropic.ts` and `evals/graders/judge.ts`. OpenAI requests use `store: false`, so OpenAI keeps no conversation state between calls.
