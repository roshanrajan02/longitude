import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { sleepByNight, summary, trend } from "./query";
import { buildRows } from "./sync";

/**
 * Aggregation, against a database built in memory.
 *
 * These exist because of two bugs that produced numbers which looked entirely
 * reasonable. A night of sleep was reported as 2.3 hours when it was 6.7,
 * because the grouping split it across two dates; and step counts were averaged
 * rather than summed, which yields the mean size of a step batch — a number that
 * is plausible, stable, and meaningless.
 *
 * Neither would have been caught by a test that only checked the query ran.
 */

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url).pathname, "utf8"));
});

afterEach(() => db.close());

const addSleep = (stage: string, start: string, end: string) =>
  db
    .prepare(
      `INSERT INTO sleep (stage, start_time, end_time, minutes, source, dedupe_key)
       VALUES (?, ?, ?, ?, 'test', ?)`,
    )
    .run(
      stage,
      start,
      end,
      (Date.parse(end) - Date.parse(start)) / 60_000,
      `${stage}|${start}|${end}`,
    );

const addSample = (type: string, value: number, start: string) =>
  db
    .prepare(
      `INSERT INTO samples (type, value, unit, start_time, end_time, source, dedupe_key)
       VALUES (?, ?, 'u', ?, ?, 'test', ?)`,
    )
    .run(type, value, start, start, `${type}|${start}|${value}`);

describe("sleep nights", () => {
  /**
   * One real night, in UTC, for a Pacific sleeper.
   *
   * 22:30 local on the 24th is 05:30 UTC on the 25th; 06:00 local on the 25th is
   * 13:00 UTC. The whole night is a contiguous run of stage records.
   */
  const night = () => {
    addSleep("core", "2026-07-25T05:30:00.000Z", "2026-07-25T07:00:00.000Z"); // 90m
    addSleep("deep", "2026-07-25T07:00:00.000Z", "2026-07-25T08:00:00.000Z"); // 60m
    addSleep("rem", "2026-07-25T08:00:00.000Z", "2026-07-25T09:30:00.000Z"); // 90m
    addSleep("core", "2026-07-25T09:30:00.000Z", "2026-07-25T12:00:00.000Z"); // 150m
    addSleep("awake", "2026-07-25T12:00:00.000Z", "2026-07-25T12:10:00.000Z");
    addSleep("in_bed", "2026-07-25T05:20:00.000Z", "2026-07-25T13:00:00.000Z"); // spans all
  };

  test("a night lands on one date, not two", () => {
    // The bug: grouping by `date(start_time, '-12 hours')` put the evening
    // records on the previous day and the morning ones on the current day,
    // halving both. It reported 2.3h for a 6.5h night.
    night();
    const nights = sleepByNight(db, 400);
    expect(nights.length).toBe(1);
  });

  test("hours are the sum of asleep stages only", () => {
    // 90 + 60 + 90 + 150 = 390 minutes = 6.5 hours. `in_bed` spans the entire
    // night and `awake` is not sleep; including either inflates the total.
    night();
    expect(sleepByNight(db, 400)[0].hours).toBeCloseTo(6.5, 2);
  });

  test("in_bed alone yields no night rather than a fake one", () => {
    addSleep("in_bed", "2026-07-25T05:20:00.000Z", "2026-07-25T13:00:00.000Z");
    expect(sleepByNight(db, 400)).toEqual([]);
  });

  test("two consecutive nights stay separate", () => {
    addSleep("core", "2026-07-24T06:00:00.000Z", "2026-07-24T12:00:00.000Z");
    addSleep("core", "2026-07-25T06:00:00.000Z", "2026-07-25T12:00:00.000Z");
    const nights = sleepByNight(db, 400);
    expect(nights.length).toBe(2);
    expect(nights.every((n) => n.hours === 6)).toBe(true);
  });
});

describe("rates versus counts", () => {
  test("step count is summed across the day, not averaged", () => {
    // The bug this guards: averaging gives 100, the mean size of a step batch.
    // It looks like a step count and is not one.
    for (const v of [100, 200, 300]) addSample("step_count", v, `2026-07-25T1${v / 100}:00:00.000Z`);
    const row = buildRows(db, 400).find((r) => r.metric === "step_count");
    expect(row?.avg).toBe(600);
  });

  test("heart rate is averaged, not summed", () => {
    // Summing heart rate produces a number in the thousands that is not a
    // measurement of anything.
    for (const v of [60, 70, 80]) addSample("heart_rate", v, `2026-07-25T1${v / 10 - 5}:00:00.000Z`);
    const row = buildRows(db, 400).find((r) => r.metric === "heart_rate");
    expect(row?.avg).toBeCloseTo(70, 5);
  });

  test("min and max are carried for averaged metrics", () => {
    for (const v of [60, 70, 80]) addSample("heart_rate", v, `2026-07-25T1${v / 10 - 5}:00:00.000Z`);
    const row = buildRows(db, 400).find((r) => r.metric === "heart_rate");
    expect(row?.min).toBe(60);
    expect(row?.max).toBe(80);
  });
});

describe("summary and trend", () => {
  test("an empty database reports zeroes rather than throwing", () => {
    const s = summary(db);
    expect(s.samples).toBe(0);
    expect(s.firstDay).toBeNull();
  });

  test("sleep nights are counted as nights, not as stage records", () => {
    // One night is a dozen-plus rows. Counting rows would report a fortnight.
    addSleep("core", "2026-07-25T06:00:00.000Z", "2026-07-25T07:00:00.000Z");
    addSleep("deep", "2026-07-25T07:00:00.000Z", "2026-07-25T08:00:00.000Z");
    addSleep("rem", "2026-07-25T08:00:00.000Z", "2026-07-25T09:00:00.000Z");
    expect(summary(db).sleepNights).toBe(1);
  });

  test("null values are excluded from averages", () => {
    // Category records store a string and land as a null value. Treating those
    // as zero drags every average toward it.
    addSample("heart_rate", 60, "2026-07-25T10:00:00.000Z");
    db.prepare(
      `INSERT INTO samples (type, value, unit, start_time, source, dedupe_key)
       VALUES ('heart_rate', NULL, 'u', '2026-07-25T11:00:00.000Z', 'test', 'x')`,
    ).run();
    const t = trend(db, "heart_rate", 400);
    expect(t[0].avg).toBe(60);
    expect(t[0].n).toBe(1);
  });
});
