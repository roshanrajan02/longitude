/**
 * Parsing Apple's Health export.
 *
 * The export is one XML file, and on a phone with a few years of history it is
 * roughly a gigabyte — 839 MB and ~2 million records for the file this was
 * written against. That single fact decides the design: it cannot be read into
 * memory, so there is no DOM, no `XMLParser`, no `readFile`. The file is streamed
 * and elements are recognised as they go past.
 *
 * Everything here is pure. The scanner takes a string and returns elements; the
 * mapping functions take an element and return a row. Nothing touches the disk
 * or the database, so the tricky parts — quote handling, timezone conversion,
 * dedupe keys — can be tested against fixtures rather than against a 839 MB
 * file.
 */

export type Element = {
  name: "Record" | "Workout" | "ActivitySummary" | "ClinicalRecord";
  attrs: Record<string, string>;
};

/**
 * Elements worth stopping for. Correlation, Audiogram and the rest are ignored.
 *
 * `ClinicalRecord` is here even though most exports contain none. It appears
 * only once Health Records is linked to a provider in the Health app — and when
 * it does, it is the cross-provider route to clinical data that Epic's own API
 * cannot give you, because each health system runs a separate Epic instance
 * behind a separate login.
 */
const WANTED = ["Record", "Workout", "ActivitySummary", "ClinicalRecord"] as const;

/** So a chunk ending mid-name can be recognised as undecidable, not ignored. */
const LONGEST_NAME = Math.max(...WANTED.map((w) => w.length));

/**
 * Decode the five XML entities Apple emits.
 *
 * `&amp;` is done last. Decoding it first would turn `&amp;lt;` into `&lt;` and
 * then into `<`, corrupting any device string that legitimately contained an
 * escaped entity.
 */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Read attributes from the inside of a start tag.
 *
 * Scanned rather than split on whitespace, because attribute values contain
 * spaces, `=`, and `>` — the `device` attribute is a whole serialised object:
 *
 *   device="&lt;&lt;HKDevice: 0x…&gt;, name:Apple Watch, manufacturer:Apple Inc.…"
 *
 * Splitting on any of those characters produces garbage that still looks
 * plausible, which is the worst kind of parser bug.
 */
export function parseAttrs(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    attrs[m[1]] = unescapeXml(m[2]);
  }
  return attrs;
}

/**
 * Find start tags in a chunk, returning anything left over.
 *
 * The remainder matters. A 64 MB read will almost always end mid-tag, and a
 * parser that ignored that would silently drop one record per chunk — about
 * thirty records over a full import, which is small enough never to be noticed
 * and large enough to make the data wrong.
 *
 * Tag ends are found by scanning for `>` outside quotes, since `>` appears
 * inside attribute values.
 */
export function scanChunk(chunk: string): { elements: Element[]; rest: string } {
  const elements: Element[] = [];
  let i = 0;

  while (i < chunk.length) {
    const lt = chunk.indexOf("<", i);
    if (lt === -1) {
      // No tag start left; keep nothing but a possible partial entity.
      return { elements, rest: "" };
    }

    // Which element is this, if any?
    let name: Element["name"] | null = null;
    for (const w of WANTED) {
      // The following character must not be a name character, or `<Record` would
      // also match a hypothetical `<RecordSet`.
      const after = chunk[lt + 1 + w.length];
      if (chunk.startsWith(w, lt + 1) && (after === " " || after === "\t" || after === "\n")) {
        name = w;
        break;
      }
    }

    if (!name) {
      /**
       * Too few characters left to tell what this tag is.
       *
       * A chunk ending `<Reco` matches nothing, and skipping past it silently
       * drops that record — the property test splitting a document at every
       * offset is what surfaced this. Held back for the next read instead.
       */
      if (chunk.length - lt < LONGEST_NAME + 2) {
        return { elements, rest: chunk.slice(lt) };
      }
      i = lt + 1;
      continue;
    }

    // Walk to the tag's closing `>`, ignoring any inside a quoted value.
    let j = lt + 1 + name.length;
    let quoted = false;
    let end = -1;
    while (j < chunk.length) {
      const c = chunk[j];
      if (c === '"') quoted = !quoted;
      else if (c === ">" && !quoted) {
        end = j;
        break;
      }
      j++;
    }

    // Tag is cut off by the chunk boundary — hand it to the next read.
    if (end === -1) return { elements, rest: chunk.slice(lt) };

    elements.push({
      name,
      attrs: parseAttrs(chunk.slice(lt + 1 + name.length, end)),
    });
    i = end + 1;
  }

  return { elements, rest: "" };
}

/**
 * Apple's timestamps to ISO 8601 UTC.
 *
 * The export writes `2021-01-08 09:05:42 -0700`, which is not ISO and which
 * `new Date()` parses inconsistently across engines. Converting to UTC at the
 * boundary means every comparison downstream is between two instants rather than
 * between two wall clocks in different offsets — the alternative silently
 * reorders records around a daylight-saving change or a flight.
 */
export function toIso(appleDate: string): string | null {
  const m = appleDate.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/,
  );
  if (!m) return null;

  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const offsetMin = (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1);
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60_000;
  return new Date(utc).toISOString();
}

/**
 * `HKQuantityTypeIdentifierHeartRate` → `heart_rate`.
 *
 * Raw identifiers are unreadable in a dashboard config, and the prefixes carry
 * no information — every record has one.
 */
