// Deterministic practice scoring. The coach calls this through `recommend_practice` and explains the result;
// keeping the math in code makes recommendations reproducible and testable.
import { CATEGORIES, type Category, type GapTag } from "../taxonomy.js";
import type { AttemptStatus } from "../taxonomy.js";

export interface ScoredAttempt {
  id: number;
  slug: string;
  title: string;
  difficulty: string | null;
  date: string;
  status: AttemptStatus;
  category: Category;
  gap_tags: GapTag[];
}

export interface CategoryState {
  category: Category;
  attempts: number;
  passed: number;
  pass_rate: number | null;
  last_practiced: string | null;
  days_since: number | null;
  /** Spaced-repetition interval: 2 days after a first pass, doubling per pass (max 30), back to 1 after a miss. */
  interval_days: number;
  due_in_days: number | null;
  /** 1 - smoothed pass rate, (passed + 1) / (attempts + 2). */
  weakness: number;
  /** 0 just practiced, 0.5 exactly due, 1 at double-overdue or never practiced. */
  staleness: number;
  priority: number;
}

export interface Candidate {
  slug: string;
  title: string;
  difficulty: string | null;
  category: Category;
  kind: "retry" | "review" | "new";
  score: number;
  reasons: string[];
}

export const WEIGHTS = { weakness: 0.6, staleness: 0.4, retry_bonus: 0.3, review_bonus: 0.1 };

const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** `attempts` must be sorted by date ascending. */
export function categoryStates(attempts: ScoredAttempt[], today: string): CategoryState[] {
  return CATEGORIES.map((category) => {
    const list = attempts.filter((a) => a.category === category);
    const passed = list.filter((a) => a.status === "passed").length;
    let interval = 0;
    for (const a of list) interval = a.status === "passed" ? (interval === 0 ? 2 : Math.min(interval * 2, 30)) : 1;

    const last = list.at(-1)?.date ?? null;
    const daysSince = last ? daysBetween(last, today) : null;
    const weakness = 1 - (passed + 1) / (list.length + 2);
    const staleness = daysSince == null ? 1 : clamp(0.5 + (daysSince - interval) / (2 * Math.max(interval, 1)), 0, 1);
    return {
      category,
      attempts: list.length,
      passed,
      pass_rate: list.length ? r3(passed / list.length) : null,
      last_practiced: last,
      days_since: daysSince,
      interval_days: interval,
      due_in_days: daysSince == null ? null : interval - daysSince,
      weakness: r3(weakness),
      staleness: r3(staleness),
      priority: r3(WEIGHTS.weakness * weakness + WEIGHTS.staleness * staleness),
    };
  });
}

/** Difficulty to aim new problems at, based on how the category is going. */
export function targetDifficulties(s: CategoryState): string[] {
  const smoothed = 1 - s.weakness;
  if (s.attempts < 3 || smoothed < 0.5) return ["Easy", "Medium"];
  if (smoothed < 0.8) return ["Medium"];
  return ["Medium", "Hard"];
}

export interface RecommendOptions {
  count: number;
  focusCategory?: Category;
  /** Unattempted catalog problems for a category, in preferred order. */
  newProblems: (category: Category, difficulties: string[], limit: number) => Array<{ slug: string; title: string; difficulty: string | null }>;
}

export function recommend(attempts: ScoredAttempt[], today: string, opts: RecommendOptions) {
  const states = categoryStates(attempts, today)
    .filter((s) => !opts.focusCategory || s.category === opts.focusCategory)
    .sort((a, b) => b.priority - a.priority);
  const stateOf = new Map(states.map((s) => [s.category, s]));

  const latestBySlug = new Map<string, ScoredAttempt>();
  for (const a of attempts) latestBySlug.set(a.slug, a);

  const candidates: Candidate[] = [];
  for (const a of latestBySlug.values()) {
    const s = stateOf.get(a.category);
    if (!s) continue;
    const ago = daysBetween(a.date, today);
    if (a.status !== "passed" && ago >= 1) {
      const gaps = a.gap_tags.length ? `; gaps then: ${[...new Set(a.gap_tags)].join(", ")}` : "";
      candidates.push({
        ...pick(a),
        kind: "retry",
        score: r3(s.priority + WEIGHTS.retry_bonus),
        reasons: [`last attempt ${a.date} (${ago}d ago) was ${a.status}${gaps}`, categoryReason(s)],
      });
    } else if (a.status === "passed" && ago >= Math.max(14, 2 * s.interval_days)) {
      candidates.push({
        ...pick(a),
        kind: "review",
        score: r3(s.priority + WEIGHTS.review_bonus),
        reasons: [`passed ${a.date}, ${ago}d ago: due for a spaced-repetition review`, categoryReason(s)],
      });
    }
  }
  // New problems only for the categories that need the most work.
  for (const s of states.slice(0, Math.max(3, Math.ceil(opts.count / 2)))) {
    const diffs = targetDifficulties(s);
    for (const p of opts.newProblems(s.category, diffs, 2)) {
      candidates.push({
        ...p,
        category: s.category,
        kind: "new",
        score: s.priority,
        reasons: [`new ${p.difficulty ? `${p.difficulty} ` : ""}problem (target: ${diffs.join("/")})`, categoryReason(s)],
      });
    }
  }

  // Highest score first, but spread across categories: at most a third of the list from one category.
  candidates.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const perCategoryCap = Math.max(1, Math.ceil(opts.count / 3));
  const counts = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= opts.count) break;
    if ((counts.get(c.category) ?? 0) >= perCategoryCap || picked.some((p) => p.slug === c.slug)) continue;
    counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    picked.push(c);
  }
  return { today, weights: WEIGHTS, top_categories: states.slice(0, 5), recommendations: picked };
}

const pick = (a: ScoredAttempt) => ({ slug: a.slug, title: a.title, difficulty: a.difficulty, category: a.category });

function categoryReason(s: CategoryState): string {
  const rate = s.pass_rate == null ? "never practiced" : `pass rate ${Math.round(s.pass_rate * 100)}% over ${s.attempts}`;
  const when = s.days_since == null ? "" : `, last practiced ${s.days_since}d ago (interval ${s.interval_days}d)`;
  return `${s.category}: ${rate}${when}`;
}
