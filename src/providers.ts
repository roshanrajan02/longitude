import type { Database } from "bun:sqlite";
import { findProviders, authBaseFor } from "./epic";

/**
 * Working out where your records are.
 *
 * This is the actual hard problem. Fetching records is a solved technical
 * question; knowing which of the dozen clinics you have walked into over fifteen
 * years still holds a chart on you is not, and no registry of that exists.
 *
 * Three sources, in descending order of how complete they are:
 *
 *   1. **Insurance claims.** Every provider who billed for you, private practice
 *      included. CMS requires payers to expose this to patients over FHIR, which
 *      makes your own insurer the most complete record locator available.
 *   2. **The NPI registry.** Free and public. Turns a half-remembered name into
 *      an identity, with a speciality and an address to confirm it.
 *   3. **Memory.** Worst, but it is where most people start.
 *
 * Matching a provider to an API endpoint is a separate step and often fails.
 * That is not a bug in this code — most small practices have no patient API at
 * all, and the answer there is a written request under HIPAA's right of access,
 * which they must honour within thirty days.
 */

/** CMS's public registry of every provider in the United States. No auth. */
const NPI_API = "https://npiregistry.cms.hhs.gov/api/";

export type NpiResult = {
  npi: string;
  name: string;
  kind: string;
  specialty: string | null;
  city: string | null;
  state: string | null;
};

export async function searchNpi(opts: {
  name?: string;
  city?: string;
  state?: string;
  limit?: number;
}): Promise<NpiResult[]> {
  const p = new URLSearchParams({ version: "2.1", limit: String(opts.limit ?? 20) });

  /**
   * Names are tried as both organisation and individual.
   *
   * The registry keeps them in different fields, and a patient has no reason to
   * know whether "Austin Regional Clinic" is registered as an organisation or
   * whether their doctor is registered personally.
   */
  if (opts.name) {
    if (/\s/.test(opts.name)) p.set("organization_name", `${opts.name}*`);
    else p.set("last_name", `${opts.name}*`);
  }
  if (opts.city) p.set("city", opts.city);
  if (opts.state) p.set("state", opts.state);

  const res = await fetch(`${NPI_API}?${p}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`NPI registry: ${res.status}`);

  const data = (await res.json()) as {
    results?: {
      number: string;
      enumeration_type?: string;
      basic?: { organization_name?: string; first_name?: string; last_name?: string };
      taxonomies?: { desc?: string; primary?: boolean }[];
      addresses?: { city?: string; state?: string }[];
    }[];
  };

  return (data.results ?? []).map((r) => {
    const b = r.basic ?? {};
    const addr = r.addresses?.[0] ?? {};
    const tax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
    return {
      npi: r.number,
      name: (b.organization_name ?? `${b.first_name ?? ""} ${b.last_name ?? ""}`).trim(),
      kind: r.enumeration_type === "NPI-2" ? "organization" : "individual",
      specialty: tax?.desc ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
    };
  });
}

export function addProvider(
  db: Database,
  p: Partial<NpiResult> & { name: string; source?: string; notes?: string },
): { id: number; added: boolean } {
  const existing = p.npi
    ? (db.prepare(`SELECT id FROM providers WHERE npi = ?`).get(p.npi) as { id: number } | undefined)
    : undefined;
  if (existing) return { id: existing.id, added: false };

  const row = db
    .prepare(
      `INSERT INTO providers (npi, name, kind, specialty, city, state, status, source, notes, added_at)
       VALUES (?, ?, ?, ?, ?, ?, 'known', ?, ?, ?) RETURNING id`,
    )
    .get(
      p.npi ?? null,
      p.name,
      p.kind ?? null,
      p.specialty ?? null,
      p.city ?? null,
      p.state ?? null,
      p.source ?? "manual",
      p.notes ?? null,
      new Date().toISOString(),
    ) as { id: number };

  return { id: row.id, added: true };
}

/**
 * Match recorded providers to a known FHIR endpoint.
 *
 * Name matching, which is crude and stated as such. A provider's registered
 * legal name and the name on their Epic endpoint are frequently different — "St
 * David's HealthCare" versus "St. David's Round Rock Medical Center" — so this
 * finds the obvious ones and leaves the rest for you to confirm.
 *
 * Deliberately conservative: a wrong match sends you to another organisation's
 * login page, which is confusing and achieves nothing.
 */
export async function matchEndpoints(
  db: Database,
): Promise<{ checked: number; matched: number }> {
  const rows = db
    .prepare(`SELECT id, name FROM providers WHERE fhir_base IS NULL AND status != 'manual'`)
    .all() as { id: number; name: string }[];
  if (rows.length === 0) return { checked: 0, matched: 0 };

  const directory = await findProviders("");
  const update = db.prepare(
    `UPDATE providers SET fhir_base = ?, auth_base = ?, status = 'connectable' WHERE id = ?`,
  );

  let matched = 0;
  for (const r of rows) {
    // Compared on significant words, so "Inc", "LLC" and punctuation do not
    // decide the outcome.
    const words = r.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["inc", "llc", "health", "medical", "center"].includes(w));
    if (words.length === 0) continue;

    const hit = directory.find((d) => {
      const dn = d.name.toLowerCase();
      return words.every((w) => dn.includes(w));
    });

    if (hit) {
      update.run(hit.fhirBase, authBaseFor(hit.fhirBase), r.id);
      matched++;
    }
  }

  return { checked: rows.length, matched };
}

export function listProviders(db: Database) {
  return db
    .prepare(`SELECT * FROM providers ORDER BY status, name`)
    .all() as {
    id: number;
    npi: string | null;
    name: string;
    specialty: string | null;
    city: string | null;
    state: string | null;
    fhir_base: string | null;
    status: string;
    source: string;
  }[];
}