export function normalizeType(type: string): string {
  return type
    .replace(/^HK(Quantity|Category|Characteristic|Correlation)TypeIdentifier/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** `HKWorkoutActivityTypeFunctionalStrengthTraining` → `functional_strength_training`. */
export function normalizeActivity(activity: string): string {
  return normalizeType(activity.replace(/^HKWorkoutActivityType/, ""));
}

/**
 * `HKCategoryValueSleepAnalysisAsleepDeep` → `deep`.
 *
 * Apple emits overlapping records per stage, and older iOS versions only ever
 * said `InBed` and `Asleep`. Both vocabularies are mapped so a multi-year export
 * does not end up with two names for the same thing.
 */
export function normalizeSleepStage(value: string): string {
  const v = value.replace(/^HKCategoryValueSleepAnalysis/, "");
  const map: Record<string, string> = {
    InBed: "in_bed",
    Asleep: "asleep",
    AsleepUnspecified: "asleep",
    AsleepCore: "core",
    AsleepDeep: "deep",
    AsleepREM: "rem",
    Awake: "awake",
  };
  return map[v] ?? normalizeType(v);
}

/**
 * A stable identity for a record, so re-importing overlapping exports is safe.
 *
 * Exports overlap by design — you export again in six months and the new file
 * repeats everything. The natural key is what the record *is*: its type, when it
 * happened, its value and where it came from. Two genuinely distinct readings
 * never share all four.
 *
 * Deliberately not the file offset or a row number, which change between exports
 * and would make every re-import a full duplicate.
 */
export function dedupeKey(parts: (string | number | null | undefined)[]): string {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
}

export type SampleRow = {
  type: string;
  value: number | null;
  unit: string | null;
  start_time: string;
  end_time: string | null;
  source: string | null;
  dedupe_key: string;
};

export type WorkoutRow = {
  activity: string;
  start_time: string;
  end_time: string | null;
  duration_min: number | null;
  distance_km: number | null;
  energy_kcal: number | null;
  source: string | null;
  dedupe_key: string;
};

export type SleepRow = {
  stage: string;
  start_time: string;
  end_time: string;
  minutes: number | null;
  source: string | null;
  dedupe_key: string;
};

export type ClinicalRow = {
  resource_type: string;
  received_date: string | null;
  source: string | null;
  /** Path inside the export, relative to export.xml. */
  file: string;
  identifier: string;
};

/**
 * A clinical record's metadata.
 *
 * The FHIR itself is not here — Apple writes each resource to its own JSON file
 * and the element only points at it, so reading the payload needs the filesystem
 * and belongs with the other asset importers.
 */
export function toClinical(attrs: Record<string, string>): ClinicalRow | null {
  if (!attrs.resourceFilePath || !attrs.identifier) return null;
  return {
    resource_type: attrs.type ?? "Unknown",
    received_date: attrs.receivedDate ? (toIso(attrs.receivedDate) ?? attrs.receivedDate) : null,
    source: attrs.sourceName ?? null,
    file: attrs.resourceFilePath,
    identifier: attrs.identifier,
  };
}

export type DailyRow = {
  date: string;
  active_energy_kcal: number | null;
  move_goal_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
};

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A `<Record>` that is a sleep stage rather than a measurement. */
export function isSleep(attrs: Record<string, string>): boolean {
  return attrs.type === "HKCategoryTypeIdentifierSleepAnalysis";
}

export function toSample(attrs: Record<string, string>): SampleRow | null {
  const start = toIso(attrs.startDate ?? "");
  if (!start || !attrs.type) return null;

  const type = normalizeType(attrs.type);
  const value = num(attrs.value);
  const source = attrs.sourceName ?? null;

  return {
    type,
    value,
    unit: attrs.unit ?? null,
    start_time: start,
    end_time: toIso(attrs.endDate ?? "") ?? null,
    source,
    dedupe_key: dedupeKey([type, start, value ?? attrs.value, source]),
  };
}

export function toSleep(attrs: Record<string, string>): SleepRow | null {
  const start = toIso(attrs.startDate ?? "");
  const end = toIso(attrs.endDate ?? "");
  if (!start || !end) return null;

  const stage = normalizeSleepStage(attrs.value ?? "");
  const source = attrs.sourceName ?? null;

  return {
    stage,
    start_time: start,
    end_time: end,
    minutes: (Date.parse(end) - Date.parse(start)) / 60_000,
    source,
    dedupe_key: dedupeKey([stage, start, end, source]),
  };
}

export function toWorkout(attrs: Record<string, string>): WorkoutRow | null {
  const start = toIso(attrs.startDate ?? "");
  if (!start) return null;

  const activity = normalizeActivity(attrs.workoutActivityType ?? "unknown");
  const source = attrs.sourceName ?? null;

  // Duration is in whatever `durationUnit` says. It is minutes in every export
  // seen, but reading the unit costs nothing and guessing has a real downside.
  const duration = num(attrs.duration);
  const durationMin =
    duration === null ? null : attrs.durationUnit === "hr" ? duration * 60 : duration;

  return {
    activity,
    start_time: start,
    end_time: toIso(attrs.endDate ?? "") ?? null,
    duration_min: durationMin,
    // Newer exports moved distance and energy out of attributes and into child
    // <WorkoutStatistics> elements, so these are frequently absent. Left null
    // rather than zero: zero is a measurement, absence is not.
    distance_km: null,
    energy_kcal: null,
    source,
    dedupe_key: dedupeKey([activity, start, durationMin, source]),
  };
}

export function toDaily(attrs: Record<string, string>): DailyRow | null {
  const date = attrs.dateComponents;
  if (!date) return null;
  return {
    date,
    active_energy_kcal: num(attrs.activeEnergyBurned),
    move_goal_kcal: num(attrs.activeEnergyBurnedGoal),
    exercise_minutes: num(attrs.appleExerciseTime),
    stand_hours: num(attrs.appleStandHours),
  };
}
