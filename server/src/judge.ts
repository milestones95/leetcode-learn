// Normalizes LeetCode's `/submissions/detail/<id>/check/` response into a judge event.

export interface NormalizedJudge {
  kind: "run" | "submit";
  status: string;
  tests_passed: number | null;
  tests_total: number | null;
  runtime: string | null;
  memory: string | null;
  error_detail: string | null;
  language: string | null;
  /** LeetCode's id for this run/submit, used to recognize the same result arriving twice. */
  submission_id: string | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : v == null || v === "" ? null : Number(v));
const clip = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + "…" : s);

export function normalizeJudge(raw: Raw, url = ""): NormalizedJudge {
  const isRun =
    /runcode/i.test(url) || String(raw.submission_id ?? "").startsWith("runcode") || /RunCode/i.test(String(raw.task_name ?? ""));
  const statusMsg = str(raw.status_msg) ?? "Unknown";

  let status = statusMsg;
  let error: string | null = null;

  if (raw.full_compile_error || raw.compile_error) {
    status = "Compile Error";
    error = str(raw.full_compile_error ?? raw.compile_error);
  } else if (raw.full_runtime_error || raw.runtime_error) {
    status = "Runtime Error";
    error = str(raw.full_runtime_error ?? raw.runtime_error);
  } else if (isRun) {
    // For "Run", status_msg is "Accepted" whenever the code executed; correctness is `correct_answer`.
    if (statusMsg === "Accepted") status = raw.correct_answer === false ? "Wrong Answer (sample tests)" : "Passed sample tests";
    if (raw.correct_answer === false) {
      error = `Output: ${JSON.stringify(raw.code_answer)}\nExpected: ${JSON.stringify(raw.expected_code_answer)}`;
    }
  } else if (statusMsg !== "Accepted") {
    const parts = [
      raw.last_testcase != null && `Input: ${raw.last_testcase}`,
      raw.code_output != null && `Output: ${raw.code_output}`,
      raw.expected_output != null && `Expected: ${raw.expected_output}`,
    ].filter(Boolean);
    error = parts.length ? parts.join("\n") : null;
  }

  return {
    kind: isRun ? "run" : "submit",
    status,
    tests_passed: num(raw.total_correct),
    tests_total: num(raw.total_testcases),
    runtime: str(raw.status_runtime),
    memory: str(raw.status_memory),
    error_detail: error ? clip(error) : null,
    language: str(raw.lang ?? raw.pretty_lang),
    submission_id: str(raw.submission_id) ?? url.match(/\/detail\/([^/]+)\/check/)?.[1] ?? null,
  };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<sup>(.*?)<\/sup>/g, "^$1")
    .replace(/<(br|\/p|\/li|\/pre|\/div)\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
