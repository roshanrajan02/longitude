import { describe, expect, test } from "bun:test";
import {
  dedupeKey,
  normalizeActivity,
  normalizeSleepStage,
  normalizeType,
  parseAttrs,
  scanChunk,
  toDaily,
  toIso,
  toSample,
  toSleep,
  toWorkout,
  unescapeXml,
} from "./parse";

/**
 * Fixtures copied verbatim out of a real 839 MB export, escaping and all.
 *
 * Hand-written XML would be too clean to catch anything. Every awkward thing
 * below — the serialised device object, the curly apostrophe, the non-ISO
 * timestamps — is what Apple actually emits.
 */
const HEART = `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Roshan&#39;s Apple Watch" sourceVersion="7.1" device="&lt;&lt;HKDevice: 0xd307cbcc0&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch5,10, software:7.1&gt;" unit="count/min" creationDate="2021-01-08 09:07:02 -0700" startDate="2021-01-08 09:05:42 -0700" endDate="2021-01-08 09:05:42 -0700" value="76">
 <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
</Record>`;

const WORKOUT = `<Workout workoutActivityType="HKWorkoutActivityTypeFunctionalStrengthTraining" duration="60.6123865822951" durationUnit="min" sourceName="Roshan&#39;s Apple Watch" creationDate="2021-01-09 17:18:22 -0700" startDate="2021-01-09 16:17:45 -0700" endDate="2021-01-09 17:18:22 -0700">`;

const SUMMARY = `<ActivitySummary dateComponents="2021-01-06" activeEnergyBurned="412" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleExerciseTime="22" appleExerciseTimeGoal="30" appleStandHours="9" appleStandHoursGoal="12"/>`;

const SLEEP = `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone (2)" sourceVersion="15.6" creationDate="2023-02-06 05:00:36 -0700" startDate="2023-02-06 00:45:50 -0700" endDate="2023-02-06 02:49:00 -0700" value="HKCategoryValueSleepAnalysisInBed">`;

describe("attribute scanning", () => {
  test("a value containing '>' does not end the tag early", () => {
    // The device attribute is a serialised object full of angle brackets. Ending
    // the tag at the first '>' would drop unit, dates and value — and still
    // produce a row, which is what makes it dangerous.
    const { elements } = scanChunk(HEART);
    const a = elements[0].attrs;
    expect(a.unit).toBe("count/min");
    expect(a.value).toBe("76");
    expect(a.device).toContain("Apple Watch");
  });

  test("values containing spaces, colons and commas survive intact", () => {
    const { elements } = scanChunk(HEART);
    expect(elements[0].attrs.device).toContain("manufacturer:Apple Inc., model:Watch");
  });

  test("entities are decoded, and &amp; is decoded last", () => {
    // Decoding &amp; first turns "&amp;lt;" into "<" instead of "&lt;".
    expect(unescapeXml("&amp;lt;")).toBe("&lt;");
    expect(unescapeXml("&lt;&gt;&quot;&#39;")).toBe(`<>"'`);
  });

  test("an element with children is read from its start tag alone", () => {
    // Records carry MetadataEntry children. Only the start tag matters, and the
    // child must not be mistaken for another record.
    const { elements } = scanChunk(HEART);
    expect(elements.length).toBe(1);
  });

  test("unwanted elements are skipped", () => {
    const xml = `<Correlation type="x" startDate="a"/><Audiogram foo="1"/>${SUMMARY}`;
    const { elements } = scanChunk(xml);
    expect(elements.map((e) => e.name)).toEqual(["ActivitySummary"]);
  });

  test("a prefix match is not treated as the element", () => {
    const { elements } = scanChunk(`<RecordSet type="x"/>${SUMMARY}`);
    expect(elements.map((e) => e.name)).toEqual(["ActivitySummary"]);
  });

  test("parseAttrs ignores an unquoted fragment rather than guessing", () => {
    expect(parseAttrs(`a="1" broken= b="2"`)).toEqual({ a: "1", b: "2" });
  });
});

