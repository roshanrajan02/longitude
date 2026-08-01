import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { dedupeKey } from "./parse";

/**
 * Epic clinical records, over SMART on FHIR patient access.
 *
 * The route Apple does not give you. `export.xml` contains no `ClinicalRecord`
 * elements unless Health Records is linked to a provider, and even then it is a
 * snapshot rather than something that keeps up. This talks to the health system
 * directly, as you, with your own credentials.
 *
 * Polled rather than subscribed. Epic supports FHIR Subscriptions but coverage
 * is instance-specific and production access goes through App Orchard review
 * measured in weeks; meanwhile a lab result lands weekly at most, so polling
 * costs nothing and needs no approval beyond registering the app.
 *
 * ## What you have to do once
 *
 * 1. Register a patient-facing app at https://fhir.epic.com — free, no review
 *    for the sandbox, and the production listing is a form rather than a
 *    partnership.
 * 2. Set the redirect URI to `http://localhost:4000/epic/callback`.
 * 3. Put the client id in `EPIC_CLIENT_ID`.
 * 4. Run `longitude epic login`, which opens your provider's login page.
 *
 * The token is stored in the database rather than on disk in plain text, which
 * is the same reasoning as everything else here: one file, encrypted or not, is
 * easier to reason about than several.
 */

/** Epic's public sandbox. Real providers each have their own base URL. */
export const SANDBOX_BASE = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";
export const SANDBOX_AUTH = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2";

/**
 * Resources worth pulling, and why each one.
 *
 * Deliberately not "everything". A patient record can run to thousands of
 * resources, most of which are administrative — encounters, coverage, claims —
 * and none of which say anything about your health.
 */
export const RESOURCES = [
  { type: "Observation", note: "labs and vitals", params: "category=laboratory" },
  { type: "Condition", note: "diagnoses", params: "" },
  { type: "MedicationRequest", note: "prescriptions", params: "" },
  { type: "AllergyIntolerance", note: "allergies", params: "" },
  { type: "Immunization", note: "vaccinations", params: "" },
  { type: "Procedure", note: "procedures", params: "" },
  { type: "DocumentReference", note: "visit notes", params: "" },
] as const;

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * A code verifier and its challenge.
 *
 * PKCE, not a client secret. This runs on your laptop, so any secret compiled
 * into it is not a secret — which is precisely the case PKCE was designed for,
 * and Epic requires it for public clients.
 */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authUrl(opts: {
  authBase: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  /** Epic requires the FHIR base as an audience parameter. */
  aud: string;
}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: "openid fhirUser patient/*.read offline_access",
    state: opts.state,
    aud: opts.aud,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${opts.authBase}/authorize?${p}`;
}

export type Token = {
  access_token: string;
  refresh_token?: string;
  patient?: string;
  expires_in?: number;
  expires_at?: number;
};

export async function exchangeCode(opts: {
  authBase: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  /**
   * Set for a confidential client.
   *
   * Not every SMART server accepts a public client. Cigna's
   * `.well-known/smart-configuration` advertises
   * `client-confidential-symmetric` and no `code_challenge_methods_supported`,
   * which means it wants a secret and will reject the PKCE-only flow Epic
   * accepts. The two are not alternatives to choose between — the server
   * decides, and the capability list is where it says so.
   */
  clientSecret?: string;
}): Promise<Token> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  });
  // PKCE is still sent alongside a secret where supported; servers that ignore
  // it are unharmed, and it costs nothing to keep the protection.
  if (opts.verifier) body.set("code_verifier", opts.verifier);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.clientSecret) {
    // HTTP Basic is the form every SMART server accepts; a secret in the body
    // is optional and inconsistently supported.
    headers.authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;
  }

  const res = await fetch(`${opts.authBase}/token`, {
    method: "POST",
    headers,
    body,
  });

  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const token = (await res.json()) as Token;
  // Absolute, because a relative lifetime is useless once it has been stored.
  token.expires_at = Date.now() + (token.expires_in ?? 3600) * 1000;
  return token;
}

export async function refresh(opts: {
  authBase: string;
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
}): Promise<Token> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;
  }

  const res = await fetch(`${opts.authBase}/token`, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    }),
  });

  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  const token = (await res.json()) as Token;
  token.expires_at = Date.now() + (token.expires_in ?? 3600) * 1000;
  return token;
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function saveToken(db: Database, base: string, token: Token): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS epic_auth (
       base       TEXT PRIMARY KEY,
       token      TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  db.prepare(
    `INSERT INTO epic_auth (base, token, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(base) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`,
  ).run(base, JSON.stringify(token), new Date().toISOString());
}

export function loadToken(db: Database, base: string): Token | null {
  try {
    const row = db.prepare(`SELECT token FROM epic_auth WHERE base = ?`).get(base) as
      | { token: string }
      | undefined;
    return row ? (JSON.parse(row.token) as Token) : null;
  } catch {
    return null; // Table does not exist yet — nobody has logged in.
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type Bundle = {
  entry?: { resource?: Record<string, unknown> }[];
  link?: { relation: string; url: string }[];
};

/**
 * Every page of one resource type.
 *
 * FHIR paginates with a `next` link, and a poller that reads only the first page
 * silently caps you at whatever the server's page size happens to be — which
 * looks like "I only have 20 lab results" rather than like a bug.
 */
export async function fetchAll(
  fhirBase: string,
  accessToken: string,
  resourceType: string,
  patientId: string,
  params = "",
  maxPages = 20,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let url: string | null = `${fhirBase}/${resourceType}?patient=${encodeURIComponent(patientId)}${params ? `&${params}` : ""}`;
  let pages = 0;

  while (url && pages < maxPages) {
    const res: Response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/fhir+json" },
    });
    if (!res.ok) {
      throw new Error(`${resourceType}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const bundle = (await res.json()) as Bundle;
    for (const e of bundle.entry ?? []) if (e.resource) out.push(e.resource);

    url = bundle.link?.find((l) => l.relation === "next")?.url ?? null;
    pages++;
  }

  return out;
}

