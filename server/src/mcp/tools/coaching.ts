// Read-only tools the coach uses to answer "what should I work on?" questions.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { today } from "../../config.js";
import { type AttemptRow, type DB, gapsForAttempts } from "../../db.js";
import { CATEGORIES, type Category, type GapTag } from "../../taxonomy.js";
import { ok } from "../result.js";
import { type ScoredAttempt, categoryStates, daysBetween, recommend } from "../scoring.js";

type AttemptWithTitle = AttemptRow & { title: string | null; difficulty: string | null };

function loadAttempts(db: DB, f: { since?: string; slug?: string; category?: string } = {}): AttemptWithTitle[] {
  const where: string[] = [];
  const args: string[] = [];
  if (f.since) (where.push("a.date >= ?"), args.push(f.since));
  if (f.slug) (where.push("a.slug = ?"), args.push(f.slug));
  if (f.category) (where.push("a.category = ?"), args.push(f.category));
  return db
    .prepare(
      `SELECT a.*, p.title, p.difficulty FROM attempts a LEFT JOIN problems p ON p.slug = a.slug
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.date, a.id`,
    )
    .all(...args) as AttemptWithTitle[];
}

function toScored(db: DB, rows: AttemptWithTitle[]): ScoredAttempt[] {
  const gaps = gapsForAttempts(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title ?? r.slug,
    difficulty: r.difficulty,
    date: r.date,
    status: r.status,
    category: r.category,
    gap_tags: (gaps.get(r.id) ?? []).map((g) => g.tag),
  }));
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const category = z.enum(CATEGORIES);

