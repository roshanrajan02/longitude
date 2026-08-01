import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dedupeKey } from "./parse";
import {
  detectFormat,
  dicomDate,
  dicomMeta,
  parseCda,
  pdfText,
  type Format,
} from "./formats";

/**
 * Taking in anything, and being honest about what came out.
 *
 * One entry point for every file a hospital, insurer or lab will ever send you.
 * The format is sniffed from the bytes rather than trusted from the extension,
 * because records arrive named `document.pdf` that are TIFFs and `export.xml`
 * that could be either a HealthKit dump or a C-CDA.
 *
 * The original is always kept. Extraction is lossy and improving — a scan that
 * yields nothing today is a page OCR reads next year, and re-requesting it from
 * a hospital costs a month. Deleting the bytes because the parser of the day
 * could not read them would be the one irreversible mistake available here.
 */

export type IngestResult = {
  id: number | null;
  format: Format;
  title: string;
  chars: number;
  /** Set when text could not be extracted, saying why. */
  problem: string | null;
  duplicate: boolean;
};

/** Where originals live, alongside the database. */
export function docStore(dbPath: string): string {
  return join(dirname(dbPath), "documents");
}

/**
 * A date from anywhere in the text.
 *
 * Documents rarely carry their clinical date in metadata — a discharge summary
 * is dated in its header, a lab report next to the collection time. Without a
 * date the document cannot sit on a timeline, which is the whole point, so it
 * is worth digging for.
 *
 * The earliest plausible date wins rather than the first found. Reports print
 * their generated-on date at the top and the clinically relevant date lower.
 */
