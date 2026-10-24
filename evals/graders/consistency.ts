// Reliability across repeated trials of the same case: does the agent give the same answer twice?

/** Share of trials that agree with the most common value (1 = all agree). */
export function modalAgreement(values: string[]): number {
  if (values.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

/** Mean pairwise Jaccard similarity of sets (1 = identical sets every time). */
export function meanPairwiseJaccard(sets: Array<Set<string>>): number {
  if (sets.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const union = new Set([...sets[i], ...sets[j]]);
      const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
      total += union.size === 0 ? 1 : inter / union.size;
      pairs++;
    }
  }
  return total / pairs;
}
