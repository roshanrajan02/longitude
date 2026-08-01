import { describe, expect, test } from "bun:test";
import { providersFromEob } from "./claims";

/**
 * Provider extraction from claims.
 *
 * FHIR permits a provider to be named in at least five places and payers
 * disagree about which to use. Reading only `provider` — the obvious choice —
 * silently loses whole payers' worth of data, which presents as "I had no
 * claims that year" rather than as a bug.
 */

describe("providersFromEob", () => {
  test("finds a provider given as a reference with an NPI identifier", () => {
    const p = providersFromEob({
      provider: {
        display: "Austin Regional Clinic",
        identifier: { system: "http://hl7.org/fhir/sid/us-npi", value: "1710443205" },
      },
      billablePeriod: { start: "2021-06-14" },
    });
    expect(p).toEqual([
      { npi: "1710443205", name: "Austin Regional Clinic", role: "billing", date: "2021-06-14" },
    ]);
  });

  test("finds providers named only in the care team", () => {
    // Some payers leave `provider` as the billing entity and put the actual
    // clinician in careTeam. Ignoring it loses the person you saw.
    const p = providersFromEob({
      careTeam: [
        { provider: { display: "Dr Jane Okafor" }, role: { coding: [{ code: "attending" }] } },
        { provider: { display: "Radiology Associates" }, role: { coding: [{ code: "reading" }] } },
      ],
    });
    expect(p.map((x) => x.name)).toEqual(["Dr Jane Okafor", "Radiology Associates"]);
    expect(p[0].role).toBe("attending");
  });

  test("resolves a contained organization", () => {
    // Blue Button and several commercial payers inline the organization rather
    // than referencing it externally.
    const p = providersFromEob({
      contained: [{ resourceType: "Organization", id: "org1", name: "St David's Medical Center" }],
      provider: { reference: "#org1" },
    });
    expect(p[0].name).toBe("St David's Medical Center");
  });

  test("resolves a contained practitioner's human name", () => {
    const p = providersFromEob({
      contained: [
        { resourceType: "Practitioner", id: "pr1", name: [{ given: ["Ana"], family: "Ruiz" }] },
      ],
      provider: { reference: "#pr1" },
    });
    expect(p[0].name).toBe("Ana Ruiz");
  });

  test("accepts a bare ten-digit identifier as an NPI", () => {
    // Some payers omit the system URI entirely.
    const p = providersFromEob({ provider: { identifier: { value: "1234567893" } } });
    expect(p[0].npi).toBe("1234567893");
  });

  test("does not mistake a member id for an NPI", () => {
    // A claim number or member id is not a provider identity, and recording one
    // would put a meaningless row in the worklist.
    const p = providersFromEob({ provider: { identifier: { value: "XYZ-99" } } });
    expect(p).toEqual([]);
  });

  test("a reference identifying nothing is skipped", () => {
    // "Organization/1234" with no display and no identifier names nobody.
    expect(providersFromEob({ provider: { reference: "Organization/1234" } })).toEqual([]);
  });

  test("the same practice billing and attending appears once", () => {
    const p = providersFromEob({
      provider: { display: "Austin Regional Clinic", identifier: { value: "1710443205" } },
      careTeam: [{ provider: { identifier: { value: "1710443205" } } }],
    });
    expect(p.length).toBe(1);
  });

  test("a facility is recorded as well as the biller", () => {
    // The hospital and the physician group are different organisations and both
    // hold records.
    const p = providersFromEob({
      provider: { display: "Emergency Physicians PA" },
      facility: { display: "Dell Seton Medical Center" },
    });
    expect(p.map((x) => x.role)).toEqual(["billing", "facility"]);
  });

  test("an empty claim yields nothing rather than throwing", () => {
    expect(providersFromEob({})).toEqual([]);
  });
});
