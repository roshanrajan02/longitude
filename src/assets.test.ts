import { describe, expect, test } from "bun:test";
import { haversine, parseEcg, parseGpx, summarizeRoute } from "./assets";

/**
 * GPX and ECG parsing, and the distance maths.
 *
 * Distance is checked against known values rather than against itself. A
 * haversine with a wrong radius, or degrees where radians belong, produces
 * numbers that are internally consistent and wrong by a factor — which on a
 * fitness dashboard reads as a very good week.
 */

describe("haversine", () => {
  const at = (lat: number, lon: number) => ({ lat, lon, ele: null, time: "" });

  test("one degree of latitude is about 111 km", () => {
    // A fixed property of the sphere, independent of this implementation.
    const d = haversine(at(0, 0), at(1, 0));
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  test("a degree of longitude shrinks with latitude", () => {
    // At 60° it is half what it is at the equator. Catches lat and lon swapped,
    // which is otherwise invisible on short distances.
    const equator = haversine(at(0, 0), at(0, 1));
    const sixty = haversine(at(60, 0), at(60, 1));
    expect(sixty / equator).toBeCloseTo(0.5, 1);
  });

  test("a known city pair comes out right", () => {
    // Austin to Dallas, roughly 290 km.
    const d = haversine(at(30.2672, -97.7431), at(32.7767, -96.797)) / 1000;
    expect(d).toBeGreaterThan(280);
    expect(d).toBeLessThan(300);
  });

  test("the same point is zero, not NaN", () => {
    // Floating point can push the argument of asin above 1 and yield NaN, which
    // then poisons the whole route total.
    expect(haversine(at(30.285418, -97.73694), at(30.285418, -97.73694))).toBe(0);
  });
});

describe("GPX", () => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export">
  <trk><name>Route</name><trkseg>
    <trkpt lon="-97.736940" lat="30.285418"><ele>100.0</ele><time>2021-01-22T22:19:43Z</time><extensions><speed>1.42</speed></extensions></trkpt>
    <trkpt lon="-97.736940" lat="30.286418"><ele>103.0</ele><time>2021-01-22T22:19:53Z</time><extensions><speed>1.42</speed></extensions></trkpt>
    <trkpt lon="-97.736940" lat="30.287418"><ele>102.5</ele><time>2021-01-22T22:20:03Z</time><extensions><speed>1.42</speed></extensions></trkpt>
  </trkseg></trk>
</gpx>`;

  test("track points are read with elevation and time", () => {
    const points = parseGpx(gpx);
    expect(points.length).toBe(3);
    expect(points[0]).toMatchObject({ lat: 30.285418, lon: -97.73694, ele: 100 });
    expect(points[0].time).toBe("2021-01-22T22:19:43Z");
  });

  test("latitude and longitude are not transposed", () => {
    // Both are negative-capable numbers in adjacent attributes; swapping them
    // still parses and still produces a route.
    const p = parseGpx(gpx)[0];
    expect(p.lat).toBeGreaterThan(0);
    expect(p.lon).toBeLessThan(0);
  });

  test("distance follows the track", () => {
    // Two steps of 0.001° latitude, about 111 m each.
    const s = summarizeRoute(parseGpx(gpx))!;
    expect(s.distance_km).toBeGreaterThan(0.2);
    expect(s.distance_km).toBeLessThan(0.25);
  });

  test("start and end come from the first and last point", () => {
    const s = summarizeRoute(parseGpx(gpx))!;
    expect(s.start_time).toBe("2021-01-22T22:19:43.000Z");
    expect(s.end_time).toBe("2021-01-22T22:20:03.000Z");
    expect(s.point_count).toBe(3);
  });

  test("a single point is not a route", () => {
    expect(summarizeRoute(parseGpx(gpx).slice(0, 1))).toBeNull();
    expect(summarizeRoute([])).toBeNull();
  });
});

describe("elevation gain", () => {
  const climb = (eles: number[]) =>
    summarizeRoute(
      eles.map((ele, i) => ({ lat: 30 + i * 0.0001, lon: -97, ele, time: "2021-01-01T00:00:00Z" })),
    )!.elevation_gain_m;

  test("a steady climb is counted", () => {
    expect(climb([100, 110, 120, 130])).toBeCloseTo(30, 0);
  });

  test("descent does not subtract from gain", () => {
    // Gain is gain. Netting it against descent makes every loop route zero.
    expect(climb([100, 120, 100, 120])).toBeCloseTo(40, 0);
  });

  test("barometric jitter while standing still is not a mountain", () => {
    // The bug this guards: summing every positive difference. Half-metre noise
    // over a few hundred points turns a flat run into hundreds of metres.
    const noise = Array.from({ length: 200 }, (_, i) => 100 + (i % 2) * 0.4);
    expect(climb(noise)).toBeLessThan(1);
  });

  test("a slow real climb still accumulates", () => {
    // Rising 0.5 m per point stays under the threshold each step, but the total
    // is a genuine 50 m and must not be discarded.
    const slow = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    expect(climb(slow)).toBeGreaterThan(45);
  });

  test("missing elevation does not produce NaN", () => {
    const points = [
      { lat: 30, lon: -97, ele: null, time: "2021-01-01T00:00:00Z" },
      { lat: 30.001, lon: -97, ele: 110, time: "2021-01-01T00:00:10Z" },
      { lat: 30.002, lon: -97, ele: 120, time: "2021-01-01T00:00:20Z" },
    ];
    const s = summarizeRoute(points)!;
    expect(Number.isNaN(s.elevation_gain_m)).toBe(false);
    expect(Number.isNaN(s.distance_km)).toBe(false);
  });
});

describe("ECG", () => {
  const csv = `Name
Date of Birth,"Jan 8, 2002"
Recorded Date,2026-05-30 16:32:18 -0700
Classification,Sinus Rhythm
Symptoms,
Software Version,1.90
Device,"Watch7,12"
Sample Rate,512 hertz


Lead,Lead I
Unit,µV

150.141
151.2
-3.5
`;

  test("metadata is read, including quoted values containing commas", () => {
    // "Jan 8, 2002" and "Watch7,12" both contain the delimiter.
    const ecg = parseEcg(csv)!;
    expect(ecg.classification).toBe("Sinus Rhythm");
    expect(ecg.device).toBe("Watch7,12");
    expect(ecg.sample_rate_hz).toBe(512);
  });

  test("the recorded date becomes ISO UTC", () => {
    // 16:32 at -0700 is 23:32 UTC.
    expect(parseEcg(csv)!.recorded_at).toBe("2026-05-30T23:32:18.000Z");
  });

  test("the waveform is the readings, including negatives", () => {
    const ecg = parseEcg(csv)!;
    expect(ecg.waveform).toEqual([150.141, 151.2, -3.5]);
  });

  test("duration comes from sample count over rate", () => {
    expect(parseEcg(csv)!.duration_s).toBeCloseTo(3 / 512, 6);
  });

  test("an empty symptoms field is null rather than an empty string", () => {
    expect(parseEcg(csv)!.symptoms).toBeNull();
  });

  test("a file with no recorded date is rejected", () => {
    expect(parseEcg("Name\nClassification,Sinus Rhythm\n")).toBeNull();
  });
});