describe("chunk boundaries", () => {
  const doc = `${HEART}\n${WORKOUT}\n${SUMMARY}\n${SLEEP}`;

  test("splitting anywhere yields exactly the same elements", () => {
    // The property that matters. A 64 MB read ends mid-tag almost every time,
    // and a parser that lost one record per chunk would lose ~30 across a full
    // import — few enough to never notice, many enough to be wrong.
    const whole = scanChunk(doc).elements;
    expect(whole.length).toBe(4);

    for (let cut = 1; cut < doc.length; cut++) {
      const first = scanChunk(doc.slice(0, cut));
      const second = scanChunk(first.rest + doc.slice(cut));
      const combined = [...first.elements, ...second.elements];

      expect(combined.length).toBe(whole.length);
      expect(combined.map((e) => e.name)).toEqual(whole.map((e) => e.name));
      expect(combined[0].attrs.value).toBe(whole[0].attrs.value);
    }
  });

  test("a chunk ending mid-tag holds that tag back rather than dropping it", () => {
    const cut = HEART.indexOf("unit=");
    const { elements, rest } = scanChunk(HEART.slice(0, cut));
    expect(elements).toEqual([]);
    expect(rest.startsWith("<Record")).toBe(true);
  });

  test("a chunk ending inside a quoted value is not mistaken for a tag end", () => {
    const cut = HEART.indexOf("0xd307cbcc0");
    const { elements, rest } = scanChunk(HEART.slice(0, cut));
    expect(elements).toEqual([]);
    expect(rest).toContain("<Record");
  });
});

describe("timestamps", () => {
  test("Apple's format becomes ISO UTC", () => {
    expect(toIso("2021-01-08 09:05:42 -0700")).toBe("2021-01-08T16:05:42.000Z");
  });

  test("the offset is applied in the right direction", () => {
    // Getting the sign backwards shifts everything by twice the offset and still
    // produces valid-looking timestamps.
    expect(toIso("2021-06-01 12:00:00 +0530")).toBe("2021-06-01T06:30:00.000Z");
    expect(toIso("2021-06-01 12:00:00 -0800")).toBe("2021-06-01T20:00:00.000Z");
  });

  test("records either side of a DST change keep their real ordering", () => {
    // 2021-11-07: US Mountain went -0600 to -0700. Both read 01:30 locally, and
    // comparing wall clocks would tie or reverse them.
    const before = toIso("2021-11-07 01:30:00 -0600")!;
    const after = toIso("2021-11-07 01:30:00 -0700")!;
    expect(Date.parse(before)).toBeLessThan(Date.parse(after));
  });

  test("UTC and zero offset agree", () => {
    expect(toIso("2024-02-29 23:59:59 +0000")).toBe("2024-02-29T23:59:59.000Z");
  });

  test("garbage returns null rather than an Invalid Date", () => {
    for (const bad of ["", "not a date", "2021-01-08", "2021-01-08 09:05:42"]) {
      expect(toIso(bad)).toBeNull();
    }
  });
});

describe("naming", () => {
  test("HealthKit identifiers become readable snake_case", () => {
    expect(normalizeType("HKQuantityTypeIdentifierHeartRate")).toBe("heart_rate");
    expect(normalizeType("HKQuantityTypeIdentifierStepCount")).toBe("step_count");
    expect(normalizeType("HKCategoryTypeIdentifierSleepAnalysis")).toBe("sleep_analysis");
  });

  test("runs of capitals split sensibly", () => {
    expect(normalizeType("HKQuantityTypeIdentifierVO2Max")).toBe("vo2_max");
    expect(normalizeType("HKQuantityTypeIdentifierBMI")).toBe("bmi");
  });

  test("workout activities lose their prefix", () => {
    expect(normalizeActivity("HKWorkoutActivityTypeFunctionalStrengthTraining")).toBe(
      "functional_strength_training",
    );
  });

  test("both sleep vocabularies map to one set of names", () => {
    // Older iOS only said InBed/Asleep. A multi-year export contains both, and
    // two names for one stage makes every sleep query wrong.
    expect(normalizeSleepStage("HKCategoryValueSleepAnalysisInBed")).toBe("in_bed");
    expect(normalizeSleepStage("HKCategoryValueSleepAnalysisAsleep")).toBe("asleep");
    expect(normalizeSleepStage("HKCategoryValueSleepAnalysisAsleepDeep")).toBe("deep");
    expect(normalizeSleepStage("HKCategoryValueSleepAnalysisAsleepREM")).toBe("rem");
    expect(normalizeSleepStage("HKCategoryValueSleepAnalysisAwake")).toBe("awake");
  });
});

