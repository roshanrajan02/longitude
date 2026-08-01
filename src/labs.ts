import type { Database } from "bun:sqlite";
import { dedupeKey } from "./parse";

/**
 * Lab results, normalised out of wherever they arrived.
 *
 * The same fact reaches you three ways — a FHIR Observation, a row in a C-CDA
 * table, a line of text in a PDF — and none is queryable in the form it comes
 * in. A JSON blob cannot be charted and neither can a sentence.
 *
 * This is the layer that makes the crossover possible. Asking whether a lab
 * value moved before or after a change in resting heart rate needs both sides to
 * be rows with a value and a date.
 */

export type Lab = {
  name: string;
  slug: string;
  loinc: string | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  abnormal: string | null;
  takenAt: string;
  origin: "fhir" | "ccda" | "document";
  source: string | null;
  documentId?: number | null;
};

/**
 * A stable name for grouping.
 *
 * The same test is reported as "Hemoglobin A1c", "HbA1c", "Hgb A1c" and
 * "Glycated hemoglobin" by four different labs. Charting a trend means deciding
 * those are one series, and there is no authority that will tell you so — LOINC
 * codes would, but most of what is retrievable carries none.
 */
const ALIASES: Record<string, string> = {
  hba1c: "hemoglobin_a1c",
  "hgb a1c": "hemoglobin_a1c",
  "glycated hemoglobin": "hemoglobin_a1c",
  "hemoglobin a1c": "hemoglobin_a1c",
  "a1c": "hemoglobin_a1c",
  hgb: "hemoglobin",
  hct: "hematocrit",
  "wbc": "white_blood_cell_count",
  "rbc": "red_blood_cell_count",
  "ldl-c": "ldl_cholesterol",
  "ldl": "ldl_cholesterol",
  "hdl-c": "hdl_cholesterol",
  "hdl": "hdl_cholesterol",
  "tsh": "thyroid_stimulating_hormone",
  "egfr": "egfr",
  "alt (sgpt)": "alt",
  "ast (sgot)": "ast",
  "vitamin d, 25-hydroxy": "vitamin_d",
  "25-hydroxyvitamin d": "vitamin_d",
  "crp": "c_reactive_protein",
  "hs-crp": "c_reactive_protein",
};

export function slugify(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/\s*\[[^\]]*\]\s*/g, " ") // LOINC long names carry [Mass/volume]
    .replace(/\s+in\s+(serum|plasma|blood|urine).*$/i, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (ALIASES[clean]) return ALIASES[clean];
  return clean.replace(/[\s-]+/g, "_");
}

// ---------------------------------------------------------------------------
// From FHIR
// ---------------------------------------------------------------------------

/**
 * A lab out of a FHIR Observation.
 *
 * Returns null for anything that is not a quantitative result — vitals recorded
 * as Observations, panels that only group their members, and Observations whose
 * value is a code. Storing those as labs would put "blood pressure panel" on a
 * chart with no number attached.
 */
export function labFromObservation(
  obs: Record<string, unknown>,
  source: string | null,
): Lab | null {
  const code = obs.code as
    | { text?: string; coding?: { system?: string; code?: string; display?: string }[] }
    | undefined;

  const loincCoding = code?.coding?.find((c) => (c.system ?? "").includes("loinc"));
  const name = code?.text ?? loincCoding?.display ?? code?.coding?.[0]?.display;
  if (!name) return null;

  const takenAt =
    (obs.effectiveDateTime as string | undefined) ??
    (obs.effectiveInstant as string | undefined) ??
    (obs.issued as string | undefined) ??
    ((obs.effectivePeriod as { start?: string } | undefined)?.start);
  if (!takenAt) return null;

  const qty = obs.valueQuantity as { value?: number; unit?: string } | undefined;
  const valueText =
    (obs.valueString as string | undefined) ??
    (obs.valueCodeableConcept as { text?: string } | undefined)?.text ??
    null;

  // Nothing measurable and nothing said: a grouping Observation.
  if (qty?.value === undefined && !valueText) return null;

  const ref = (obs.referenceRange as { low?: { value?: number }; high?: { value?: number } }[] | undefined)?.[0];
  const interp = (obs.interpretation as { coding?: { code?: string }[] }[] | undefined)?.[0]
    ?.coding?.[0]?.code;

  return {
    name,
    slug: slugify(name),
    loinc: loincCoding?.code ?? null,
    value: qty?.value ?? null,
    valueText,
    unit: qty?.unit ?? null,
    refLow: ref?.low?.value ?? null,
    refHigh: ref?.high?.value ?? null,
    abnormal: interp === "H" || interp === "L" ? interp : null,
    takenAt: new Date(takenAt).toISOString(),
    origin: "fhir",
    source,
  };
}

// ---------------------------------------------------------------------------
// From text
// ---------------------------------------------------------------------------

/**
 * Lab values out of prose or a table rendered as text.
 *
 * Deliberately conservative. A lab report is mostly not lab values — it carries
 * addresses, phone numbers, accession numbers, dates and dosages, all of which
 * are a word next to a number. Matching loosely produces a chart of the
 * practice's fax number over time.
 *
 * So: the name must look like a test name, the unit must be a unit that labs
 * actually use, and both must be adjacent. That misses unusual tests and is the
 * right trade — a missing value is visible, a wrong one is not.
 */
