// Runs in the page's own JS world (MAIN), so it can see `window.monaco` and wrap `window.fetch`.
// It only posts messages to relay.js, which forwards them to the extension.
(() => {
  const SOURCE = "lca-page-hook";
  const POLL_MS = 5000;

  const post = (type, payload) => window.postMessage({ source: SOURCE, type, payload }, window.location.origin);
  console.debug("[LCA] page hook loaded");
  const onProblemPage = () => /^\/problems\/[^/]+/.test(location.pathname);

  // ---- Code: read the full text from Monaco's model ----
  // Monaco only renders the lines on screen, so reading the editor DOM would miss scrolled-off code.
  // The model always holds the whole buffer.
  function readCode() {
    const monaco = window.monaco;
    if (monaco?.editor) {
      const editors = monaco.editor.getEditors?.() ?? [];
      const models = editors.length ? editors.map((e) => e.getModel()).filter(Boolean) : monaco.editor.getModels();
      // The solution editor is the non-plaintext model; prefer the longest if there are several.
      const candidates = models.filter((m) => m.getLanguageId?.() !== "plaintext");
      const model = (candidates.length ? candidates : models).sort((a, b) => b.getValueLength() - a.getValueLength())[0];
      if (model) return { code: model.getValue(), language: model.getLanguageId?.() ?? null, partial: false };
    }
    // Fallback: visible lines only. Flagged so the analyzer knows the snapshot may be incomplete.
    const lines = document.querySelectorAll(".monaco-editor .view-lines .view-line");
    if (lines.length) {
      return { code: [...lines].map((l) => l.textContent.replace(/\u00a0/g, " ")).join("\n"), language: null, partial: true };
    }
    return null;
  }

  let lastCode = null;
  let warnedNoEditor = false;
  function snapshot(force = false) {
    if (!onProblemPage()) return null;
    const read = readCode();
    post("editor_status", { found: Boolean(read), monaco: Boolean(window.monaco?.editor), partial: read?.partial ?? null });
    if (!read) {
      if (!warnedNoEditor) console.warn("[LCA] can't find the code editor on this page yet");
      warnedNoEditor = true;
      return null;
    }
    if (force || read.code !== lastCode) {
      lastCode = read.code;
      post("snapshot", read);
    }
    return read;
  }
  setInterval(() => snapshot(), POLL_MS);

  // ---- Results: watch LeetCode's judge polling ----
  // Both Run and Submit poll /submissions/detail/<id>/check/ until state is SUCCESS.
  const CHECK_URL = /\/submissions\/detail\/[^/]+\/check\/?/;
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? String(args[0]);
      if (CHECK_URL.test(url)) {
        res
          .clone()
          .json()
          .then((data) => {
            if (data?.state !== "SUCCESS") return;
            const read = readCode();
            post("judge", { url, data, code: read?.code ?? null, language: read?.language ?? null });
          })
          .catch(() => {});
      }
    } catch {
      // Never break the page because of the hook.
    }
    return res;
  };
})();
