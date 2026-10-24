// Minimal line diff (LCS). Solutions are small, so O(n*m) is fine and keeps us dependency-free.

export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  return collapseContext(out, 2);
}

/** Keep `context` unchanged lines around each change and fold the rest. */
function collapseContext(lines: string[], context: number): string {
  const changed = lines.map((l) => l[0] !== " ");
  const keep = lines.map((_, idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) if (changed[k]) return true;
    return false;
  });
  const out: string[] = [];
  let folded = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (folded) out.push(`  … ${folded} unchanged line${folded > 1 ? "s" : ""}`);
      folded = 0;
      out.push(l);
    } else folded++;
  });
  if (folded) out.push(`  … ${folded} unchanged line${folded > 1 ? "s" : ""}`);
  return out.join("\n");
}