const UNITS = [
  "mg/dL", "g/dL", "mmol/L", "mEq/L", "ng/mL", "pg/mL", "µg/dL", "ug/dL",
  "IU/L", "U/L", "mIU/L", "%", "K/uL", "M/uL", "10\\^3/uL", "10\\^6/uL",
  "mL/min", "mL/min/1.73", "fL", "pg", "mm/hr", "mg/L", "umol/L", "nmol/L",
];

const UNIT_RE = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

export function labsFromText(
  text: string,
  takenAt: string,
  source: string | null,
  documentId?: number,
): Lab[] {
  const out: Lab[] = [];
  const seen = new Set<string>();

  /**
   * name, value, unit — with an optional flag and reference range after.
   *
   * The name is bounded to a few words and must start with a letter, which
   * rejects "Accession 12345678" and "Phone 555 1234 x2". The value must be a
   * plain number, which rejects dates.
   */
  const re = new RegExp(
    String.raw`([A-Za-z][A-Za-z0-9 ,\-\(\)/]{1,38}?)\s*[:\t ]\s*` +
      String.raw`(<|>)?\s*(\d+(?:\.\d+)?)\s*` +
      `(${UNIT_RE})` +
      /**
       * The abnormal flag, on this line only and as a whole word.
       *
       * `\s*` crossed newlines and swallowed the first letter of the next test:
       * "Creatinine 0.9 mg/dL\nHemoglobin A1c" produced a creatinine flagged H
       * and a test called "emoglobin a1c". Word boundaries stop `H` matching
       * inside "Hemoglobin", and `[ \t]` keeps it on the line it belongs to.
       */
      String.raw`(?:[ \t]*\(?\b([HL])\b\)?)?` +
      String.raw`(?:[ \t]*(?:ref|reference)?[ \t]*[:\(]?[ \t]*(\d+(?:\.\d+)?)[ \t]*[-–][ \t]*(\d+(?:\.\d+)?)[ \t]*\)?)?`,
    "gi",
  );

  for (const m of text.matchAll(re)) {
    const rawName = m[1].trim().replace(/[,\s]+$/, "");
    // A name that is mostly digits is an identifier, not a test.
    if (!/[a-z]{3}/i.test(rawName)) continue;
    // Common false friends: dosages and vitals written the same way.
    if (/\b(tablet|capsule|daily|nightly|dose|mg po|refill)\b/i.test(rawName)) continue;

    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;

    const slug = slugify(rawName);
    // The same value repeated in a summary and a table is one result.
    const key = `${slug}|${value}|${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name: rawName,
      slug,
      loinc: null,
      value,
      valueText: m[2] ? `${m[2]}${value}` : null,
      unit: m[4],
      refLow: m[6] ? Number(m[6]) : null,
      refHigh: m[7] ? Number(m[7]) : null,
      abnormal: m[5] ? m[5].toUpperCase() : null,
      takenAt,
      origin: "document",
      source,
      documentId: documentId ?? null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function storeLabs(db: Database, labs: Lab[]): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO labs
       (name, slug, loinc, value, value_text, unit, ref_low, ref_high, abnormal,
        taken_at, origin, source, document_id, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let added = 0;
  const work = db.transaction((batch: Lab[]) => {
    for (const l of batch) {
      /**
       * Identity is the test, the instant and the value — not the source.
       *
       * The same result arrives from the provider as FHIR and from a payer as a
       * claim attachment. Keying on source would store it twice and a chart
       * would show two points where one measurement happened.
       */
      const res = insert.run(
        l.name,
        l.slug,
        l.loinc,
        l.value,
        l.valueText,
        l.unit,
        l.refLow,
        l.refHigh,
        l.abnormal,
        l.takenAt,
        l.origin,
        l.source,
        l.documentId ?? null,
        dedupeKey([l.slug, l.takenAt, l.value ?? l.valueText]),
      );
      if (res.changes > 0) added++;
    }
  });

  work(labs);
  return added;
}

/** One test over time, which is the only way a lab value means anything. */
export function labSeries(db: Database, slug: string) {
  return db
    .prepare(
      `SELECT taken_at, value, unit, ref_low, ref_high, abnormal, origin, source
         FROM labs WHERE slug = ? AND value IS NOT NULL
        ORDER BY taken_at`,
    )
    .all(slug) as {
    taken_at: string;
    value: number;
    unit: string | null;
    ref_low: number | null;
    ref_high: number | null;
    abnormal: string | null;
    origin: string;
    source: string | null;
  }[];
}

export function labSummary(db: Database) {
  return db
    .prepare(
      `SELECT slug, name, COUNT(*) n,
              MIN(taken_at) first_seen, MAX(taken_at) last_seen,
              SUM(CASE WHEN abnormal IS NOT NULL THEN 1 ELSE 0 END) flagged
         FROM labs GROUP BY slug ORDER BY n DESC, slug`,
    )
    .all() as {
    slug: string;
    name: string;
    n: number;
    first_seen: string;
    last_seen: string;
    flagged: number;
  }[];
}