export type PollResult = {
  byType: Record<string, { fetched: number; added: number }>;
  total: number;
  added: number;
};

/**
 * Store resources as raw FHIR.
 *
 * Not shredded into columns. FHIR is deeply nested, varies by resource type and
 * by provider, and modelling it properly is a project of its own — while
 * `json_extract()` answers the questions anyone actually asks of it. The schema
 * comment on `clinical` says the same thing; this is that decision honoured.
 */
export function storeResources(
  db: Database,
  source: string,
  resources: Record<string, unknown>[],
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO clinical (resource_type, received_date, source, fhir, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let added = 0;
  const work = db.transaction((batch: Record<string, unknown>[]) => {
    for (const r of batch) {
      const type = String(r.resourceType ?? "Unknown");
      const id = String(r.id ?? "");
      // Version-aware: a resource that is genuinely updated should land as a new
      // row rather than being silently ignored as a duplicate.
      const version = String(
        (r.meta as { versionId?: string } | undefined)?.versionId ?? "",
      );
      const res = insert.run(
        type,
        new Date().toISOString(),
        source,
        JSON.stringify(r),
        dedupeKey([type, id, version]),
      );
      if (res.changes > 0) added++;
    }
  });

  work(resources);
  return added;
}

export async function poll(
  db: Database,
  opts: { fhirBase: string; authBase: string; clientId: string },
): Promise<PollResult> {
  let token = loadToken(db, opts.fhirBase);
  if (!token) throw new Error("not connected — run: longitude epic login");

  // Refreshed a minute early, so a long poll cannot expire mid-run.
  if (token.expires_at && token.expires_at < Date.now() + 60_000 && token.refresh_token) {
    token = await refresh({
      authBase: opts.authBase,
      clientId: opts.clientId,
      refreshToken: token.refresh_token,
    });
    saveToken(db, opts.fhirBase, token);
  }

  const patient = token.patient;
  if (!patient) throw new Error("token carries no patient id — re-run: longitude epic login");

  const byType: PollResult["byType"] = {};
  let total = 0;
  let added = 0;

  for (const r of RESOURCES) {
    try {
      const resources = await fetchAll(
        opts.fhirBase,
        token.access_token,
        r.type,
        patient,
        r.params,
      );
      const n = storeResources(db, opts.fhirBase, resources);
      byType[r.type] = { fetched: resources.length, added: n };
      total += resources.length;
      added += n;
    } catch (err) {
      // One unsupported resource type must not lose the others. Epic instances
      // differ in what they expose, and a 404 on Procedure is normal.
      byType[r.type] = { fetched: 0, added: 0 };
      console.error(`  ${r.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { byType, total, added };
}

// ---------------------------------------------------------------------------
// Finding your provider
// ---------------------------------------------------------------------------

/**
 * Epic's directory of live FHIR endpoints.
 *
 * Public, unauthenticated, and machine-readable — a FHIR Bundle of ~480
 * Endpoint resources, one per health system. Without it, connecting means
 * hunting through a provider's patient portal for a base URL that is rarely
 * documented anywhere a patient would look.
 */
export const ENDPOINT_DIRECTORY = "https://open.epic.com/Endpoints/R4";

export type Provider = { name: string; fhirBase: string };

export async function findProviders(query: string): Promise<Provider[]> {
  const res = await fetch(ENDPOINT_DIRECTORY, {
    headers: { accept: "application/json", "user-agent": "longitude/0.1" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`directory unavailable: ${res.status}`);

  const bundle = (await res.json()) as {
    entry?: { resource?: { name?: string; address?: string } }[];
  };

  const needle = query.trim().toLowerCase();
  const out: Provider[] = [];

  for (const e of bundle.entry ?? []) {
    const name = e.resource?.name;
    const address = e.resource?.address;
    if (!name || !address) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    // Trailing slashes vary across the directory and would double up when a
    // resource path is appended.
    out.push({ name, fhirBase: address.replace(/\/+$/, "") });
  }

  return out;
}

/**
 * The OAuth base for a provider, derived from its FHIR base.
 *
 * Epic's convention is `.../api/FHIR/R4` for data and `.../oauth2` alongside it.
 * Derived rather than asked for, because a patient has no way to know it — and
 * checked at login, where a wrong guess fails loudly rather than silently.
 */
export function authBaseFor(fhirBase: string): string {
  return fhirBase.replace(/\/api\/FHIR\/(R4|DSTU2|STU3)\/?$/i, "/oauth2");
}

// ---------------------------------------------------------------------------
// Asking the server how to talk to it
// ---------------------------------------------------------------------------

export type SmartConfig = {
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  /** True when the server wants a client secret rather than a public client. */
  confidential: boolean;
  /** True when PKCE is advertised. */
  pkce: boolean;
  scopes: string[];
  capabilities: string[];
};

/**
 * Read `.well-known/smart-configuration`.
 *
 * Worth doing rather than hardcoding, and this is not theoretical: Epic accepts
 * a public client with PKCE, and Cigna advertises
 * `client-confidential-symmetric` with no PKCE methods at all. Guessing wrong
 * fails at the token exchange, after the user has already logged in — the worst
 * place to discover a configuration error.
 *
 * Cigna's own documentation portal is a JavaScript application that cannot be
 * read by a script; this endpoint is the same information in a form a machine
 * can use, published by the server rather than written about it.
 */
export async function smartConfig(fhirBase: string): Promise<SmartConfig | null> {
  try {
    const res = await fetch(`${fhirBase.replace(/\/+$/, "")}/.well-known/smart-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;

    const d = (await res.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      scopes_supported?: string[];
      capabilities?: string[];
      code_challenge_methods_supported?: string[];
    };

    const caps = d.capabilities ?? [];
    return {
      authorizationEndpoint: d.authorization_endpoint ?? null,
      tokenEndpoint: d.token_endpoint ?? null,
      confidential: caps.some((c) => c.includes("confidential")),
      pkce: (d.code_challenge_methods_supported ?? []).includes("S256"),
      scopes: d.scopes_supported ?? [],
      capabilities: caps,
    };
  } catch {
    return null;
  }
}

/** Which resources a server actually offers, from its capability statement. */
export async function supportedResources(fhirBase: string): Promise<string[]> {
  try {
    const res = await fetch(`${fhirBase.replace(/\/+$/, "")}/metadata`, {
      headers: { accept: "application/fhir+json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];
    const d = (await res.json()) as { rest?: { resource?: { type?: string }[] }[] };
    return (d.rest?.[0]?.resource ?? []).map((r) => r.type).filter((t): t is string => Boolean(t));
  } catch {
    return [];
  }
}
