/**
 * What of your medical record is actually retrievable, and how.
 *
 * Assembled by checking endpoints rather than by recalling them. Every entry
 * below was verified reachable, or is marked as requiring a form or a letter
 * because no machine route exists.
 *
 * The organising insight is that "get my records" is not one problem. It is
 * about a dozen, with different formats, different custodians, different legal
 * bases, and wildly different effort. A FHIR API returns a lab value in
 * milliseconds; the same lab from 2011 is a signed authorisation and a fax. Both
 * are your record and both belong on the same timeline, so the infrastructure
 * has to accept both.
 */

export type Access =
  /** A documented API. Credentials, then automated forever. */
  | "api"
  /** A web portal that produces a file you download by hand. */
  | "portal"
  /** A form or letter. HIPAA gives 30 days. */
  | "request"
  /** Physical media — a CD from radiology, paper in an envelope. */
  | "physical";

export type Cost = "free" | "nominal" | "paid";

export type Source = {
  key: string;
  /** What you get. */
  data: string;
  /** Who holds it. */
  custodian: string;
  access: Access;
  cost: Cost;
  /** File formats it arrives as, which decides what has to parse it. */
  formats: string[];
  /** Where to start. */
  where: string | null;
  /** Why it is worth having, or why it is harder than it looks. */
  note: string;
};

export const SOURCES: Source[] = [
  // -------------------------------------------------------------------------
  // Payers. The record locator, and for some payers a clinical source too.
  // -------------------------------------------------------------------------
  {
    key: "payer-claims",
    data: "Claims and encounters — every provider who billed, with dates and diagnosis codes",
    custodian: "Your health insurer",
    access: "api",
    cost: "free",
    formats: ["FHIR R4 ExplanationOfBenefit"],
    where: "developer.cigna.com · developerportal.aetna.com",
    note: "The best record locator an individual has. Mandated back to 2016 for CMS-regulated payers; employer ERISA plans are exempt but the big carriers built one anyway.",
  },
  {
    key: "payer-clinical",
    data: "Conditions, procedures, medications, observations the payer holds",
    custodian: "Your health insurer",
    access: "api",
    cost: "free",
    formats: ["FHIR R4"],
    where: "Same endpoint as claims",
    note: "Cigna exposes encounters, immunizations and diagnostic reports; Aetna exposes procedures and medications. Coverage varies more than the mandate suggests.",
  },
  {
    key: "payer-historical",
    data: "Claims older than the API floor",
    custodian: "Your health insurer",
    access: "request",
    cost: "free",
    formats: ["PDF", "CSV"],
    where: "Written HIPAA right-of-access request",
    note: "The 2016 cutoff bounds the API, not the data. A letter has no date floor and they have 30 days.",
  },

  // -------------------------------------------------------------------------
  // Providers. The actual clinical record.
  // -------------------------------------------------------------------------
  {
    key: "provider-fhir",
    data: "Problem list, labs with values, medications, allergies, immunizations, vitals",
    custodian: "Each health system",
    access: "api",
    cost: "free",
    formats: ["FHIR R4"],
    where: "fhir.epic.com and equivalents — one registration per vendor",
    note: "The richest structured source. One connection per health system: Epic is ~480 separate instances, not one.",
  },
  {
    key: "provider-notes",
    data: "Visit notes, discharge summaries, referral letters, operative reports",
    custodian: "Each health system",
    access: "api",
    cost: "free",
    formats: ["PDF", "C-CDA XML", "RTF", "HTML"],
    where: "FHIR DocumentReference, then fetch the attachment",
    note: "Where the clinical reasoning lives. Returned as an opaque attachment rather than structured data, so it needs text extraction before it is usable.",
  },
  {
    key: "provider-ccda",
    data: "Continuity of Care Document — a whole-record summary",
    custodian: "Each health system",
    access: "portal",
    cost: "free",
    formats: ["C-CDA XML"],
    where: "Patient portal, usually 'Download my record'",
    note: "Often the fastest way to get a complete snapshot from a provider with no API. Every certified EHR must produce one.",
  },
  {
    key: "provider-legacy",
    data: "Anything before the practice went digital, or after it closed",
    custodian: "The practice, or its custodian of record",
    access: "request",
    cost: "nominal",
    formats: ["PDF", "paper"],
    where: "Written request; state law caps copying fees",
    note: "The last mile, and the reason PicnicHealth can claim coverage that API aggregators cannot. Not a technical problem.",
  },

  // -------------------------------------------------------------------------
  // Imaging. Reports are easy; the studies themselves are not.
  // -------------------------------------------------------------------------
  {
    key: "imaging-reports",
    data: "Radiology and pathology reports — the radiologist's findings",
    custodian: "Health system or imaging centre",
    access: "api",
    cost: "free",
    formats: ["FHIR DiagnosticReport", "PDF"],
    where: "Provider FHIR API",
    note: "The interpretation, which is what a clinician reads. Usually available where the study itself is not.",
  },
  {
    key: "imaging-studies",
    data: "The actual images — X-ray, CT, MRI, ultrasound",
    custodian: "Imaging centre PACS",
    access: "portal",
    cost: "nominal",
    formats: ["DICOM"],
    where: "Patient portal, or a CD from the radiology department",
    note: "Essentially never available over a patient API. Ambra, PocketHealth and similar offer web access, sometimes for a fee. A CD is still the standard answer.",
  },

  // -------------------------------------------------------------------------
  // Pharmacy. Medication truth, and a second record locator.
  // -------------------------------------------------------------------------
  {
    key: "pharmacy-fills",
    data: "Every prescription dispensed, with the prescriber's name",
    custodian: "CVS, Walgreens, Rite Aid, independents",
    access: "portal",
    cost: "free",
    formats: ["PDF", "CSV"],
    where: "Pharmacy account — usually filed as a tax or insurance summary",
    note: "What you actually collected, not what was written. Also names prescribers, which catches doctors your claims missed.",
  },
  {
    key: "pbm",
    data: "Pharmacy claims across all fills under a plan",
    custodian: "Express Scripts, CVS Caremark, OptumRx",
    access: "portal",
    cost: "free",
    formats: ["PDF", "CSV"],
    where: "PBM member portal",
    note: "Broader than one pharmacy chain, since it follows the benefit rather than the store.",
  },
  {
    key: "pdmp",
    data: "Controlled substance dispensing history",
    custodian: "State prescription monitoring programme",
    access: "request",
    cost: "free",
    formats: ["PDF"],
    where: "State health department — most states honour a personal request",
    note: "Complete for its category, because reporting is mandatory. Nothing else is.",
  },

  // -------------------------------------------------------------------------
  // Government registries. Often the only route to childhood data.
  // -------------------------------------------------------------------------
  {
    key: "immunization-registry",
    data: "Every vaccination from birth",
    custodian: "State Immunization Information System",
    access: "request",
    cost: "free",
    formats: ["PDF", "sometimes online"],
    where: "State health department IIS",
    note: "Decades of data no claims API reaches, because school reporting made it mandatory. The single best source for childhood.",
  },
  {
    key: "newborn-screening",
    data: "Heel-prick metabolic panel from the first days of life",
    custodian: "State newborn screening programme",
    access: "request",
    cost: "free",
    formats: ["PDF"],
    where: "State lab",
    note: "Retention varies by state from months to decades. Worth asking once; unlikely past a certain age.",
  },
  {
    key: "medicare-bluebutton",
    data: "Medicare claims back to 2014",
    custodian: "CMS",
    access: "api",
    cost: "free",
    formats: ["FHIR R4"],
    where: "bluebutton.cms.gov",
    note: "Traditional Medicare only. Not relevant before 65 unless disability coverage applies.",
  },
  {
    key: "va",
    data: "Full military and VA medical record",
    custodian: "Department of Veterans Affairs",
    access: "api",
    cost: "free",
    formats: ["FHIR R4", "Blue Button text"],
    where: "api.va.gov",
    note: "Only if you have served. Unusually complete when it applies.",
  },

  // -------------------------------------------------------------------------
  // Things you already own but have never collected.
  // -------------------------------------------------------------------------
  {
    key: "genomics",
    data: "Raw genotype or sequence data",
    custodian: "23andMe, Ancestry, Invitae, Color, Nebula",
    access: "portal",
    cost: "free",
    formats: ["TSV", "VCF"],
    where: "Account settings — every consumer service offers a raw export",
    note: "Free if you have already tested. Static for life, which makes it unusually cheap to hold.",
  },
  {
    key: "wearables",
    data: "Continuous physiology",
    custodian: "Apple, Oura, Whoop, Garmin, Fitbit",
    access: "api",
    cost: "free",
    formats: ["XML export", "JSON API", "GPX", "CSV"],
    where: "Health app export; vendor APIs for the rest",
    note: "Already ingested. The half nobody else aggregating records has, and the one that moves daily.",
  },
  {
    key: "dental",
    data: "Charting, x-rays, treatment history",
    custodian: "Your dental practice",
    access: "request",
    cost: "nominal",
    formats: ["PDF", "DICOM", "proprietary"],
    where: "Written request to the practice",
    note: "A separate world with its own software and almost no interoperability. Nearly always a letter.",
  },
  {
    key: "vision",
    data: "Refraction, prescriptions, retinal imaging",
    custodian: "Optometrist or ophthalmologist",
    access: "request",
    cost: "nominal",
    formats: ["PDF", "images"],
    where: "Written request",
    note: "Same as dental — separate systems, rarely connected to anything.",
  },
  {
    key: "direct-lab",
    data: "Labs you ordered yourself",
    custodian: "Quest, Labcorp, Function, Marek",
    access: "portal",
    cost: "paid",
    formats: ["PDF", "sometimes FHIR"],
    where: "Consumer lab portal",
    note: "The one category you can create on demand rather than retrieve. Useful for filling a gap deliberately rather than waiting for one to be filled by illness.",
  },
];

