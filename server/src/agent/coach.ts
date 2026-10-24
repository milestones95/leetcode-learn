// The coach agent: a multi-turn terminal chat over your practice log.
//   npm run coach "what should I work on this week?"   (one question, then keeps chatting)
//   npm run coach                                       (interactive)
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { Agent, type AgentOptions } from "./harness.js";
import { COACH_SYSTEM, COACH_TOOLS } from "./prompts.js";
import { formatCost } from "./trace.js";

export function startCoach(opts: Partial<AgentOptions> = {}) {
  return Agent.start({ name: "coach", system: COACH_SYSTEM, allowedTools: COACH_TOOLS, maxTurns: 10, ...opts });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agent = await startCoach({
    onEvent: (e) => {
      if (e.type === "tool") console.log(`  · ${e.name}${e.is_error ? " (error)" : ""}`);
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`LeetCode coach (${config.model}, effort ${config.effort}). Empty line or Ctrl+C to exit.\n`);
  let question = process.argv.slice(2).join(" ").trim();
  try {
    while (true) {
      if (!question) question = (await rl.question("you › ")).trim();
      if (!question) break;
      const r = await agent.send(question);
      console.log(`\ncoach › ${r.text}${r.stop !== "end_turn" ? `\n(stopped: ${r.stop})` : ""}\n`);
      question = "";
    }
  } catch (err) {
    agent.recordError(err);
    console.error(err);
  } finally {
    rl.close();
    const tracePath = await agent.close();
    console.log(`cost: ${formatCost(agent.trace.totals.cost_usd)} · trace: ${tracePath}`);
  }
}
