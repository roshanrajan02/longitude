import type { Database } from "bun:sqlite";
import { connect } from "./db";
import { dedupeKey, toIso } from "./parse";
import { latest, recent, sleepByNight, summary, trend } from "./query";

/**
 * The ingest API and live stream.
 *
 * Two jobs. It accepts pushes from the watch app — the only route off the phone,
 * since HealthKit has no server-side API — and it streams what arrives to
 * anything watching.
 *
 * Bound to localhost by default. This holds clinical records, and a health
 * server listening on 0.0.0.0 by default is how a home network becomes a
 * disclosure. Publishing to the internet is a decision, made with `--host`.
 */

export type ServeOptions = {
  dbPath?: string;
  port?: number;
  host?: string;
};

/** Samples pushed by the watch, in the shape the app will send. */
type IngestSample = {
  type: string;
  value: number | null;
  unit?: string | null;
  start: string;
  end?: string | null;
  source?: string | null;
};

/**
 * Everyone currently watching the stream.
 *
 * A plain Set of writable controllers. There is exactly one user, so a real
 * pub/sub would be machinery for a problem that does not exist.
 */
const watchers = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(event: string, data: unknown): void {
  const frame = new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  for (const w of watchers) {
    try {
      w.enqueue(frame);
    } catch {
      // The client vanished between the check and the write. Dropping it here
      // rather than tracking liveness separately keeps this honest.
      watchers.delete(w);
    }
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A shared secret for pushes.
 *
 * Only writes are protected. Reads are localhost-only by default, and the watch
 * needs something it can put in a header — a token in the Keychain is the
 * simplest thing that is not "anyone on the LAN can write to your health record".
 */
function authorized(req: Request): boolean {
  const token = process.env.LONGITUDE_TOKEN;
  if (!token) return true; // Not configured: local-only development.
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export function serve(opts: ServeOptions = {}) {
  const db: Database = connect(opts.dbPath);
  const port = opts.port ?? 4000;
  const hostname = opts.host ?? "127.0.0.1";

  const insert = db.prepare(
    `INSERT OR IGNORE INTO samples (type, value, unit, start_time, end_time, source, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0, // SSE connections are meant to sit open.

    async fetch(req) {
      const url = new URL(req.url);

      // --- ingest ------------------------------------------------------------
      if (url.pathname === "/ingest" && req.method === "POST") {
        if (!authorized(req)) return json({ error: "unauthorized" }, 401);

        let body: { samples?: IngestSample[] };
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid json" }, 400);
        }

        const samples = body.samples ?? [];
        if (!Array.isArray(samples)) return json({ error: "samples must be an array" }, 400);

        let added = 0;
        let skipped = 0;

        const write = db.transaction((rows: IngestSample[]) => {
          for (const s of rows) {
            // Accept both ISO and Apple's format, so the app can send whichever
            // is cheaper for it rather than converting on a watch.
            const start = s.start?.includes("T") ? s.start : toIso(s.start ?? "");
            if (!start || !s.type) {
              skipped++;
              continue;
            }
            const end = s.end ? (s.end.includes("T") ? s.end : toIso(s.end)) : null;
            const key = dedupeKey([s.type, start, s.value, s.source ?? null]);
            const res = insert.run(
              s.type,
              s.value ?? null,
              s.unit ?? null,
              start,
              end,
              s.source ?? null,
              key,
            );
            res.changes > 0 ? added++ : skipped++;
          }
        });

        write(samples);

        // Only tell watchers about rows that were genuinely new. Echoing
        // duplicates would make a re-sync look like a burst of live activity.
        if (added > 0) broadcast("samples", { added, at: new Date().toISOString() });

        return json({ ok: true, added, skipped });
      }

      // --- live stream -------------------------------------------------------
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            watchers.add(controller);
            controller.enqueue(
              new TextEncoder().encode(
                `event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
              ),
            );
          },
          cancel(_reason) {
            // Fires when the client disconnects. Without this, watchers grows
            // forever and every broadcast writes to dead controllers.
            for (const w of watchers) {
              try {
                w.enqueue(new Uint8Array());
              } catch {
                watchers.delete(w);
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      // --- reads -------------------------------------------------------------
      if (url.pathname === "/api/summary") return json(summary(db));

      if (url.pathname === "/api/trend") {
        const type = url.searchParams.get("type") ?? "heart_rate";
        const days = Number(url.searchParams.get("days") ?? 30);
        return json({ type, days, points: trend(db, type, days) });
      }

      if (url.pathname === "/api/latest") {
        const type = url.searchParams.get("type") ?? "heart_rate";
        return json({ type, ...(latest(db, type) ?? {}) });
      }

      if (url.pathname === "/api/sleep") {
        const days = Number(url.searchParams.get("days") ?? 30);
        return json({ days, nights: sleepByNight(db, days) });
      }

      if (url.pathname === "/api/workouts") {
        return json({ workouts: recent(db, Number(url.searchParams.get("limit") ?? 10)) });
      }

      if (url.pathname === "/health") return json({ ok: true });

      return json({ error: "not found" }, 404);
    },
  });

  console.log(`longitude serving on http://${hostname}:${port}`);
  console.log(`  POST /ingest        push samples (watch app)`);
  console.log(`  GET  /events        live stream`);
  console.log(`  GET  /api/summary   what's in the database`);
  if (!process.env.LONGITUDE_TOKEN) {
    console.log(`\n  LONGITUDE_TOKEN is unset — /ingest accepts unauthenticated writes.`);
  }

  return server;
}
