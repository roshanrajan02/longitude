import type { Database } from "bun:sqlite";
import {
  isSleep,
  scanChunk,
  toClinical,
  toDaily,
  toSample,
  toSleep,
  toWorkout,
  type ClinicalRow,
  type DailyRow,
  type SampleRow,
  type SleepRow,
  type WorkoutRow,
} from "./parse";

/**
 * Loading an Apple Health export into the database.
 *
 * The file is read in chunks and written in batched transactions. Both halves
 * matter: an 839 MB read would exhaust memory, and two million individual
 * `INSERT`s outside a transaction means two million fsyncs.
 *
 * The import is idempotent. Every row carries a dedupe key derived from what the
 * record is, and inserts use `INSERT OR IGNORE`, so re-running against a newer
 * export that overlaps the last one adds only what is genuinely new. That is not
 * a nicety — Apple exports are cumulative, so the second import you ever run
 * would otherwise double your data.
 */

/**
 * How much file to hold in memory at once.
 *
 * 16 MB is large enough that the per-chunk overhead disappears and small enough
 * to stay well clear of the heap. The parser hands back any partial tag at the
 * boundary, so chunk size never affects correctness — only speed.
 */
const CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Rows per transaction.
 *
 * Batched because a commit is the expensive part. Too small and fsync dominates;
 * too large and a failure mid-import rolls back more work than it needs to.
 */
const BATCH = 20_000;

export type ImportProgress = {
  bytesRead: number;
  totalBytes: number;
  samples: number;
  sleep: number;
  workouts: number;
  daily: number;
  skipped: number;
};

export type ImportResult = ImportProgress & {
  ms: number;
  importId: number;
  types: Record<string, number>;
  /** Referenced clinical resources, for the caller to load from disk. */
  clinical: ClinicalRow[];
};

