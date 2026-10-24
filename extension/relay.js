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
  });

  // ---- Problem metadata from LeetCode's GraphQL API (full description regardless of scroll) ----
  const QUERY = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) { questionFrontendId title difficulty content isPaidOnly topicTags { slug } }
  }`;

  async function fetchProblem(slug) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
    const res = await fetch("/graphql", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) },
      body: JSON.stringify({ query: QUERY, variables: { titleSlug: slug } }),
    });
    const q = (await res.json())?.data?.question;
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
