// Fixed vocabularies. The agent must pick from these so stats can group cleanly and evals can check them.

export const CATEGORIES = [
  "Arrays & Hashing",
  "Two Pointers",
  "Sliding Window",
  "Stack",
  "Binary Search",
  "Linked List",
  "Trees",
  "Tries",
  "Heap",
  "Backtracking",
  "Graphs",
  "Advanced Graphs",
  "1-D DP",
  "2-D DP",
  "Greedy",
  "Intervals",
  "Math & Geometry",
  "Bit Manipulation",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const GAP_TAGS = {
  "pattern-recognition": "Didn't recognize which technique the problem calls for, or recognized it late.",
  "edge-cases": "Missed inputs like empty, single element, duplicates, negatives, or overflow.",
  "off-by-one": "Loop bounds, index math, or inclusive/exclusive ranges were wrong.",
  "data-structure-choice": "Picked a structure that made the solution slower or harder than necessary.",
  "complexity-constraints": "Solution violated the time/space limits (TLE, MLE, or a stated constraint).",
  "language-syntax": "Got stuck on language APIs or syntax rather than the algorithm.",
  "algorithm-recall": "Knew the technique but couldn't reconstruct its implementation (e.g. binary search bounds).",
  "debugging": "Spent long cycles of run/fix without a systematic way to find the bug.",
  "problem-understanding": "Misread the problem or its required output.",
  "gave-up-early": "Stopped before exhausting reasonable ideas.",
  "code-organization": "Code worked but was tangled, duplicated, or hard to reason about.",
} as const;
export type GapTag = keyof typeof GAP_TAGS;
export const GAP_TAG_LIST = Object.keys(GAP_TAGS) as [GapTag, ...GapTag[]];

export const ATTEMPT_STATUSES = ["passed", "failed", "gave_up"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// Ordered rules for mapping LeetCode topic tags to one category. First match wins, so more specific
// patterns come first. This is only a hint for the catalog; the analyzer picks the category per attempt.
const TAG_RULES: Array<[string[], Category]> = [
  [["trie"], "Tries"],
  [["shortest-path", "minimum-spanning-tree", "strongly-connected-component", "eulerian-circuit", "biconnected-component"], "Advanced Graphs"],
  [["line-sweep"], "Intervals"],
  [["backtracking"], "Backtracking"],
  [["dp-on-trees"], "Trees"],
  [["dynamic-programming", "memoization"], "1-D DP"],
  [["heap-priority-queue"], "Heap"],
  [["tree", "binary-tree", "binary-search-tree"], "Trees"],
  [["linked-list"], "Linked List"],
  [["graph", "union-find", "topological-sort", "depth-first-search", "breadth-first-search"], "Graphs"],
  [["sliding-window"], "Sliding Window"],
  [["binary-search"], "Binary Search"],
  [["stack", "monotonic-stack"], "Stack"],
  [["two-pointers"], "Two Pointers"],
  [["bit-manipulation"], "Bit Manipulation"],
  [["greedy"], "Greedy"],
  [["math", "geometry"], "Math & Geometry"],
];

// DP over two indices (grids, two strings). Tags don't distinguish this, so fall back on well-known shapes.
const TWO_D_DP = /unique paths|grid|edit distance|interleaving|distinct subsequences|common subsequence|regular expression|wildcard|burst balloons/i;

export function categoryFromTags(tagSlugs: string[], title = ""): Category {
  const tags = new Set(tagSlugs);
  if (/interval/i.test(title)) return "Intervals";
  for (const [ruleTags, category] of TAG_RULES) {
    if (ruleTags.some((t) => tags.has(t))) {
      if (category === "1-D DP" && (tags.has("matrix") || TWO_D_DP.test(title))) return "2-D DP";
      return category;
    }
  }
  return "Arrays & Hashing";
}
