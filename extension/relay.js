// Runs in the extension's isolated world. Fetches problem metadata, and forwards page-hook messages to
// background.js (which talks to the local server).
(() => {
  const SOURCE = "lca-page-hook";

  const slugFromPath = () => location.pathname.match(/^\/problems\/([^/]+)/)?.[1] ?? null;
  // What the popup shows when you ask "is the extension working on this tab?"
  const status = { loaded_at: new Date().toISOString(), hook_seen: false, editor: null, events_sent: 0, events_failed: 0, last_error: null };
  console.debug("[LCA] relay loaded");

  async function send(event) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "event", event: { ts: new Date().toISOString(), ...event } });
      if (res?.ok) status.events_sent++;
      else {
        status.events_failed++;
        status.last_error = res?.error ?? "no response from extension background";
        console.warn("[LCA] event not delivered (queued):", event.type, status.last_error);
      }
    } catch (err) {
      // Happens after the extension is reloaded: this old page script is orphaned until the tab reloads.
      status.events_failed++;
      status.last_error = `${err?.message ?? err}. Reload this tab.`;
      console.warn("[LCA] can't reach the extension:", status.last_error);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse({ ...status, slug: slugFromPath() });
    if (msg.type === "backfill") {
      backfill(msg.slug, msg.since)
        .then((sent) => sendResponse({ ok: true, sent }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true; // async response
    }
  });

  async function graphql(query, variables) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
    const res = await fetch("/graphql", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`LeetCode GraphQL ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    return body.data;
  }

  // ---- Backfill: submits the page hook missed (e.g. the hook stopped after an extension reload) ----
  // Re-sends this session's submissions from LeetCode's own history. The server ignores ones it already has.
  const SUBMISSIONS = `query submissionList($questionSlug: String!, $offset: Int!, $limit: Int!) {
    questionSubmissionList(questionSlug: $questionSlug, offset: $offset, limit: $limit) {
      submissions { id statusDisplay timestamp isPending }
    }
  }`;
  // Matches the query LeetCode's own submission page sends (the id is an ID string, passed as submissionIdV2).
  const DETAILS = `query submissionDetails($submissionId: ID!) {
    submissionDetails(submissionIdV2: $submissionId) {
      code runtimeDisplay memoryDisplay totalCorrect totalTestcases lastTestcase codeOutput expectedOutput
      runtimeError compileError fullCodeOutput statusCode lang { name }
    }
  }`;

  // LeetCode's numeric judge codes, for when the list doesn't carry a display string.
  const STATUS_CODES = {
    10: "Accepted",
    11: "Wrong Answer",
    12: "Memory Limit Exceeded",
    13: "Output Limit Exceeded",
    14: "Time Limit Exceeded",
    15: "Runtime Error",
    20: "Compile Error",
  };

  async function backfill(slug, since) {
    const sinceMs = Date.parse(since);
    const list = (await graphql(SUBMISSIONS, { questionSlug: slug, offset: 0, limit: 20 }))?.questionSubmissionList?.submissions ?? [];
    const recent = list.filter((s) => !s.isPending && Number(s.timestamp) * 1000 >= sinceMs).reverse(); // oldest first
    for (const s of recent) {
      const d = (await graphql(DETAILS, { submissionId: String(s.id) }))?.submissionDetails;
      if (!d) continue;
      // Shaped like the /check/ response the page hook captures, so the server normalizes both the same way.
      const data = {
        state: "SUCCESS",
        submission_id: String(s.id),
        status_msg: s.statusDisplay ?? STATUS_CODES[d.statusCode],
        total_correct: d.totalCorrect,
        total_testcases: d.totalTestcases,
        status_runtime: d.runtimeDisplay,
        status_memory: d.memoryDisplay,
        last_testcase: d.lastTestcase,
        code_output: d.codeOutput,
        expected_output: d.expectedOutput,
        runtime_error: d.runtimeError,
        compile_error: d.compileError,
        lang: d.lang?.name,
      };
      await send({ type: "judge", slug, ts: new Date(Number(s.timestamp) * 1000).toISOString(), data, code: d.code, language: d.lang?.name ?? null });
    }
    return recent.length;
  }

  // ---- Problem metadata from LeetCode's GraphQL API (full description regardless of scroll) ----
  const QUERY = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) { questionFrontendId title difficulty content isPaidOnly topicTags { slug } }
  }`;

  async function fetchProblem(slug) {
    const q = (await graphql(QUERY, { titleSlug: slug }))?.question;
    if (!q) return undefined;
    return {
      title: q.title,
      frontend_id: q.questionFrontendId,
      difficulty: q.difficulty,
      tags: q.topicTags.map((t) => t.slug),
      content_html: q.content,
      paid_only: q.isPaidOnly,
    };
  }

  // LeetCode is a single-page app, so watch for the slug changing rather than relying on page loads.
  let currentSlug = null;
  async function checkSlug() {
    const slug = slugFromPath();
    if (!slug || slug === currentSlug) return;
    currentSlug = slug;
    let problem;
    try {
      problem = await fetchProblem(slug);
    } catch {
      problem = undefined;
    }
    send({ type: "problem_view", slug, problem });
  }
  checkSlug();
  setInterval(checkSlug, 1000);

  window.addEventListener("message", (msg) => {
    if (msg.source !== window || msg.data?.source !== SOURCE) return;
    const slug = slugFromPath();
    if (!slug) return;
    const { type, payload } = msg.data;
    status.hook_seen = true;
    if (type === "editor_status") status.editor = payload;
    if (type === "snapshot") send({ type: "snapshot", slug, ...payload });
    if (type === "judge") send({ type: "judge", slug, ...payload });
  });
})();
