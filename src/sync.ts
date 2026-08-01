import type { Database } from "bun:sqlite";
import { SQL } from "bun";

/**
 * Publishing a chosen slice to the dashboard.
 *
 * This is the boundary the README's privacy paragraph is about. Longitude holds
 * ~2 million raw samples and every clinical record; the website holds daily
 * averages for a named list of metrics and nothing else. The list below is the
 * enforcement — not the dashboard's choice of what to render, which would leave
 * the data sitting there for anything else to read.
 *
 * Aggregates also happen to be the only sane thing to send. Two million rows
 * over the wire nightly would be absurd for a page showing seven-day trends.
 */

/**
 * What crosses the boundary.
 *
 * Every entry is a deliberate decision. Notably absent: anything from the
 * `clinical` table, body mass, and blood glucose — all of which are either
 * clinical facts or the kind of thing a person might not want on a machine
 * they do not physically own, even behind a login.
 */
export const PUBLISHED_METRICS: { metric: string; source: string; unit: string }[] = [
  { metric: "heart_rate", source: "samples", unit: "bpm" },
  { metric: "resting_heart_rate", source: "samples", unit: "bpm" },
  { metric: "heart_rate_variability_sdnn", source: "samples", unit: "ms" },
  { metric: "step_count", source: "samples_sum", unit: "steps" },
  { metric: "active_energy_burned", source: "samples_sum", unit: "kcal" },
  { metric: "apple_exercise_time", source: "samples_sum", unit: "min" },
  { metric: "vo2_max", source: "samples", unit: "ml/kg·min" },
  { metric: "respiratory_rate", source: "samples", unit: "breaths/min" },
  { metric: "sleep_hours", source: "sleep", unit: "hours" },
  { metric: "workout_minutes", source: "workouts", unit: "min" },
  // From the GPX routes, which is the only place distance and climb exist —
  // newer exports moved them out of the Workout element entirely.
  { metric: "distance_km", source: "routes_distance", unit: "km" },
  { metric: "elevation_gain_m", source: "routes_climb", unit: "m" },
];

/**
 * Which night a sleep record belongs to.
 *
 * Times are stored in UTC and a night spans local midnight, so neither the UTC
 * date nor a naive shift is right. Grouping on the *end* of each record, shifted
 * into local time, attributes a night to the morning you woke — which is how
 * people talk about sleep ("I got six hours last night").
 *
 * The first version used `date(start_time, '-12 hours')`, which split a single
 * night across two dates: the evening records landed on the previous day and the
 * morning ones on the current day. It reported 2.3 hours for a night that was
 * actually 6.7. Wrong in a way that looked plausible, which is the failure mode
 * worth naming.
 *
 * The offset is the local one. Daylight saving moves it by an hour twice a year,
 * which can only misfile a record ending within an hour of local midnight — and
 * essentially nobody's sleep ends at midnight.
 */
const LOCAL_OFFSET = process.env.LONGITUDE_UTC_OFFSET ?? "-7 hours";
const SLEEP_NIGHT = `date(end_time, '${LOCAL_OFFSET}')`;

export type SyncRow = {
  day: string;
  metric: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  n: number;
  unit: string;
};

/**
 * Build the rows to publish.
 *
 * Pure apart from reading SQLite, so what gets sent can be inspected before
 * anything leaves the machine — `longitude sync --dry-run` prints exactly this.
 */
export function buildRows(db: Database, days: number): SyncRow[] {
  const rows: SyncRow[] = [];
  const since = `-${days} days`;

  for (const { metric, source, unit } of PUBLISHED_METRICS) {
    if (source === "samples" || source === "samples_sum") {
      /**
       * Average for a rate, sum for a count.
       *
       * Averaging step_count across the day's samples gives the mean size of a
       * step batch, which is a meaningless number that looks like a plausible
       * step count. Rates average; counts add.
       */
      const agg = source === "samples_sum" ? "SUM(value)" : "AVG(value)";
      const result = db
        .prepare(
          `SELECT date(start_time) AS day,
                  ${agg}            AS avg,
                  MIN(value)        AS min,
                  MAX(value)        AS max,
                  COUNT(*)          AS n
             FROM samples
            WHERE type = ? AND value IS NOT NULL
              AND start_time >= date('now', ?)
            GROUP BY day`,
        )
        .all(metric, since) as { day: string; avg: number; min: number; max: number; n: number }[];

      for (const r of result) rows.push({ ...r, metric, unit });
    }

    if (source === "sleep") {
      // Asleep stages only — `in_bed` spans them and would double-count.
      const result = db
        .prepare(
          `SELECT ${SLEEP_NIGHT}        AS day,
                  SUM(minutes) / 60.0  AS avg,
                  COUNT(*)             AS n
             FROM sleep
            WHERE stage IN ('core','deep','rem','asleep')
              AND start_time >= date('now', ?)
            GROUP BY day`,
        )
        .all(since) as { day: string; avg: number; n: number }[];

      for (const r of result) {
        rows.push({ day: r.day, metric, avg: r.avg, min: null, max: null, n: r.n, unit });
      }
    }

    if (source === "routes_distance" || source === "routes_climb") {
      const col = source === "routes_distance" ? "distance_km" : "elevation_gain_m";
      const result = db
        .prepare(
          `SELECT date(start_time) AS day, SUM(${col}) AS avg, COUNT(*) AS n
             FROM routes
            WHERE start_time >= date('now', ?)
            GROUP BY day`,
        )
        .all(since) as { day: string; avg: number; n: number }[];

      for (const r of result) {
        rows.push({ day: r.day, metric, avg: r.avg, min: null, max: null, n: r.n, unit });
      }
    }

    if (source === "workouts") {
      const result = db
        .prepare(
          `SELECT date(start_time)   AS day,
                  SUM(duration_min)  AS avg,
                  COUNT(*)           AS n
             FROM workouts
            WHERE start_time >= date('now', ?)
            GROUP BY day`,
        )
        .all(since) as { day: string; avg: number; n: number }[];

      for (const r of result) {
        rows.push({ day: r.day, metric, avg: r.avg, min: null, max: null, n: r.n, unit });
      }
    }
  }

  return rows;
}

