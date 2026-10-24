// Facts about a session that code can compute exactly. The agent reads these; it never estimates them.
import { config, localDate } from "./config.js";
import type { JudgeEventRow, SessionRow, SnapshotRow } from "./db.js";
import type { AttemptStatus } from "./taxonomy.js";

export interface SessionMetrics {
  status: AttemptStatus;
  date: string;
  /** Minutes of activity, with gaps over `activityGapCapMinutes` clipped (stepping away doesn't count). */
  active_minutes: number;
  /** Wall-clock minutes from start to first Accepted submit (or to last activity). */
  wall_minutes: number;
  run_count: number;
  submit_count: number;
  failed_submit_count: number;
  first_accepted_at: string | null;
  snapshot_count: number;
}

const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeMetrics(session: SessionRow, snapshots: SnapshotRow[], judge: JudgeEventRow[]): SessionMetrics {
  const submits = judge.filter((j) => j.kind === "submit");
  const accepted = submits.find((j) => j.status === "Accepted");
  const status: AttemptStatus = accepted ? "passed" : session.end_reason === "gave_up" ? "gave_up" : "failed";

  // Time stops at the first Accepted submit; activity after that (e.g. tidying up) isn't solve time.
  const end = accepted?.ts ?? lastActivity(session, snapshots, judge);
  const activity = [session.started_at, ...snapshots.map((s) => s.ts), ...judge.map((j) => j.ts)]
    .filter((ts) => ts <= end)
    .sort();
  let active = 0;
  for (let i = 1; i < activity.length; i++) {
    active += Math.min(minutesBetween(activity[i - 1], activity[i]), config.activityGapCapMinutes);
  }

  return {
    status,
    date: localDate(new Date(session.started_at)),
    active_minutes: round1(active),
    wall_minutes: round1(minutesBetween(session.started_at, end)),
    run_count: judge.filter((j) => j.kind === "run").length,
    submit_count: submits.length,
    failed_submit_count: submits.filter((j) => j.status !== "Accepted").length,
    first_accepted_at: accepted?.ts ?? null,
    snapshot_count: snapshots.length,
  };
}

function lastActivity(session: SessionRow, snapshots: SnapshotRow[], judge: JudgeEventRow[]): string {
  return [session.started_at, ...snapshots.map((s) => s.ts), ...judge.map((j) => j.ts)].sort().at(-1)!;
}

/** Sessions that are just page views (no runs, barely any typing) aren't worth an analysis. */
export function shouldSkipAnalysis(session: SessionRow, snapshots: SnapshotRow[], judge: JudgeEventRow[]): string | null {
  if (snapshots.length === 0 && judge.length === 0) return "no code captured";
  if (judge.length === 0 && session.end_reason === "idle") {
    const m = computeMetrics(session, snapshots, judge);
    if (m.active_minutes < 3) return "idle with under 3 active minutes and no runs";
  }
  return null;
}