/** Prepared once and reused for every row — re-preparing per insert is the slow path. */
function statements(db: Database) {
  return {
    sample: db.prepare(
      `INSERT OR IGNORE INTO samples (type, value, unit, start_time, end_time, source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    sleep: db.prepare(
      `INSERT OR IGNORE INTO sleep (stage, start_time, end_time, minutes, source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    workout: db.prepare(
      `INSERT OR IGNORE INTO workouts (activity, start_time, end_time, duration_min, distance_km, energy_kcal, source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    /**
     * Daily rows are upserted rather than ignored.
     *
     * Unlike a sample, a day's totals change as the day goes on — an export taken
     * at noon and one taken at midnight disagree about the same date, and the
     * later one is right. `INSERT OR IGNORE` would keep the noon figure forever.
     */
    daily: db.prepare(
      `INSERT INTO daily (date, active_energy_kcal, move_goal_kcal, exercise_minutes, stand_hours)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         active_energy_kcal = excluded.active_energy_kcal,
         move_goal_kcal     = excluded.move_goal_kcal,
         exercise_minutes   = excluded.exercise_minutes,
         stand_hours        = excluded.stand_hours`,
    ),
  };
}

type Pending = {
  samples: SampleRow[];
  sleep: SleepRow[];
  workouts: WorkoutRow[];
  daily: DailyRow[];
};

const emptyPending = (): Pending => ({ samples: [], sleep: [], workouts: [], daily: [] });

export async function importExport(
  db: Database,
  filePath: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const started = Date.now();
  const file = Bun.file(filePath);
  const totalBytes = file.size;

  if (totalBytes === 0) throw new Error(`empty or missing file: ${filePath}`);

  const startedAt = new Date().toISOString();
  const importRow = db
    .prepare(`INSERT INTO imports (source, file, started_at) VALUES (?, ?, ?) RETURNING id`)
    .get("apple_health_export", filePath, startedAt) as { id: number };

  const st = statements(db);
  const counts = { samples: 0, sleep: 0, workouts: 0, daily: 0, skipped: 0 };
  const types: Record<string, number> = {};
  // Collected rather than inserted: each one names a JSON file that has to be
  // read from the export directory, which the importer does not know about.
  const clinical: ClinicalRow[] = [];

  /**
   * One transaction per batch.
   *
   * `db.transaction` returns a function; calling it runs the body inside BEGIN
   * and COMMIT. `changes` tells us whether OR IGNORE actually inserted, which is
   * how duplicates are counted rather than guessed at.
   */
  const flush = db.transaction((p: Pending) => {
    for (const r of p.samples) {
      const res = st.sample.run(
        r.type,
        r.value,
        r.unit,
        r.start_time,
        r.end_time,
        r.source,
        r.dedupe_key,
      );
      if (res.changes > 0) {
        counts.samples++;
        types[r.type] = (types[r.type] ?? 0) + 1;
      } else counts.skipped++;
    }
    for (const r of p.sleep) {
      const res = st.sleep.run(
        r.stage,
        r.start_time,
        r.end_time,
        r.minutes,
        r.source,
        r.dedupe_key,
      );
      res.changes > 0 ? counts.sleep++ : counts.skipped++;
    }
    for (const r of p.workouts) {
      const res = st.workout.run(
        r.activity,
        r.start_time,
        r.end_time,
        r.duration_min,
        r.distance_km,
        r.energy_kcal,
        r.source,
        r.dedupe_key,
      );
      res.changes > 0 ? counts.workouts++ : counts.skipped++;
    }
    for (const r of p.daily) {
      st.daily.run(
        r.date,
        r.active_energy_kcal,
        r.move_goal_kcal,
        r.exercise_minutes,
        r.stand_hours,
      );
      counts.daily++;
    }
  });

  let pending = emptyPending();
  let pendingCount = 0;
  let carry = "";
  let bytesRead = 0;

  const stream = file.stream();
  const decoder = new TextDecoder("utf-8");

  for await (const bytes of stream as unknown as AsyncIterable<Uint8Array>) {
    bytesRead += bytes.byteLength;

    // `stream: true` so a multi-byte character split across a chunk boundary is
    // buffered rather than turned into a replacement character. Names and device
    // strings contain them — "Roshan’s Apple Watch" has a curly apostrophe.
    const text = carry + decoder.decode(bytes, { stream: true });
    const { elements, rest } = scanChunk(text);
    carry = rest;

    for (const el of elements) {
      if (el.name === "ClinicalRecord") {
        const c = toClinical(el.attrs);
        if (c) clinical.push(c);
        else counts.skipped++;
      } else if (el.name === "Workout") {
        const w = toWorkout(el.attrs);
        if (w) pending.workouts.push(w);
        else counts.skipped++;
      } else if (el.name === "ActivitySummary") {
        const d = toDaily(el.attrs);
        if (d) pending.daily.push(d);
        else counts.skipped++;
      } else if (isSleep(el.attrs)) {
        const s = toSleep(el.attrs);
        if (s) pending.sleep.push(s);
        else counts.skipped++;
      } else {
        const s = toSample(el.attrs);
        if (s) pending.samples.push(s);
        else counts.skipped++;
      }
      pendingCount++;
    }

    if (pendingCount >= BATCH) {
      flush(pending);
      pending = emptyPending();
      pendingCount = 0;
      onProgress?.({ bytesRead, totalBytes, ...counts });
    }

    if (bytesRead % (CHUNK_BYTES * 4) === 0) onProgress?.({ bytesRead, totalBytes, ...counts });
  }

  // Whatever the last chunk left behind. Without this the final record of the
  // file is lost, which is the sort of thing nobody notices for a year.
  const tail = carry + decoder.decode();
  if (tail) {
    const { elements } = scanChunk(tail);
    for (const el of elements) {
      if (el.name === "ClinicalRecord") {
        const c = toClinical(el.attrs);
        if (c) clinical.push(c);
      } else if (el.name === "Workout") {
        const w = toWorkout(el.attrs);
        if (w) pending.workouts.push(w);
      } else if (el.name === "ActivitySummary") {
        const d = toDaily(el.attrs);
        if (d) pending.daily.push(d);
      } else if (isSleep(el.attrs)) {
        const s = toSleep(el.attrs);
        if (s) pending.sleep.push(s);
      } else {
        const s = toSample(el.attrs);
        if (s) pending.samples.push(s);
      }
    }
  }
  flush(pending);

  const ms = Date.now() - started;
  const added = counts.samples + counts.sleep + counts.workouts + counts.daily;

  db.prepare(
    `UPDATE imports SET finished_at = ?, rows_added = ?, rows_skipped = ?, notes = ? WHERE id = ?`,
  ).run(new Date().toISOString(), added, counts.skipped, `${ms}ms`, importRow.id);

  onProgress?.({ bytesRead, totalBytes, ...counts });

  return { bytesRead, totalBytes, ...counts, ms, importId: importRow.id, types, clinical };
}