export function registerCoachingTools(server: McpServer, db: DB) {
  server.registerTool(
    "get_attempt_history",
    {
      description: "List past attempts (newest first) with status, time, approach, and gaps. Filter by problem, category, or date.",
      inputSchema: {
        slug: z.string().optional(),
        category: category.optional(),
        since: isoDate.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, category, since, limit }) => {
      const rows = loadAttempts(db, { slug, category, since }).reverse().slice(0, limit);
      const gaps = gapsForAttempts(db, rows.map((r) => r.id));
      return ok({
        count: rows.length,
        attempts: rows.map((r) => ({
          date: r.date,
          slug: r.slug,
          title: r.title ?? r.slug,
          difficulty: r.difficulty,
          category: r.category,
          status: r.status,
          time_taken_min: r.time_taken_min,
          approach_pattern: r.approach_pattern,
          approach_summary: r.approach_summary,
          verdict_reason: r.verdict_reason,
          strengths: JSON.parse(r.strengths),
          gaps: gaps.get(r.id) ?? [],
        })),
      });
    },
  );

  server.registerTool(
    "get_category_stats",
    {
      description:
        "Per-category practice stats for every category (including never-practiced ones): attempts, pass rate, average " +
        "solve time, days since last practiced, spaced-repetition interval, and the last 30 days vs all time.",
      inputSchema: { since: isoDate.optional().describe("Only count attempts on or after this date") },
      annotations: { readOnlyHint: true },
    },
    async ({ since }) => {
      const now = today();
      const rows = loadAttempts(db, { since });
      const states = categoryStates(toScored(db, rows), now);
      const recentCutoff = new Date(Date.parse(now) - 30 * 86_400_000).toISOString().slice(0, 10);
      return ok({
        today: now,
        total_attempts: rows.length,
        categories: states.map((s) => {
          const mine = rows.filter((r) => r.category === s.category);
          const recent = mine.filter((r) => r.date >= recentCutoff);
          const passedTimes = mine.filter((r) => r.status === "passed" && r.time_taken_min != null).map((r) => r.time_taken_min!);
          return {
            category: s.category,
            attempts: s.attempts,
            distinct_problems: new Set(mine.map((r) => r.slug)).size,
            passed: s.passed,
            pass_rate: s.pass_rate,
            avg_minutes_when_passed: passedTimes.length ? Math.round((passedTimes.reduce((a, b) => a + b, 0) / passedTimes.length) * 10) / 10 : null,
            last_practiced: s.last_practiced,
            days_since: s.days_since,
            interval_days: s.interval_days,
            due_in_days: s.due_in_days,
            last_30_days: {
              attempts: recent.length,
              pass_rate: recent.length ? Math.round((recent.filter((r) => r.status === "passed").length / recent.length) * 1000) / 1000 : null,
            },
          };
        }),
      });
    },
  );

  server.registerTool(
    "get_common_gaps",
    {
      description: "Gap tags ranked by how often they occur, with counts in the last 30 days, the categories they show up in, and example details.",
      inputSchema: {
        category: category.optional(),
        since: isoDate.optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ category, since, limit }) => {
      const now = today();
      const rows = loadAttempts(db, { category, since });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const gaps = gapsForAttempts(db, rows.map((r) => r.id));
      const agg = new Map<GapTag, { count: number; recent: number; last_seen: string; categories: Record<string, number>; examples: object[] }>();
      for (const [attemptId, list] of gaps) {
        const a = byId.get(attemptId)!;
        for (const g of list) {
          const e = agg.get(g.tag) ?? { count: 0, recent: 0, last_seen: a.date, categories: {}, examples: [] };
          e.count++;
          if (daysBetween(a.date, now) <= 30) e.recent++;
          if (a.date > e.last_seen) e.last_seen = a.date;
          e.categories[a.category] = (e.categories[a.category] ?? 0) + 1;
          e.examples.push({ date: a.date, slug: a.slug, detail: g.detail });
          agg.set(g.tag, e);
        }
      }
      const ranked = [...agg.entries()]
        .sort((x, y) => y[1].count - x[1].count || y[1].recent - x[1].recent)
        .slice(0, limit)
        .map(([tag, e]) => ({
          tag,
          count: e.count,
          last_30_days: e.recent,
          last_seen: e.last_seen,
          categories: e.categories,
          examples: (e.examples as Array<{ date: string }>).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 3),
        }));
      return ok({ attempts_considered: rows.length, gaps: ranked });
    },
  );

  server.registerTool(
    "recommend_practice",
    {
      description:
        "Recommend what to practice next using a deterministic score: category weakness (smoothed pass rate), staleness " +
        "against a spaced-repetition interval, retries of failed problems, reviews of old passes, and unattempted catalog " +
        "problems. Returns each pick with its score and reasons. Only recommend problems this tool or search_problems returns.",
      inputSchema: {
        count: z.number().int().min(1).max(15).default(5),
        focus_category: category.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ count, focus_category }) => {
      const attempts = toScored(db, loadAttempts(db));
      const attempted = new Set(attempts.map((a) => a.slug));
      const catalogSize = (db.prepare(`SELECT COUNT(*) n FROM problems`).get() as { n: number }).n;
      const result = recommend(attempts, today(), {
        count,
        focusCategory: focus_category as Category | undefined,
        newProblems: (cat, difficulties, limit) =>
          (
            db
              .prepare(
                `SELECT slug, title, difficulty FROM problems
                 WHERE category = ? AND paid_only = 0 AND difficulty IN (${difficulties.map(() => "?").join(",")})
                 ORDER BY CAST(frontend_id AS INTEGER) LIMIT ?`,
              )
              .all(cat, ...difficulties, limit + attempted.size) as Array<{ slug: string; title: string; difficulty: string | null }>
          )
            .filter((p) => !attempted.has(p.slug))
            .slice(0, limit),
      });
      return ok(catalogSize === 0 ? { ...result, note: "Problem catalog is empty, so no new problems can be suggested. Run `npm run seed:problems`." } : result);
    },
  );

  server.registerTool(
    "search_problems",
    {
      description: "Search the problem catalog by category, difficulty, or title text. Optionally only problems never attempted.",
      inputSchema: {
        category: category.optional(),
        difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
        query: z.string().optional().describe("Case-insensitive title substring"),
        unattempted_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ category, difficulty, query, unattempted_only, limit }) => {
      const where = ["paid_only = 0"];
      const args: Array<string | number> = [];
      if (category) (where.push("category = ?"), args.push(category));
      if (difficulty) (where.push("difficulty = ?"), args.push(difficulty));
      if (query) (where.push("title LIKE ?"), args.push(`%${query}%`));
      if (unattempted_only) where.push("slug NOT IN (SELECT slug FROM attempts)");
      const rows = db
        .prepare(
          `SELECT slug, frontend_id, title, difficulty, category, tags,
             (SELECT COUNT(*) FROM attempts a WHERE a.slug = problems.slug) AS times_attempted
           FROM problems WHERE ${where.join(" AND ")} ORDER BY CAST(frontend_id AS INTEGER) LIMIT ?`,
        )
        .all(...args, limit) as Array<{ tags: string }>;
      return ok({ problems: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) })) });
    },
  );
}
