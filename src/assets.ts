import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { dedupeKey, toIso } from "./parse";

/**
 * The parts of an export that are not `export.xml`.
 *
 * Apple ships GPS tracks as GPX files and electrocardiograms as CSVs, in
 * directories alongside the main file. Neither is mentioned in `export.xml` at
 * all, so an importer that reads only that file silently ignores every outdoor
 * route and every ECG — which in this export is 122 workouts' worth of distance
 * and elevation, and four cardiac recordings.
 */

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type TrackPoint = { lat: number; lon: number; ele: number | null; time: string };

/**
 * Pull track points out of a GPX file.
 *
 * Attribute order is fixed by Apple's exporter, but reading them by name costs
 * nothing and survives a change. Elevation and time are child elements rather
 * than attributes.
 */
export function parseGpx(xml: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  const re = /<trkpt\s+([^>]*)>([\s\S]*?)<\/trkpt>/g;

  for (const m of xml.matchAll(re)) {
    const attrs = m[1];
    const body = m[2];
    const lat = Number(attrs.match(/lat="([^"]+)"/)?.[1]);
    const lon = Number(attrs.match(/lon="([^"]+)"/)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleRaw = body.match(/<ele>([^<]+)<\/ele>/)?.[1];
    const time = body.match(/<time>([^<]+)<\/time>/)?.[1];
    if (!time) continue;

    points.push({
      lat,
      lon,
      ele: eleRaw !== undefined ? Number(eleRaw) : null,
      time,
    });
  }

  return points;
}