export type SyncResult = { rows: number; metrics: number; days: number; ms: number };

/**
 * Push to Postgres.
 *
 * Upserts on (day, metric) so re-running after a fresh import corrects a day
 * rather than duplicating it — which matters because today's numbers change all
 * day and the last sync of the night is the right one.
 */
export async function sync(
  db: Database,
  connectionString: string,
  days = 120,
): Promise<SyncResult> {
  const started = Date.now();
  const rows = buildRows(db, days);
  if (rows.length === 0) return { rows: 0, metrics: 0, days, ms: Date.now() - started };

  const sql = new SQL(connectionString);
  try {
    // Chunked: a single statement with thousands of tuples hits parameter limits
    // and is slower than several round trips.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      await sql`
        INSERT INTO health_daily ${sql(batch, "day", "metric", "avg", "min", "max", "n", "unit")}
        ON CONFLICT (day, metric) DO UPDATE SET
          avg = EXCLUDED.avg,
          min = EXCLUDED.min,
          max = EXCLUDED.max,
          n   = EXCLUDED.n,
          unit = EXCLUDED.unit,
          updated_at = now()
      `;
    }
  } finally {
    await sql.close();
  }

  return {
    rows: rows.length,
    metrics: new Set(rows.map((r) => r.metric)).size,
    days,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Draining the live buffer
// ---------------------------------------------------------------------------

export type DrainResult = { fetched: number; added: number; deleted: number };

/**
 * Pull what the watch posted to the website into the local archive.
 *
 * The direction is deliberate and worth stating, because it looks backwards. The
 * laptop is asleep whenever you are out running, so it cannot be the thing the
 * watch talks to — the website takes the writes and this collects them
 * afterwards. SQLite remains the permanent, complete store; `health_live` is a
 * buffer measured in days.
 *
 * Rows are deleted only after they are safely in SQLite, and only the exact ids
 * that were inserted. A delete-by-timestamp would race with a watch that posted
 * during the drain and silently discard those samples.
 */
export async function drain(
  db: Database,
  connectionString: string,
  batch = 5_000,
): Promise<DrainResult> {
  /**
   * Prefer a direct connection over the pooler for this one.
   *
   * Supabase's transaction pooler on 6543 reuses server connections between
   * clients, so a statement prepared during one run is still registered when the
   * next run prepares the same name — "prepared statement already exists", after
   * the insert has succeeded and before the delete. The publish path is a single
   * upsert and never trips it; a loop of identical reads does.
   */
  const sql = new SQL(connectionString);
  let fetched = 0;
  let added = 0;
  let deleted = 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO samples (type, value, unit, start_time, end_time, source, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  try {
    for (;;) {
      const rows = (await sql`
        SELECT id, type, value, unit, start_time, end_time, source, dedupe_key
          FROM health_live
         ORDER BY received_at
         LIMIT ${batch}
      `) as {
        id: string;
        type: string;
        value: number | null;
        unit: string | null;
        start_time: Date;
        end_time: Date | null;
        source: string | null;
        dedupe_key: string;
      }[];

      if (rows.length === 0) break;
      fetched += rows.length;

      const write = db.transaction((batchRows: typeof rows) => {
        for (const r of batchRows) {
          const res = insert.run(
            r.type,
            r.value,
            r.unit,
            new Date(r.start_time).toISOString(),
            r.end_time ? new Date(r.end_time).toISOString() : null,
            r.source,
            r.dedupe_key,
          );
          if (res.changes > 0) added++;
        }
      });
      write(rows);

      /**
       * By id, not by time.
       *
       * Deleting a window would take rows that arrived during the drain and
       * were never read. The ids go through `sql()` rather than being
       * interpolated directly — a bare JS array is serialised as a
       * comma-joined string, which Postgres rejects as a malformed array
       * literal after the insert has already succeeded.
       */
      const ids = rows.map((r) => r.id);
      const gone = (await sql`
        DELETE FROM health_live WHERE id IN ${sql(ids)} RETURNING id
      `) as { id: string }[];
      deleted += gone.length;

      if (rows.length < batch) break;
    }
  } finally {
    await sql.close();
  }

  return { fetched, added, deleted };
}
