import type { Database } from "bun:sqlite";

/**
 * Reads.
 *
 * Every query here is aggregated. Nothing returns raw samples, because raw
 * samples are millions of rows and no consumer of this — a terminal chart, a
 * dashboard, a sync job — wants them. Aggregating in SQL rather than in
 * JavaScript keeps the row count small at the boundary instead of after it.
 */

export type Summary = {
  samples: number;
  sleepNights: number;
  workouts: number;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  topTypes: { type: string; n: number }[];
};

export function summary(db: Database): Summary {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;

  const { n: samples } = one<{ n: number }>(`SELECT COUNT(*) AS n FROM samples`);
  const { n: workouts } = one<{ n: number }>(`SELECT COUNT(*) AS n FROM workouts`);
  const { n: days } = one<{ n: number }>(`SELECT COUNT(*) AS n FROM daily`);
  // Nights, not records: Apple emits one row per stage transition, so a single
  // night is dozens of rows and counting them would be meaningless.
  const { n: sleepNights } = one<{ n: number }>(
    `SELECT COUNT(DISTINCT date(start_time)) AS n FROM sleep`,
  );
  const range = one<{ first: string | null; last: string | null }>(
    `SELECT MIN(date(start_time)) AS first, MAX(date(start_time)) AS last FROM samples`,
  );

  const topTypes = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM samples GROUP BY type ORDER BY n DESC LIMIT 8`,
    )
    .all() as { type: string; n: number }[];

  return {
    samples,
    sleepNights,
    workouts,
    days,
    firstDay: range.first,
    lastDay: range.last,
    topTypes,
  };
}

export type TrendPoint = { day: string; avg: number; min: number; max: number; n: number };

/**
 * Daily aggregate of one metric.
 *
 * Grouped by UTC day because that is what `start_time` is stored in. For a
 * dashboard read by the person who generated the data this is close enough to
 * their local day; a per-timezone rollup would need the offset preserved per
 * record, which the export does not reliably give.
 */
export function trend(db: Database, type: string, days = 30): TrendPoint[] {
  return db
    .prepare(
      `SELECT date(start_time)          AS day,
              AVG(value)                AS avg,
              MIN(value)                AS min,
              MAX(value)                AS max,
              COUNT(*)                  AS n
         FROM samples
        WHERE type = ?
          AND value IS NOT NULL
          AND start_time >= date('now', ?)
        GROUP BY day
        ORDER BY day`,
    )
    .all(type, `-${days} days`) as TrendPoint[];
}

/** Most recent value of a metric, for a "right now" panel. */
export function latest(
  db: Database,
  type: string,
): { value: number; unit: string | null; at: string } | null {
  return (
    (db
      .prepare(
        `SELECT value, unit, start_time AS at
           FROM samples
          WHERE type = ? AND value IS NOT NULL
          ORDER BY start_time DESC
          LIMIT 1`,
      )
      .get(type) as { value: number; unit: string | null; at: string } | null) ?? null
  );
}

export type RecentWorkout = {
  activity: string;
  start_time: string;
  duration_min: number | null;
};

export function recent(db: Database, limit = 10): RecentWorkout[] {
  return db
    .prepare(
      `SELECT activity, start_time, duration_min
         FROM workouts
        ORDER BY start_time DESC
        LIMIT ?`,
    )
    .all(limit) as RecentWorkout[];
}

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

/**
 * Sleep per night, in hours.
 *
 * Apple records overlapping stage intervals, and `in_bed` spans the asleep
 * stages — summing every row double-counts and produces eleven-hour nights.
 * Only the asleep stages are counted, and `in_bed` is excluded entirely.
 */
export function sleepByNight(db: Database, days = 30): { day: string; hours: number }[] {
  return db
    .prepare(
      `SELECT ${SLEEP_NIGHT}         AS day,
              SUM(minutes) / 60.0   AS hours
         FROM sleep
        WHERE stage IN ('core', 'deep', 'rem', 'asleep')
          AND start_time >= date('now', ?)
        GROUP BY day
        ORDER BY day`,
    )
    .all(`-${days} days`) as { day: string; hours: number }[];
}