/** Metres between two coordinates, on a sphere. */
export function haversine(a: TrackPoint, b: TrackPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Elevation gained, ignoring GPS jitter.
 *
 * Barometric altitude wanders by a metre or two while standing still, and
 * summing every positive difference turns a flat run into hundreds of metres of
 * climb. Only rises past a threshold count, which is what every GPS watch does
 * internally and why their numbers look sane.
 */
const CLIMB_THRESHOLD_M = 1.0;

export type RouteSummary = {
  start_time: string;
  end_time: string | null;
  distance_km: number;
  elevation_gain_m: number;
  point_count: number;
};

export function summarizeRoute(points: TrackPoint[]): RouteSummary | null {
  if (points.length < 2) return null;

  let metres = 0;
  let climb = 0;
  let lastEle = points[0].ele;

  for (let i = 1; i < points.length; i++) {
    metres += haversine(points[i - 1], points[i]);

    const ele = points[i].ele;
    if (ele !== null && lastEle !== null) {
      const rise = ele - lastEle;
      if (rise > CLIMB_THRESHOLD_M) {
        climb += rise;
        lastEle = ele;
      } else if (rise < -CLIMB_THRESHOLD_M) {
        lastEle = ele;
      }
      // Within the threshold: leave lastEle alone, so slow real climbs still
      // accumulate rather than being repeatedly discarded.
    } else if (ele !== null) {
      lastEle = ele;
    }
  }

  return {
    start_time: new Date(points[0].time).toISOString(),
    end_time: new Date(points[points.length - 1].time).toISOString(),
    distance_km: metres / 1000,
    elevation_gain_m: climb,
    point_count: points.length,
  };
}

export type RouteImportResult = { files: number; added: number; linked: number };

/**
 * Import every GPX file in a directory, and attach each to its workout.
 *
 * Matched by overlapping time rather than by name — the filenames carry a local
 * timestamp rounded to the minute, which is not enough to identify a workout and
 * would break for anyone in a different timezone. Overlap is unambiguous: two
 * workouts do not run at once.
 */
export async function importRoutes(
  db: Database,
  dir: string,
): Promise<RouteImportResult> {
  let files = 0;
  let added = 0;
  let linked = 0;

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".gpx"));
  } catch {
    return { files: 0, added: 0, linked: 0 };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO routes
       (workout_id, start_time, end_time, distance_km, elevation_gain_m, point_count, file, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /**
   * A route lies inside its workout's window, give or take GPS warm-up.
   *
   * Both sides are passed through `datetime()`. SQLite renders it as
   * "YYYY-MM-DD HH:MM:SS" while the parameter is a full ISO string with a T and
   * a Z, and comparing those as text fails on the very first character that
   * differs — which matched 7 routes out of 122 and looked like a data problem
   * rather than a formatting one.
   */
  const findWorkout = db.prepare(
    `SELECT id FROM workouts
      WHERE datetime(start_time, '-5 minutes') <= datetime(?)
        AND datetime(COALESCE(end_time, start_time), '+5 minutes') >= datetime(?)
      ORDER BY start_time DESC LIMIT 1`,
  );

  const updateWorkout = db.prepare(
    `UPDATE workouts SET distance_km = ? WHERE id = ? AND distance_km IS NULL`,
  );

  const work = db.transaction((batch: string[]) => {
    for (const name of batch) {
      const xml = require("node:fs").readFileSync(join(dir, name), "utf8");
      const summary = summarizeRoute(parseGpx(xml));
      files++;
      if (!summary) continue;

      const match = findWorkout.get(summary.start_time, summary.start_time) as
        | { id: number }
        | undefined;

      const res = insert.run(
        match?.id ?? null,
        summary.start_time,
        summary.end_time,
        summary.distance_km,
        summary.elevation_gain_m,
        summary.point_count,
        basename(name),
        dedupeKey(["route", summary.start_time, summary.point_count]),
      );
      if (res.changes > 0) added++;

      if (match) {
        // Fill the distance the main export leaves empty. Only when null, so a
        // figure Apple did provide is never overwritten by a GPS estimate.
        const upd = updateWorkout.run(summary.distance_km, match.id);
        if (upd.changes > 0) linked++;
      }
    }
  });

  work(names);
  return { files, added, linked };
}

// ---------------------------------------------------------------------------
// Electrocardiograms
// ---------------------------------------------------------------------------

export type Ecg = {
  recorded_at: string;
  classification: string | null;
  symptoms: string | null;
  device: string | null;
  sample_rate_hz: number | null;
  duration_s: number | null;
  waveform: number[];
};

/**
 * Parse one of Apple's ECG CSVs.
 *
 * The file is a metadata block of `key,value` lines, a blank line, a lead
 * header, then one microvolt reading per line. Values are quoted when they
 * contain a comma — "Jan 8, 2002" — so the split has to respect quoting.
 */
export function parseEcg(csv: string): Ecg | null {
  const lines = csv.split(/\r?\n/);
  const meta = new Map<string, string>();
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    // A bare number means the metadata block has ended and readings have begun.
    if (/^-?\d+(\.\d+)?$/.test(line.trim())) break;

    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const key = line.slice(0, comma).trim();
    let value = line.slice(comma + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    meta.set(key, value);
  }

  const waveform: number[] = [];
  for (; i < lines.length; i++) {
    const v = lines[i].trim();
    if (v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) waveform.push(n);
  }

  const recorded = meta.get("Recorded Date");
  const iso = recorded ? (toIso(recorded) ?? new Date(recorded).toISOString()) : null;
  if (!iso || Number.isNaN(Date.parse(iso))) return null;

  const rate = Number(meta.get("Sample Rate")?.replace(/[^\d.]/g, "")) || null;

  return {
    recorded_at: iso,
    classification: meta.get("Classification") ?? null,
    symptoms: meta.get("Symptoms") || null,
    device: meta.get("Device") ?? null,
    sample_rate_hz: rate,
    duration_s: rate ? waveform.length / rate : null,
    waveform,
  };
}

export async function importEcgs(
  db: Database,
  dir: string,
): Promise<{ files: number; added: number }> {
  let files = 0;
  let added = 0;

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".csv"));
  } catch {
    return { files: 0, added: 0 };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ecg
       (recorded_at, classification, symptoms, device, sample_rate_hz, duration_s, waveform, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const work = db.transaction((batch: string[]) => {
    for (const name of batch) {
      files++;
      const parsed = parseEcg(require("node:fs").readFileSync(join(dir, name), "utf8"));
      if (!parsed) continue;

      const res = insert.run(
        parsed.recorded_at,
        parsed.classification,
        parsed.symptoms,
        parsed.device,
        parsed.sample_rate_hz,
        parsed.duration_s,
        JSON.stringify(parsed.waveform),
        dedupeKey(["ecg", parsed.recorded_at]),
      );
      if (res.changes > 0) added++;
    }
  });

  work(names);
  return { files, added };
}
