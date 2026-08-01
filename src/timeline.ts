import type { Database } from "bun:sqlite";

/**
 * One chronological view of everything.
 *
 * This is what the aggregation is for. Pulling records from six providers is
 * plumbing; the reason to do it is to put a lab result, a diagnosis, a race and
 * a bad month of sleep on the same axis — which no system available today will
 * do. MyChart has the clinical half and none of the fitness. Apple Health has
 * the fitness half and almost no clinical. Epic's own aggregation reaches across
 * Epic sites and stops there.
 *
 * Events are heterogeneous by design. A diagnosis, a 10k and an ECG are not the
 * same kind of thing and should not be forced into one schema — they share only
 * a timestamp and the fact that they happened to you. So each source contributes
 * its own rows and they are merged on time alone.
 */

export type EventKind =
  | "clinical"
  | "workout"
  | "ecg"
  | "milestone"
  | "gap"
  | "device";

export type TimelineEvent = {
  at: string;
  kind: EventKind;
  title: string;
  detail: string | null;
  /** Where this came from, so a surprising entry can be traced. */
  source: string | null;
};

/**
 * Clinical resources, rendered as readable lines.
 *
 * FHIR is stored raw, so the display names are dug out with `json_extract`
 * rather than modelled into columns. Each resource type keeps its meaning
 * somewhere different, which is exactly why shredding FHIR into a table is a
 * project of its own and was declined.
 */
function clinicalEvents(db: Database, limit: number): TimelineEvent[] {
  try {
    return db
      .prepare(
        `SELECT
           COALESCE(
             json_extract(fhir, '$.effectiveDateTime'),
             json_extract(fhir, '$.onsetDateTime'),
             json_extract(fhir, '$.performedDateTime'),
             json_extract(fhir, '$.occurrenceDateTime'),
             json_extract(fhir, '$.authoredOn'),
             json_extract(fhir, '$.recordedDate'),
             json_extract(fhir, '$.date'),
             received_date
           ) AS at,
           resource_type,
           COALESCE(
             json_extract(fhir, '$.code.text'),
             json_extract(fhir, '$.code.coding[0].display'),
             json_extract(fhir, '$.medicationCodeableConcept.text'),
             json_extract(fhir, '$.vaccineCode.text'),
             resource_type
           ) AS label,
           json_extract(fhir, '$.valueQuantity.value') AS value,
           json_extract(fhir, '$.valueQuantity.unit')  AS unit,
           source
         FROM clinical
        WHERE at IS NOT NULL
        ORDER BY at DESC
        LIMIT ?`,
      )
      .all(limit)
      .map((r) => {
        const row = r as {
          at: string;
          resource_type: string;
          label: string;
          value: number | null;
          unit: string | null;
          source: string | null;
        };
        return {
          at: row.at,
          kind: "clinical" as const,
          title: row.label,
          detail:
            row.value !== null
              ? `${row.value}${row.unit ? ` ${row.unit}` : ""} · ${row.resource_type}`
              : row.resource_type,
          source: row.source,
        };
      });
  } catch {
    // No clinical table yet, or a resource shape json_extract cannot read.
    return [];
  }
}

/**
 * Workouts worth a line.
 *
 * Not all of them. Two hundred entries of "Functional Strength Training, 45
 * minutes" is a log, not a history — a timeline that includes everything is one
 * nobody reads. Only workouts that were unusually long or unusually far for you
 * appear, which is what you would actually remember.
 */