/** Grouped for display, in the order a person would work through them. */
export const GROUPS: { label: string; keys: string[]; why: string }[] = [
  {
    label: "Start here",
    keys: ["payer-claims", "payer-clinical", "provider-fhir"],
    why: "Automated, free, and the claims tell you who else to ask.",
  },
  {
    label: "One-time downloads",
    keys: ["provider-ccda", "pharmacy-fills", "pbm", "genomics", "wearables"],
    why: "A portal and a file. No registration, no waiting.",
  },
  {
    label: "Worth a letter",
    keys: ["immunization-registry", "payer-historical", "pdmp", "provider-legacy", "newborn-screening"],
    why: "No API exists. HIPAA gives them 30 days, and this is the only route to childhood.",
  },
  {
    label: "Harder, or paid",
    keys: ["imaging-studies", "dental", "vision", "direct-lab"],
    why: "Physical media, proprietary formats, or money.",
  },
  {
    label: "If it applies",
    keys: ["medicare-bluebutton", "va", "imaging-reports"],
    why: "Conditional on circumstance.",
  },
];

/** Every distinct format the infrastructure has to be able to read. */
export function formatsNeeded(): { format: string; sources: string[] }[] {
  const map = new Map<string, string[]>();
  for (const s of SOURCES) {
    for (const f of s.formats) {
      const list = map.get(f) ?? [];
      list.push(s.key);
      map.set(f, list);
    }
  }
  return [...map]
    .map(([format, sources]) => ({ format, sources }))
    .sort((a, b) => b.sources.length - a.sources.length);
}