describe("rows", () => {
  const attrsOf = (xml: string) => scanChunk(xml).elements[0].attrs;

  test("a heart-rate record becomes a sample", () => {
    expect(toSample(attrsOf(HEART))).toMatchObject({
      type: "heart_rate",
      value: 76,
      unit: "count/min",
      start_time: "2021-01-08T16:05:42.000Z",
    });
  });

  test("a sleep record becomes an interval with minutes", () => {
    const s = toSleep(attrsOf(SLEEP))!;
    expect(s.stage).toBe("in_bed");
    expect(s.minutes).toBeCloseTo(123.17, 1);
  });

  test("a workout reads its duration unit rather than assuming minutes", () => {
    expect(toWorkout(attrsOf(WORKOUT))!.duration_min).toBeCloseTo(60.61, 2);
    const hours = { ...attrsOf(WORKOUT), duration: "1.5", durationUnit: "hr" };
    expect(toWorkout(hours)!.duration_min).toBe(90);
  });

  test("absent workout distance is null, not zero", () => {
    // Newer exports move these into child elements. Zero is a measurement;
    // absence is not, and averaging them together is silently wrong.
    expect(toWorkout(attrsOf(WORKOUT))!.distance_km).toBeNull();
  });

  test("an activity summary becomes a daily row", () => {
    expect(toDaily(attrsOf(SUMMARY))).toEqual({
      date: "2021-01-06",
      active_energy_kcal: 412,
      move_goal_kcal: 500,
      exercise_minutes: 22,
      stand_hours: 9,
    });
  });

  test("a record with no start date is dropped rather than stored undated", () => {
    expect(toSample({ type: "HKQuantityTypeIdentifierHeartRate" })).toBeNull();
    expect(toWorkout({ workoutActivityType: "x" })).toBeNull();
  });

  test("a non-numeric value is kept as a row with a null value", () => {
    // Category records carry strings. Dropping them would lose real data;
    // coercing them to 0 would invent it.
    const s = toSample({ ...attrsOf(HEART), value: "HKCategoryValueNotApplicable" })!;
    expect(s.value).toBeNull();
    expect(s.dedupe_key).toContain("HKCategoryValueNotApplicable");
  });
});

describe("dedupe keys", () => {
  const attrsOf = (xml: string) => scanChunk(xml).elements[0].attrs;

  test("the same record parsed twice produces the same key", () => {
    // The whole point: exports overlap, and re-importing must not duplicate.
    expect(toSample(attrsOf(HEART))!.dedupe_key).toBe(toSample(attrsOf(HEART))!.dedupe_key);
  });

  test("records differing only in value get different keys", () => {
    const a = toSample(attrsOf(HEART))!;
    const b = toSample({ ...attrsOf(HEART), value: "77" })!;
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
  });

  test("two sources reading at the same instant stay distinct", () => {
    // A watch and a chest strap both record a beat at the same second. They are
    // two measurements, not one.
    const a = toSample(attrsOf(HEART))!;
    const b = toSample({ ...attrsOf(HEART), sourceName: "Polar H10" })!;
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
  });

  test("null and empty parts cannot collide", () => {
    expect(dedupeKey(["a", null, "b"])).not.toBe(dedupeKey(["a", "b", null]));
  });
});
