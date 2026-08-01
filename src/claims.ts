import type { Database } from "bun:sqlite";
import { addProvider } from "./providers";

/**
 * Reconstructing where you have been, from who billed for it.
 *
 * The question "which providers have I ever seen" has no registry behind it.
 * Nobody keeps that list — not the health systems, not the government, not you.
 * But somebody does keep a list of every clinician who was *paid* on your
 * behalf, and that is your insurer.
 *
 * Claims are therefore the best record locator that exists for an individual.
 * They cover private practice, urgent care, the radiologist you never met and
 * the anaesthetist you were unconscious for — anyone who billed. CMS has
 * required payers to expose them to patients over FHIR since 2021, as
 * `ExplanationOfBenefit` resources.
 *
 * What they miss is worth stating plainly, because it is not small: anything
 * paid in cash, anything from a period you were uninsured, anything under a
 * payer you can no longer log into, and anything older than the retention
 * window. This narrows the problem; it does not close it.
 */

/**
 * Pull a provider identity out of an ExplanationOfBenefit.
 *
 * Deliberately defensive. FHIR permits a provider to be named in at least five
 * places and payers disagree about which to use: a `provider` reference, a
 * `careTeam` entry, a `facility`, a contained resource, or nothing but a
 * display string. Reading only `provider` — the obvious choice — silently loses
 * whole payers' worth of data, which looks like "I had no claims that year".
 */
export type ClaimProvider = {
  npi: string | null;
  name: string;
  role: string | null;
  /** Service date, so first and last contact can be worked out. */
  date: string | null;
};

type Ref = { reference?: string; display?: string; identifier?: { system?: string; value?: string } };

/** NPIs are identified by a well-known system URI, whatever the payer calls it. */
function npiOf(ref: Ref | undefined): string | null {
  const id = ref?.identifier;
  if (!id?.value) return null;
  if (id.system && /npi|us-npi/i.test(id.system)) return id.value;
  // Some payers omit the system. A bare ten-digit number is an NPI in practice.
  return /^\d{10}$/.test(id.value) ? id.value : null;
}

function nameOf(ref: Ref | undefined, contained: Map<string, Record<string, unknown>>): string | null {
  if (!ref) return null;
  if (ref.display) return ref.display;

  // A contained resource, referenced as "#something".
  if (ref.reference?.startsWith("#")) {
    const r = contained.get(ref.reference.slice(1));
    if (r) {
      const org = r.name;
      if (typeof org === "string") return org;
      const person = r.name as { given?: string[]; family?: string }[] | undefined;
      const p = person?.[0];
      if (p) return [p.given?.join(" "), p.family].filter(Boolean).join(" ");
    }
  }
  return null;
}

export function providersFromEob(eob: Record<string, unknown>): ClaimProvider[] {
  const out: ClaimProvider[] = [];

  const contained = new Map<string, Record<string, unknown>>();
  for (const c of (eob.contained as Record<string, unknown>[] | undefined) ?? []) {
    if (typeof c.id === "string") contained.set(c.id, c);
  }

  const date =
    (eob.billablePeriod as { start?: string } | undefined)?.start ??
    (typeof eob.created === "string" ? eob.created : null);

  const consider = (ref: Ref | undefined, role: string | null) => {
    if (!ref) return;
    const npi = npiOf(ref);
    const name = nameOf(ref, contained);
    // A reference with neither a name nor an NPI identifies nothing. Recording
    // it would fill the table with rows saying "Organization/1234".
    if (!npi && !name) return;
    out.push({ npi, name: name ?? `NPI ${npi}`, role, date });
  };

  consider(eob.provider as Ref, "billing");
  consider(eob.facility as Ref, "facility");

  for (const member of (eob.careTeam as { provider?: Ref; role?: { coding?: { code?: string }[] } }[] | undefined) ?? []) {
    consider(member.provider, member.role?.coding?.[0]?.code ?? "care team");
  }

  // Same provider named twice in one claim is normal — billing and care team
  // are frequently the same practice.
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.npi ?? p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ClaimsScan = {
  claims: number;
  providers: number;
  added: number;
  earliest: string | null;
  latest: string | null;
};

/**
 * Record every provider named across a set of claims.
 *
 * The output is a worklist, not an archive: each row is somewhere that may hold
 * records about you, to be connected or written to.
 */
export function recordProviders(
  db: Database,
  eobs: Record<string, unknown>[],
  source = "claims",
): ClaimsScan {
  const found = new Map<string, ClaimProvider>();
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const eob of eobs) {
    for (const p of providersFromEob(eob)) {
      const key = p.npi ?? p.name.toLowerCase();
      // Keep the earliest sighting, so "first seen" means what it says.
      const prior = found.get(key);
      if (!prior || (p.date && prior.date && p.date < prior.date)) found.set(key, p);
      if (p.date) {
        if (!earliest || p.date < earliest) earliest = p.date;
        if (!latest || p.date > latest) latest = p.date;
      }
    }
  }

  let added = 0;
  const work = db.transaction((list: ClaimProvider[]) => {
    for (const p of list) {
      const res = addProvider(db, {
        npi: p.npi ?? undefined,
        name: p.name,
        source,
        notes: p.date ? `first billed ${p.date.slice(0, 10)}` : null,
      });
      if (res.added) added++;
    }
  });
  work([...found.values()]);

  return { claims: eobs.length, providers: found.size, added, earliest, latest };
}