export function guessDate(text: string): string | null {
  const found: string[] = [];

  // 2024-03-15
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    found.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // 03/15/2024 and 3/15/24
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/g)) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    found.push(`${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  // 15 March 2024 / March 15, 2024
  const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "gi"))) {
    const mo = String(
      "january february march april may june july august september october november december"
        .split(" ")
        .indexOf(m[1].toLowerCase()) + 1,
    ).padStart(2, "0");
    found.push(`${m[3]}-${mo}-${m[2].padStart(2, "0")}`);
  }

  if (found.length === 0) return null;

  // Anything in the future is a typo or a follow-up appointment, not this
  // document's date.
  const today = new Date().toISOString().slice(0, 10);
  const plausible = found.filter((d) => d >= "1900-01-01" && d <= today).sort();
  return plausible[0] ?? null;
}

/** A first line worth showing in a list. */
function guessTitle(text: string, fallback: string): string {
  for (const line of text.split("\n").slice(0, 12)) {
    const t = line.trim();
    // Long enough to mean something, short enough to be a heading rather than
    // the first sentence of a paragraph.
    if (t.length >= 8 && t.length <= 90 && !/^\d/.test(t)) return t;
  }
  return fallback;
}

export async function ingestFile(
  db: Database,
  path: string,
  opts: { dbPath: string; custodian?: string; source?: string; kind?: string } = {
    dbPath: "",
  },
): Promise<IngestResult> {
  const file = Bun.file(path);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = basename(path);
  const format = detectFormat(bytes, name);

  /**
   * Identity is the content hash, not the path.
   *
   * The same discharge summary arrives twice — once in a portal download and
   * once attached to a FHIR DocumentReference — under different filenames. A
   * path-based key would store both and a timeline would show the visit twice.
   */
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const key = dedupeKey(["doc", hash]);

  const existing = db.prepare(`SELECT id FROM documents WHERE dedupe_key = ?`).get(key) as
    | { id: number }
    | undefined;
  if (existing) {
    return { id: existing.id, format, title: name, chars: 0, problem: null, duplicate: true };
  }

  let text: string | null = null;
  let problem: string | null = null;
  let meta: Record<string, unknown> | null = null;
  let title = name;
  let docDate: string | null = null;
  let kind = opts.kind ?? "document";

  if (format === "pdf") {
    const r = pdfText(bytes);
    text = r.text || null;
    problem = r.problem;
    meta = { pages: r.pages };
    if (text) {
      title = guessTitle(text, name);
      docDate = guessDate(text);
    }
  } else if (format === "ccda") {
    const cda = parseCda(new TextDecoder().decode(bytes));
    text = cda.sections.map((s) => `## ${s.title}\n${s.text}`).join("\n\n");
    title = cda.title ?? name;
    kind = opts.kind ?? "ccda";
    // CDA effectiveTime is YYYYMMDDHHMMSS±ZZZZ.
    docDate = cda.effective?.match(/^(\d{4})(\d{2})(\d{2})/)
      ? `${cda.effective.slice(0, 4)}-${cda.effective.slice(4, 6)}-${cda.effective.slice(6, 8)}`
      : guessDate(text);
    meta = {
      patient: cda.patient,
      custodian: cda.custodian,
      sections: cda.sections.map((s) => ({ title: s.title, code: s.code })),
    };
    if (!text) problem = "no narrative sections found";
  } else if (format === "dicom") {
    const d = dicomMeta(bytes);
    if ("problem" in d) {
      problem = d.problem;
    } else {
      kind = opts.kind ?? "imaging";
      docDate = dicomDate(d.studyDate);
      title = [d.modality, d.description].filter(Boolean).join(" — ") || name;
      meta = d;
      // Deliberately not text. A DICOM holds pixels, and pretending otherwise
      // would put an empty document in a full-text index.
      problem = "imaging study — metadata only, pixels not decoded";
    }
  } else if (format === "text" || format === "csv" || format === "html" || format === "rtf") {
    const decoded = new TextDecoder().decode(bytes);
    // RTF and HTML carry markup that would pollute a search index.
    text =
      format === "html"
        ? decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : format === "rtf"
          ? decoded.replace(/\\'[0-9a-f]{2}|\\[a-z]+-?\d*\s?|[{}]/gi, "").trim()
          : decoded;
    title = guessTitle(text, name);
    docDate = guessDate(text);
  } else if (format === "json" || format === "xml") {
    text = new TextDecoder().decode(bytes);
    docDate = guessDate(text);
    problem = "stored as-is — structured import handles this better";
  }

  // Copy the original in before recording it, so a row never points at nothing.
  const store = docStore(opts.dbPath);
  mkdirSync(store, { recursive: true });
  const stored = join(store, `${hash}-${name}`);
  await Bun.write(stored, bytes);

  const row = db
    .prepare(
      `INSERT INTO documents
         (kind, title, doc_date, custodian, source, format, bytes, path, text, extract_note, meta, dedupe_key, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      kind,
      title.slice(0, 200),
      docDate,
      opts.custodian ?? null,
      opts.source ?? null,
      format,
      bytes.byteLength,
      stored,
      text,
      problem,
      meta ? JSON.stringify(meta) : null,
      key,
      new Date().toISOString(),
    ) as { id: number };

  if (text) {
    db.prepare(`INSERT INTO documents_fts (rowid, title, text) VALUES (?, ?, ?)`).run(
      row.id,
      title,
      text,
    );
  }

  return {
    id: row.id,
    format,
    title,
    chars: text?.length ?? 0,
    problem,
    duplicate: false,
  };
}

/** Everything under a directory, recursively. */
export async function ingestDirectory(
  db: Database,
  dir: string,
  opts: { dbPath: string; custodian?: string; source?: string },
): Promise<{ files: number; added: number; duplicates: number; unreadable: number }> {
  const glob = new Bun.Glob("**/*");
  let files = 0;
  let added = 0;
  let duplicates = 0;
  let unreadable = 0;

  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    const full = join(dir, rel);
    try {
      if (statSync(full).size === 0) continue;
    } catch {
      continue;
    }
    files++;
    const r = await ingestFile(db, full, opts);
    if (r.duplicate) duplicates++;
    else {
      added++;
      if (r.chars === 0) unreadable++;
    }
  }

  return { files, added, duplicates, unreadable };
}

export type SearchHit = {
  id: number;
  title: string;
  doc_date: string | null;
  kind: string;
  snippet: string;
};

/**
 * Search everything extracted.
 *
 * The reason to hold documents rather than just file them. A note from 2019 is
 * findable by what it says, which is how anyone actually looks for something —
 * not by remembering which month it happened in.
 */
export function searchDocuments(db: Database, query: string, limit = 20): SearchHit[] {
  return db
    .prepare(
      `SELECT d.id, d.title, d.doc_date, d.kind,
              snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet
         FROM documents_fts f
         JOIN documents d ON d.id = f.rowid
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(query, limit) as SearchHit[];
}

/** What is held, and what could not be read — the second half matters more. */
export function documentStats(db: Database) {
  const byFormat = db
    .prepare(
      `SELECT format, COUNT(*) n, SUM(bytes) bytes,
              SUM(CASE WHEN text IS NULL THEN 1 ELSE 0 END) unreadable
         FROM documents GROUP BY format ORDER BY n DESC`,
    )
    .all() as { format: string; n: number; bytes: number; unreadable: number }[];

  const problems = db
    .prepare(
      `SELECT extract_note, COUNT(*) n FROM documents
        WHERE text IS NULL AND extract_note IS NOT NULL
        GROUP BY extract_note ORDER BY n DESC`,
    )
    .all() as { extract_note: string; n: number }[];

  return { byFormat, problems };
}
