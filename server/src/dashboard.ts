// Data and page for the practice dashboard the extension popup opens at http://localhost:<port>/dashboard.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { type DB, type GapInput, gapsForAttempts } from "./db.js";

interface DashboardAttempt {
  id: number;
  session_id: string | null;
  slug: string;
  title: string;
  difficulty: string | null;
  date: string;
  status: string;
  time_taken_min: number | null;
  category: string;
  approach_pattern: string | null;
  approach_summary: string | null;
  verdict_reason: string | null;
  strengths: string[];
  optimal_approach: string | null;
  time_complexity: string | null;
  space_complexity: string | null;
  confidence: number | null;
  gaps: GapInput[];
}

export function dashboardData(db: DB) {
  const rows = db
    .prepare(
      `SELECT a.*, p.title, p.difficulty FROM attempts a LEFT JOIN problems p ON p.slug = a.slug ORDER BY a.date DESC, a.id DESC`,
    )
    .all() as Array<Record<string, unknown> & { id: number; slug: string; title: string | null; strengths: string }>;
  const gaps = gapsForAttempts(db, rows.map((r) => r.id));
  const attempts: DashboardAttempt[] = rows.map((r) => ({
    ...(r as unknown as DashboardAttempt),
    title: r.title ?? r.slug,
    strengths: JSON.parse(r.strengths),
    gaps: gaps.get(r.id) ?? [],
  }));
  // Sessions that ended but have no attempt yet, so the page can say results are still coming.
  const { n: pending } = db
    .prepare(`SELECT COUNT(*) n FROM sessions WHERE ended_at IS NOT NULL AND analysis_status IN ('pending', 'running')`)
    .get() as { n: number };
  return { attempts, pending_analysis: pending };
}

const pagePath = path.join(ROOT, "server", "src", "dashboard.html");
/** Read on each request so edits to the page show up without restarting the server. */
export const dashboardHtml = () => fs.readFileSync(pagePath, "utf8");