// ---------------------------------------------------------------------------
// Known payers
// ---------------------------------------------------------------------------

/**
 * Patient Access endpoints for payers.
 *
 * These are the *sandbox* bases, which is what can be verified without an
 * account. Production URLs are issued when an app is registered, and differ.
 * They are listed anyway because they prove the endpoint exists and speaks R4,
 * which is the question you actually have before spending an hour registering.
 *
 * Cigna and Aetna are here because both run Medicare Advantage and Medicaid
 * lines, so both had to build a Patient Access API even though a commercial
 * employer plan does not oblige them to expose one. In practice they usually
 * serve commercial members from the same endpoint — worth confirming rather
 * than assuming.
 */
export const PAYERS: {
  key: string;
  name: string;
  portal: string;
  sandboxFhir: string;
  sandboxAuth: string;
  prodFhir?: string;
  note: string;
}[] = [
  {
    key: "cigna",
    name: "Cigna",
    portal: "https://developer.cigna.com",
    sandboxFhir: "https://p-hi2.digitaledge.cigna.com/PatientAccess/v1-devportal",
    sandboxAuth: "https://r-hi2.cigna.com/mga/sps/oauth/oauth20",
    /**
     * Production, found by probing rather than from documentation.
     *
     * The portal does not list it and the developer site is a JavaScript
     * application a script cannot read. Confirmed production by its OAuth host
     * differing from the sandbox one — p-hi2 against r-hi2 — and by exposing
     * MedicationDispense, which sandbox does not.
     */
    prodFhir: "https://fhir.cigna.com/PatientAccess/v1",
    note: "Exposes clinical resources as well as claims — conditions, encounters, immunizations.",
  },
  {
    key: "aetna",
    name: "Aetna (CVS Health)",
    portal: "https://developerportal.aetna.com",
    sandboxFhir: "https://vteapif1.aetna.com/fhirdemo/v1/patientaccess",
    sandboxAuth: "https://vteapif1.aetna.com/fhirdemo/v1/fhirserver_auth/oauth2",
    note: "Claims plus conditions, procedures, medications and the practitioners behind them.",
  },
  {
    key: "cms",
    name: "Medicare (CMS Blue Button 2.0)",
    portal: "https://bluebutton.cms.gov/developers/",
    sandboxFhir: "https://sandbox.bluebutton.cms.gov/v2/fhir",
    sandboxAuth: "https://sandbox.bluebutton.cms.gov/v2/o",
    note: "Traditional Medicare only. Claims back to 2014, nothing clinical.",
  },
];

/**
 * Resources worth pulling from a payer.
 *
 * Claims first, because they are the record locator and the reason to connect at
 * all. The clinical resources are a bonus that not every payer offers, and are
 * requested individually so one unsupported type does not fail the run.
 */
export const PAYER_RESOURCES = [
  { type: "ExplanationOfBenefit", note: "claims — every provider who billed" },
  { type: "Coverage", note: "which plan, and when" },
  { type: "Condition", note: "diagnoses the payer knows about" },
  { type: "Procedure", note: "procedures billed" },
  { type: "MedicationRequest", note: "prescriptions" },
  // Production only. What was actually dispensed rather than what was written,
  // which is the more truthful of the two — a prescription you never collected
  // is not a medication you took.
  { type: "MedicationDispense", note: "medications actually collected" },
  { type: "Observation", note: "results the payer holds" },
  { type: "Immunization", note: "vaccinations" },
  { type: "AllergyIntolerance", note: "allergies" },
  { type: "Encounter", note: "visits" },
] as const;
