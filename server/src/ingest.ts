// Ingest server: receives events from the Chrome extension, maintains sessions, and runs the analyzer
// when a session ends. `npm run dev`
import { randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { analyzeSession } from "./agent/analyze-session.js";
import { config } from "./config.js";
import {
  type DB,
  type SessionRow,
  createSession,
  endSession,
  findOpenSession,
  getDb,
  getSession,
  insertJudgeEvent,
  insertSnapshot,
  lastSnapshot,
  listJudgeEvents,
  listSnapshots,
  setAnalysisStatus,
  touchSession,
  upsertProblem,
} from "./db.js";
import { htmlToText, normalizeJudge } from "./judge.js";
import { computeMetrics, shouldSkipAnalysis } from "./sessions.js";
import { categoryFromTags } from "./taxonomy.js";

export type IncomingEvent =
  | {
      type: "problem_view";
      slug: string;
      ts?: string;
      problem?: { title: string; frontend_id?: string; difficulty?: string; tags?: string[]; content_html?: string; paid_only?: boolean };
    }
  | { type: "snapshot"; slug: string; ts?: string; language?: string; code: string; partial?: boolean }
  | { type: "judge"; slug: string; ts?: string; url?: string; data: Record<string, unknown>; code?: string; language?: string }
  | { type: "session_end"; slug: string; ts?: string; reason: "ended" | "gave_up" };

type Analyzer = (sessionId: string) => Promise<unknown>;

export class Ingest {
  private queue: string[] = [];
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly analyze: Analyzer = (id) => analyzeSession(id),
  ) {}

  handle(e: IncomingEvent): { session_id: string | null; ended?: boolean } {
    const ts = e.ts ?? new Date().toISOString();
    switch (e.type) {
      case "problem_view": {
        if (e.problem) {
          upsertProblem(this.db, {
            slug: e.slug,
            title: e.problem.title,
            frontend_id: e.problem.frontend_id,
            difficulty: e.problem.difficulty,
            tags: e.problem.tags,
            category: e.problem.tags?.length ? categoryFromTags(e.problem.tags, e.problem.title) : undefined,
            description: e.problem.content_html ? htmlToText(e.problem.content_html) : undefined,
            paid_only: e.problem.paid_only,
          });
        }
        return { session_id: this.openSession(e.slug, ts).id };
      }
      case "snapshot": {
        const s = this.openSession(e.slug, ts);
        this.addSnapshot(s.id, ts, e.code, e.language ?? null, e.partial);
        return { session_id: s.id };
      }
      case "judge": {
        const s = this.openSession(e.slug, ts);
        const j = normalizeJudge(e.data, e.url);
        const language = e.language ?? j.language;
        if (e.code) this.addSnapshot(s.id, ts, e.code, language);
        insertJudgeEvent(this.db, { session_id: s.id, ts, ...j, language });
        touchSession(this.db, s.id, ts);
        if (j.kind === "submit" && j.status === "Accepted") {
          this.finish(s.id, ts, "accepted");
          return { session_id: s.id, ended: true };
        }
        return { session_id: s.id };
      }
      case "session_end": {
        const s = findOpenSession(this.db, e.slug);
        if (!s) return { session_id: null };
        this.finish(s.id, ts, e.reason);
        return { session_id: s.id, ended: true };
      }
    }
  }

  /** The open session for a slug, or a new one if none is open (or the open one went idle). */
  private openSession(slug: string, ts: string): SessionRow {
    const open = findOpenSession(this.db, slug);
    if (open) {
      const idleMin = (Date.parse(ts) - Date.parse(open.last_activity_at)) / 60_000;
      if (idleMin <= config.idleMinutes) return open;
      this.finish(open.id, open.last_activity_at, "idle");
    }
    return createSession(this.db, randomUUID(), slug, ts);
  }

  private addSnapshot(sessionId: string, ts: string, code: string, language: string | null, partial?: boolean) {
    if (lastSnapshot(this.db, sessionId)?.code === code) return; // unchanged
    insertSnapshot(this.db, { session_id: sessionId, ts, language, code, partial });
    touchSession(this.db, sessionId, ts);
  }

  finish(sessionId: string, ts: string, reason: string) {
    endSession(this.db, sessionId, ts, reason);
    const s = getSession(this.db, sessionId)!;
    const skip = shouldSkipAnalysis(s, listSnapshots(this.db, s.id), listJudgeEvents(this.db, s.id));
    if (skip) {
      setAnalysisStatus(this.db, s.id, "skipped", skip);
      console.log(`session ${s.id} (${s.slug}) ended: ${reason}; analysis skipped (${skip})`);
      return;
    }
    console.log(`session ${s.id} (${s.slug}) ended: ${reason}; queued for analysis`);
    this.enqueue(s.id);
  }

  /** End sessions with no activity for `idleMinutes`. */
  sweepIdle(now = new Date()) {
    const cutoff = new Date(now.getTime() - config.idleMinutes * 60_000).toISOString();
    const stale = this.db
      .prepare(`SELECT id, last_activity_at FROM sessions WHERE ended_at IS NULL AND last_activity_at < ?`)
      .all(cutoff) as Array<{ id: string; last_activity_at: string }>;
    for (const s of stale) this.finish(s.id, s.last_activity_at, "idle");
  }

  /** Re-queue sessions that ended but weren't analyzed (e.g. the server stopped mid-run). */
  resumePending() {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE analysis_status IN ('pending', 'running')`).all() as Array<{ id: string }>;
    rows.forEach((r) => this.enqueue(r.id));
  }

  enqueue(sessionId: string) {
    if (!this.queue.includes(sessionId)) this.queue.push(sessionId);
    void this.drain();
  }

  /** One analysis at a time, in the order sessions ended. */
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        setAnalysisStatus(this.db, id, "running");
        try {
          const r = (await this.analyze(id)) as { saved?: boolean; summary?: string; tracePath?: string } | undefined;
          if (r && r.saved === false) {
            setAnalysisStatus(this.db, id, "error", `agent finished without saving; trace: ${r.tracePath}`);
          } else {
            setAnalysisStatus(this.db, id, "done");
            if (r?.summary) console.log(`\n[analysis ${id}]\n${r.summary}\n`);
          }
        } catch (err) {
          setAnalysisStatus(this.db, id, "error", err instanceof Error ? err.message : String(err));
          console.error(`analysis of ${id} failed:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  currentStatus(slug: string) {
    const open = findOpenSession(this.db, slug);
    const latest =
      open ??
      (this.db.prepare(`SELECT * FROM sessions WHERE slug = ? ORDER BY started_at DESC LIMIT 1`).get(slug) as SessionRow | undefined);
    if (!latest) return { session: null };
    const metrics = computeMetrics(latest, listSnapshots(this.db, latest.id), listJudgeEvents(this.db, latest.id));
    return { session: latest, metrics, open: !latest.ended_at };
  }
}

// ---- HTTP ----

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createServer(ingest: Ingest) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/sessions/current") {
        const slug = url.searchParams.get("slug");
        if (!slug) return send(400, { error: "slug required" });
        return send(200, ingest.currentStatus(slug));
      }
      if (req.method === "POST" && url.pathname === "/events") {
        const body = (await readJson(req)) as IncomingEvent | { events: IncomingEvent[] };
        const events = "events" in body ? body.events : [body];
        const results = events.map((e) => ingest.handle(e));
        return send(200, { ok: true, results });
      }
      send(404, { error: "not found" });
    } catch (err) {
      console.error(err);
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = getDb();
  const ingest = new Ingest(db);
  ingest.resumePending();
  setInterval(() => ingest.sweepIdle(), 60_000).unref();
  createServer(ingest).listen(config.port, "127.0.0.1", () => {
    console.log(`ingest server on http://localhost:${config.port} · db ${config.dbPath} · model ${config.model}`);
  });
}
