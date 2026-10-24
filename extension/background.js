// Service worker: posts events to the local server. Requests from here aren't subject to leetcode.com's
// CORS rules. Events that fail to send (server not running) are queued in storage and retried.
const SERVER = "http://localhost:7777";
const QUEUE_KEY = "pendingEvents";
const MAX_QUEUE = 2000;

async function postEvents(events) {
  const res = await fetch(`${SERVER}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`server ${res.status}`);
  return res.json();
}

async function sendEvent(event) {
  const { [QUEUE_KEY]: queued = [] } = await chrome.storage.local.get(QUEUE_KEY);
  const batch = [...queued, event];
  try {
    const result = await postEvents(batch);
    if (queued.length) await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    return { ok: true, result: result.results.at(-1) };
  } catch (err) {
    await chrome.storage.local.set({ [QUEUE_KEY]: batch.slice(-MAX_QUEUE) });
    return { ok: false, error: String(err), queued: batch.length };
  }
}

// Serialize sends so concurrent events don't race on the stored queue.
let chain = Promise.resolve();
function sendInOrder(event) {
  const next = chain.then(() => sendEvent(event));
  chain = next.catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "event") {
    sendInOrder(msg.event).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "status") {
    Promise.all([
      fetch(`${SERVER}/sessions/current?slug=${encodeURIComponent(msg.slug)}`).then((r) => r.json()),
      chrome.storage.local.get(QUEUE_KEY),
    ])
      .then(([status, store]) => sendResponse({ ok: true, ...status, queued: (store[QUEUE_KEY] ?? []).length }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
