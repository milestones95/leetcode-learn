// Tools the analyzer uses to read one session and write its attempt.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type DB,
  type JudgeEventRow,
  type SnapshotRow,
  getAttemptBySession,
  getProblem,
  getSession,
  insertAttempt,
  listJudgeEvents,
  listSnapshots,
} from "../../db.js";
import { lineDiff } from "../../diff.js";
import { computeMetrics } from "../../sessions.js";
import { CATEGORIES, GAP_TAGS, GAP_TAG_LIST } from "../../taxonomy.js";
import { fail, ok } from "../result.js";

const minuteOffset = (start: string, ts: string) => Math.round(((Date.parse(ts) - Date.parse(start)) / 60_000) * 10) / 10;

export function registerSessionTools(server: McpServer, db: DB) {
  server.registerTool(
    "get_session",
    {
      description:
        "Get a practice session's facts: problem slug, start/end, why it ended, every Run/Submit judge result, and " +
        "metrics computed from the data (status, active_minutes, submit counts). Treat these metrics as ground truth.",
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id }) => {
      const session = getSession(db, session_id);
      if (!session) return fail(`No session with id ${session_id}`);
      const snapshots = listSnapshots(db, session_id);
      const judge = listJudgeEvents(db, session_id);
      const problem = getProblem(db, session.slug);
      return ok({
        session_id,
        slug: session.slug,
        title: problem?.title ?? session.slug,
        difficulty: problem?.difficulty ?? null,
        started_at: session.started_at,
        ended_at: session.ended_at,
        end_reason: session.end_reason,
        metrics: computeMetrics(session, snapshots, judge),
        judge_events: judge.map((j) => ({
          minute: minuteOffset(session.started_at, j.ts),
          kind: j.kind,
          status: j.status,
          tests: j.tests_total != null ? `${j.tests_passed}/${j.tests_total}` : null,
          runtime: j.runtime,
          error_detail: j.error_detail,
        })),
      });
    },
  );

  server.registerTool(
    "get_code_timeline",
    {
      description:
        "Get how the user's code evolved during a session: the first snapshot in full, then line diffs of selected " +
        "snapshots, interleaved with Run/Submit results, then the final code in full. Minutes are from session start. " +
        "Snapshots at each Run/Submit are always included.",
      inputSchema: {
        session_id: z.string(),
        max_snapshots: z.number().int().min(2).max(40).default(12).describe("Upper bound on snapshots shown"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, max_snapshots }) => {
      const session = getSession(db, session_id);
      if (!session) return fail(`No session with id ${session_id}`);
      const snapshots = listSnapshots(db, session_id);
      const judge = listJudgeEvents(db, session_id);
      if (snapshots.length === 0) return ok("No code snapshots were captured for this session.");
      return ok(renderTimeline(session.started_at, snapshots, judge, max_snapshots));
    },
  );

  server.registerTool(
    "get_problem",
    {
      description: "Get a LeetCode problem's title, difficulty, topic tags, category hint, and description.",
      inputSchema: { slug: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const p = getProblem(db, slug);
      if (!p) return fail(`Problem ${slug} is not in the catalog`);
      return ok({
        slug: p.slug,
        title: p.title,
        difficulty: p.difficulty,
        tags: JSON.parse(p.tags),
        category_hint: p.category,
        description: p.description ?? "(description not captured yet)",
      });
    },
  );

  const gapTagHelp = Object.entries(GAP_TAGS)
    .map(([tag, meaning]) => `${tag}: ${meaning}`)
    .join("\n");

  server.registerTool(
    "save_attempt",
    {
      description:
        "Save the analysis of a session to the practice log. Call exactly once per session, after reading the session " +
        "and its code timeline. Status, date, and time taken are filled in from the session data automatically.\n\n" +
        `Gap tags:\n${gapTagHelp}`,
      inputSchema: {
        session_id: z.string(),
        category: z.enum(CATEGORIES).describe("The problem's primary category: the technique the intended solution uses"),
        approach_pattern: z.string().describe("Short name of the technique the user actually used, e.g. 'hash map, one pass'"),
        approach_summary: z.string().describe("2-4 sentences on how the user's approach evolved, grounded in the timeline"),
        strengths: z.array(z.string()).max(5).describe("Specific things done well; empty if none stand out"),
        gaps: z
          .array(z.object({ tag: z.enum(GAP_TAG_LIST), detail: z.string().describe("What specifically happened and what to do differently") }))
          .max(6),
        optimal_approach: z.string().describe("The best-known approach in 1-2 sentences, with its complexity"),
        time_complexity: z.string().describe("Time complexity of the user's final code, e.g. O(n log n)"),
        space_complexity: z.string().describe("Space complexity of the user's final code"),
        confidence: z.number().min(0).max(1).describe("How confident you are in this analysis given the captured data"),
      },
    },
    async (input) => {
      const session = getSession(db, input.session_id);
      if (!session) return fail(`No session with id ${input.session_id}`);
      if (getAttemptBySession(db, input.session_id)) {
        return fail(`An attempt for session ${input.session_id} is already saved; save_attempt runs once per session.`);
      }
      const m = computeMetrics(session, listSnapshots(db, session.id), listJudgeEvents(db, session.id));
      const id = insertAttempt(
        db,
        {
          session_id: session.id,
          slug: session.slug,
          date: m.date,
          status: m.status,
          time_taken_min: m.active_minutes,
          category: input.category,
          approach_pattern: input.approach_pattern,
          approach_summary: input.approach_summary,
          strengths: input.strengths,
          optimal_approach: input.optimal_approach,
          time_complexity: input.time_complexity,
          space_complexity: input.space_complexity,
          confidence: input.confidence,
          source: "extension",
        },
        input.gaps,
      );
      return ok({ saved: true, attempt_id: id, slug: session.slug, date: m.date, status: m.status, time_taken_min: m.active_minutes });
    },
  );
}

export function renderTimeline(start: string, snapshots: SnapshotRow[], judge: JudgeEventRow[], max: number): string {
  // Always keep the first and last snapshot plus the latest snapshot at or before each judge event.
  const chosen = new Set<number>([0, snapshots.length - 1]);
  for (const j of judge) {
    let idx = -1;
    snapshots.forEach((s, i) => {
      if (s.ts <= j.ts) idx = i;
    });
    if (idx >= 0) chosen.add(idx);
  }
  // Fill the remaining budget with evenly spaced snapshots.
  const budget = Math.max(max - chosen.size, 0);
  for (let k = 1; k <= budget && chosen.size < snapshots.length; k++) {
    chosen.add(Math.round((k * (snapshots.length - 1)) / (budget + 1)));
  }
  const picked = [...chosen].sort((a, b) => a - b).map((i) => snapshots[i]);

  type Item = { ts: string; order: number; text: string };
  const items: Item[] = [];
  picked.forEach((s, i) => {
    const at = `[${minuteOffset(start, s.ts)} min]`;
    let text: string;
    if (i === 0) text = `${at} First snapshot:\n\`\`\`\n${s.code}\n\`\`\``;
    else if (i === picked.length - 1) text = `${at} Final code:\n\`\`\`\n${s.code}\n\`\`\``;
    else text = `${at} Edit (diff from previous shown snapshot):\n${lineDiff(picked[i - 1].code, s.code)}`;
    items.push({ ts: s.ts, order: 0, text });
  });
  for (const j of judge) {
    const tests = j.tests_total != null ? ` (${j.tests_passed}/${j.tests_total} tests)` : "";
    const detail = j.error_detail ? `\n    ${j.error_detail.replace(/\n/g, "\n    ")}` : "";
    items.push({ ts: j.ts, order: 1, text: `[${minuteOffset(start, j.ts)} min] ${j.kind.toUpperCase()} → ${j.status}${tests}${detail}` });
  }
  items.sort((a, b) => a.ts.localeCompare(b.ts) || a.order - b.order);

  const lang = snapshots.at(-1)?.language ?? "unknown";
  const partial = snapshots.some((s) => s.partial) ? " Some snapshots were read from the visible editor only and may be missing lines." : "";
  const header = `Language: ${lang}. ${snapshots.length} snapshots captured; showing ${picked.length}.${partial}`;
  return [header, ...items.map((i) => i.text)].join("\n\n");
}