function workoutEvents(db: Database, limit: number): TimelineEvent[] {
  return db
    .prepare(
      `WITH stats AS (
         SELECT AVG(duration_min) avg_dur, AVG(distance_km) avg_dist FROM workouts
       )
       SELECT w.activity, w.start_time, w.duration_min, w.distance_km, w.source
         FROM workouts w, stats s
        WHERE w.duration_min > s.avg_dur * 1.5
           OR w.distance_km  > s.avg_dist * 1.5
        ORDER BY w.start_time DESC
        LIMIT ?`,
    )
    .all(limit)
    .map((r) => {
      const w = r as {
        activity: string;
        start_time: string;
        duration_min: number | null;
        distance_km: number | null;
        source: string | null;
      };
      const parts = [
        w.duration_min ? `${Math.round(w.duration_min)} min` : null,
        w.distance_km ? `${w.distance_km.toFixed(1)} km` : null,
      ].filter(Boolean);
      return {
        at: w.start_time,
        kind: "workout" as const,
        title: w.activity.replace(/_/g, " "),
        detail: parts.join(" · ") || null,
        source: w.source,
      };
    });
}

/** ECGs, which carry a clinical finding whoever recorded them. */
function ecgEvents(db: Database): TimelineEvent[] {
  try {
    return db
      .prepare(`SELECT recorded_at, classification, device FROM ecg ORDER BY recorded_at DESC`)
      .all()
      .map((r) => {
        const e = r as { recorded_at: string; classification: string | null; device: string | null };
        return {
          at: e.recorded_at,
          kind: "ecg" as const,
          title: `ECG — ${e.classification ?? "unclassified"}`,
          detail: e.device,
          source: e.device,
        };
      });
  } catch {
    return [];
  }
}

/**
 * The first time a metric ever appears.
 *
 * A new metric starting is almost always a real event in your life — a new
 * watch, a new device, the first time you enabled sleep tracking. Those are
 * worth marking, because they explain why a chart begins where it does rather
 * than leaving a gap that looks like missing data.
 */
function deviceEvents(db: Database): TimelineEvent[] {
  return db
    .prepare(
      `SELECT type, MIN(start_time) AS first_seen, COUNT(*) n
         FROM samples
        GROUP BY type
       HAVING n > 100
        ORDER BY first_seen`,
    )
    .all()
    .map((r) => {
      const t = r as { type: string; first_seen: string; n: number };
      return {
        at: t.first_seen,
        kind: "device" as const,
        title: `Started recording ${t.type.replace(/_/g, " ")}`,
        detail: `${t.n.toLocaleString("en-US")} readings since`,
        source: null,
      };
    });
}

/**
 * Stretches with no data at all.
 *
 * A gap is information. Three months of nothing is a watch left in a drawer, an
 * injury, or a period of life that went differently — and on a chart it is
 * indistinguishable from a flat line at zero. Naming it stops the timeline from
 * implying continuity it does not have.
 */
function gapEvents(db: Database, minDays = 21): TimelineEvent[] {
  const days = db
    .prepare(`SELECT DISTINCT date(start_time) d FROM samples ORDER BY d`)
    .all() as { d: string }[];

  const out: TimelineEvent[] = [];
  for (let i = 1; i < days.length; i++) {
    const gap = (Date.parse(days[i].d) - Date.parse(days[i - 1].d)) / 86_400_000;
    if (gap >= minDays) {
      out.push({
        at: days[i - 1].d,
        kind: "gap",
        title: `${Math.round(gap)} days with no data`,
        detail: `${days[i - 1].d} to ${days[i].d}`,
        source: null,
      });
    }
  }
  return out;
}

export type TimelineOptions = {
  limit?: number;
  kinds?: EventKind[];
  since?: string;
};

export function timeline(db: Database, opts: TimelineOptions = {}): TimelineEvent[] {
  const limit = opts.limit ?? 60;
  const want = opts.kinds ? new Set(opts.kinds) : null;
  const include = (k: EventKind) => !want || want.has(k);

  const events: TimelineEvent[] = [
    ...(include("clinical") ? clinicalEvents(db, limit) : []),
    ...(include("workout") ? workoutEvents(db, limit) : []),
    ...(include("ecg") ? ecgEvents(db) : []),
    ...(include("device") ? deviceEvents(db) : []),
    ...(include("gap") ? gapEvents(db) : []),
  ];

  return events
    .filter((e) => e.at && (!opts.since || e.at >= opts.since))
    // Newest first: a medical history is read backwards from now.
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
