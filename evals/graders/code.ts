// Deterministic graders: cheap, exact, and run on every trial. Prefer these whenever a check can be written in code.
import type { AttemptRow, GapInput } from "../../server/src/db.js";
import { type Trace, toolCalls } from "../../server/src/agent/trace.js";
import type { AnalyzeFixture, CoachFixture } from "../fixtures.js";
import { type GradeResult, grade } from "./types.js";

export interface AnalyzeOutput {
  attempts: AttemptRow[];
  gaps: GapInput[];
  summary: string;
  stop: string;
  trace: Trace;
}

export function gradeAnalyze(f: AnalyzeFixture, out: AnalyzeOutput): GradeResult[] {
  const e = f.expected;
  const a = out.attempts[0];
  const calls = toolCalls(out.trace);
  const saves = calls.filter((c) => c.name === "save_attempt" && !c.is_error);
  const results: GradeResult[] = [
    grade("saved_exactly_once", out.attempts.length === 1 && saves.length === 1, `${out.attempts.length} rows, ${saves.length} successful save_attempt calls`),
    grade("finished_cleanly", out.stop === "end_turn" && out.trace.totals.model_calls <= 8, `stop=${out.stop}, model_calls=${out.trace.totals.model_calls}`),
  ];
  const firstSave = calls.findIndex((c) => c.name === "save_attempt");
  const readBefore = (name: string) => calls.findIndex((c) => c.name === name) > -1 && calls.findIndex((c) => c.name === name) < firstSave;
  results.push(grade("read_before_write", firstSave > -1 && readBefore("get_session") && readBefore("get_code_timeline")));
  if (!a) return results;

  const text = `${a.approach_pattern ?? ""} ${a.approach_summary ?? ""}`.toLowerCase();
  const savedTags = new Set(out.gaps.map((g) => g.tag));
  results.push(
    grade("status_matches", a.status === e.status, `got ${a.status}, expected ${e.status}`),
    grade("category_matches", e.category.includes(a.category), `got ${a.category}, expected one of ${e.category.join(" | ")}`),
    grade("pattern_named", e.pattern_keywords.some((k) => text.includes(k.toLowerCase())), `approach_pattern="${a.approach_pattern}"`),
  );
  e.required_gaps.forEach((g, i) => {
    results.push(grade(`required_gap_${i}_tagged`, g.tags.some((t) => savedTags.has(t)), `need one of [${g.tags.join(", ")}], saved [${[...savedTags].join(", ")}]`));
  });
  if (e.max_gaps != null) results.push(grade("gap_count_within_budget", out.gaps.length <= e.max_gaps, `${out.gaps.length} gaps, max ${e.max_gaps}`));
  if (e.time_complexity_includes) {
    results.push(
      grade("time_complexity", (a.time_complexity ?? "").toLowerCase().includes(e.time_complexity_includes), `time_complexity="${a.time_complexity}"`),
    );
  }
  if (e.mentions_repeat) {
    const repeat = /\b(again|previous(ly)?|earlier|last time|before|repeat(ed|s)?|same (mistake|gap|bug)|recurring|09-02)\b/i;
    const where = [...out.gaps.map((g) => g.detail), a.approach_summary ?? "", out.summary];
    results.push(grade("repeat_gap_called_out", where.some((t) => repeat.test(t))));
  }
  return results;
}

export interface CoachOutput {
  answer: string;
  stop: string;
  trace: Trace;
}

export function gradeCoach(f: CoachFixture, out: CoachOutput): GradeResult[] {
  const e = f.expected;
  const calls = toolCalls(out.trace);
  const answer = out.answer.toLowerCase();
  const results: GradeResult[] = [grade("finished_cleanly", out.stop === "end_turn", `stop=${out.stop}`)];

  for (const tool of e.must_call_tools) results.push(grade(`called_${tool}`, calls.some((c) => c.name === tool && !c.is_error)));
  e.must_mention.forEach((synonyms, i) => {
    results.push(grade(`mentions_${i}`, synonyms.some((s) => answer.includes(s.toLowerCase())), `one of: ${synonyms.join(" | ")}`));
  });

  const mentioned = mentionedProblems(f, out.answer);
  if (e.must_recommend_any) {
    const hit = mentioned.filter((p) => e.must_recommend_any!.includes(p.slug));
    results.push(grade("recommends_expected_retry", hit.length > 0, `mentioned: ${mentioned.map((p) => p.slug).join(", ") || "none"}`));
  }
  // Any catalog problem named in the answer must have come back from a tool in this run.
  const toolText = calls.map((c) => c.output).join("\n").toLowerCase();
  const ungrounded = mentioned.filter((p) => !toolText.includes(p.slug) && !toolText.includes(p.title.toLowerCase()));
  results.push(grade("problems_grounded_in_tools", ungrounded.length === 0, ungrounded.length ? `not in tool output: ${ungrounded.map((p) => p.slug).join(", ")}` : undefined));
  return results;
}

/** Catalog problems the answer names, by title or slug. */
export function mentionedProblems(f: CoachFixture, answer: string) {
  const lower = answer.toLowerCase();
  return f.problems.filter((p) => lower.includes(p.title.toLowerCase()) || lower.includes(p.slug));
}
