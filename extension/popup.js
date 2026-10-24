const $ = (id) => document.getElementById(id);
let slug = null;
let tabId = null;
let session = null;
let startedAt = null;
let timer = null;

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (min) => {
  const sec = Math.max(0, Math.round(min * 60));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  slug = tab?.url?.match(/leetcode\.com\/problems\/([^/]+)/)?.[1] ?? null;
  tabId = tab?.id ?? null;
  if (!slug) {
    $("content").textContent = "Open a LeetCode problem to start a session.";
    return;
  }
  await showDiagnostics(tab);
  const status = await chrome.runtime.sendMessage({ type: "status", slug });
  if (!status.ok) {
    $("content").textContent = "";
    $("error").textContent = `Can't reach the local server (npm run dev). ${status.error}`;
    return;
  }
  const s = status.session;
  session = s;
  if (!s) {
    $("content").textContent = `No session yet for ${slug}.`;
    return;
  }
  const m = status.metrics;
  const analysis = s.analysis_status === "error" ? `error: ${esc(s.analysis_error)}` : esc(s.analysis_status);
  $("content").innerHTML = `
    <div><strong>${esc(slug)}</strong></div>
    <div class="timer" id="timer">${fmt(m.wall_minutes)}</div>
    <div class="row"><span class="muted">Active time</span><span>${m.active_minutes} min</span></div>
    <div class="row"><span class="muted">Snapshots</span><span>${m.snapshot_count}</span></div>
    <div class="row"><span class="muted">Runs / submits</span><span>${m.run_count} / ${m.submit_count}</span></div>
    <div class="row"><span class="muted">${status.open ? "Status" : "Ended"}</span><span>${status.open ? "in progress" : esc(s.end_reason)}</span></div>
    ${status.open ? "" : `<div class="row"><span class="muted">Analysis</span><span>${analysis}</span></div>`}
    ${status.queued ? `<div class="row"><span class="muted">Unsent events</span><span>${status.queued}</span></div>` : ""}`;
  $("buttons").hidden = !status.open;
  if (status.open) {
    startedAt = Date.parse(s.started_at);
    clearInterval(timer);
    timer = setInterval(() => ($("timer").textContent = fmt((Date.now() - startedAt) / 60000)), 1000);
  }
}

// Ask the page's content script whether capture is working on this tab.
async function showDiagnostics(tab) {
  const el = $("diag");
  let ping;
  try {
    ping = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
  } catch {
    ping = null;
  }
  if (!ping) {
    el.innerHTML = `<div class="bad">Capture isn't running on this tab. Reload the page (⌘R) and open this popup again.</div>`;
    return;
  }
  const problems = [];
  if (!ping.hook_seen) problems.push("page hook not reporting (reload the page)");
  else if (ping.editor && !ping.editor.found) problems.push("code editor not found on the page");
  else if (ping.editor?.partial) problems.push("reading visible lines only (editor internals not reachable)");
  if (ping.events_failed) problems.push(`${ping.events_failed} events not delivered: ${esc(ping.last_error)}`);
  el.innerHTML = problems.length
    ? problems.map((p) => `<div class="bad">⚠ ${p}</div>`).join("")
    : `<div class="muted">Capture active · ${ping.events_sent} events sent</div>`;
}

async function end(reason) {
  const ts = new Date().toISOString();
  // Pull in any submits the page hook missed first, so an Accepted one still counts.
  // An Accepted submit ends the session by itself; otherwise end it as asked.
  const warning = await backfill();
  const status = await chrome.runtime.sendMessage({ type: "status", slug });
  if (!status.ok || status.open) {
    await chrome.runtime.sendMessage({ type: "event", event: { type: "session_end", slug, reason, ts } });
  }
  clearInterval(timer);
  await refresh();
  if (warning) $("error").textContent = warning;
}

/** Ask the page to re-send this session's submissions from LeetCode. Returns a warning, or null. */
async function backfill() {
  if (!tabId || !session) return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "backfill", slug, since: session.started_at });
    return res?.ok ? null : `Couldn't check LeetCode for missed submissions: ${res?.error ?? "no response"}`;
  } catch {
    return "Couldn't check LeetCode for missed submissions (reload the page).";
  }
}

const openPage = (hash) => chrome.tabs.create({ url: `http://localhost:7777/dashboard#${hash}` });
$("view-dashboard").addEventListener("click", () => openPage("dashboard"));
$("view-problems").addEventListener("click", () => openPage("problems"));
$("end").addEventListener("click", () => end("ended"));
$("giveup").addEventListener("click", () => end("gave_up"));
refresh();
