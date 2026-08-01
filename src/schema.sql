-- Longitude schema.
--
-- One table per shape of data, not per metric. Apple exports ~80 distinct record
-- types and grows the list every watchOS release; a table per type would mean a
-- migration every autumn. `samples` holds anything that is a value at a moment,
-- keyed by type string, so a new metric needs no schema change at all.

PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- samples — the bulk of the data. Heart rate alone can be millions of rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY,
  -- Normalized: "HKQuantityTypeIdentifierHeartRate" is stored as "heart_rate".
  -- Raw Apple identifiers are unreadable in a dashboard config.
  type        TEXT    NOT NULL,
  value       REAL,
  -- Kept verbatim rather than converted. Unit conversion is a decision the
  -- consumer should make knowingly; silently normalizing kg to lb has produced
  -- some memorable bugs in health apps.
  unit        TEXT,
  start_time  TEXT    NOT NULL,          -- ISO 8601, UTC
  end_time    TEXT,
  source      TEXT,                       -- "Apple Watch", "iPhone", "Oura"
  -- Stable hash of the natural key. The whole point: re-importing a fresh export
  -- that overlaps the last one must not duplicate a single row.
  dedupe_key  TEXT    NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS samples_type_time_idx ON samples (type, start_time);
CREATE INDEX IF NOT EXISTS samples_time_idx      ON samples (start_time);

-- ---------------------------------------------------------------------------
-- workouts — an interval with aggregates, not a point in time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workouts (
  id             INTEGER PRIMARY KEY,
  activity       TEXT NOT NULL,           -- "running", "walking", "hiit"
  start_time     TEXT NOT NULL,
  end_time       TEXT,
  duration_min   REAL,
  distance_km    REAL,
  energy_kcal    REAL,
  source         TEXT,
  dedupe_key     TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS workouts_time_idx ON workouts (start_time);

-- ---------------------------------------------------------------------------
-- sleep — Apple emits sleep as overlapping category records per stage, which is
-- awkward to query. Stored as intervals; the API aggregates them per night.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sleep (
  id           INTEGER PRIMARY KEY,
  stage        TEXT NOT NULL,             -- "core", "deep", "rem", "awake", "in_bed"
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  minutes      REAL,
  source       TEXT,
  dedupe_key   TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS sleep_time_idx ON sleep (start_time);

-- ---------------------------------------------------------------------------
-- daily — Apple's own per-day rollups (the activity rings).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily (
  date               TEXT PRIMARY KEY,    -- YYYY-MM-DD, local to the device
  active_energy_kcal REAL,
  move_goal_kcal     REAL,
  exercise_minutes   REAL,
  stand_hours        REAL
);

-- ---------------------------------------------------------------------------
-- clinical — FHIR resources from linked providers, if Health Records is set up.
--
-- Stored as raw JSON rather than shredded into columns. FHIR is deeply nested
-- and varies by resource type and by provider; modelling it properly is a
-- project of its own, and json_extract() covers the queries that matter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical (
  id             INTEGER PRIMARY KEY,
  resource_type  TEXT NOT NULL,           -- Condition, MedicationRequest, Observation…
  received_date  TEXT,
  source         TEXT,                    -- the health system
  fhir           TEXT NOT NULL,           -- raw JSON
  dedupe_key     TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS clinical_type_idx ON clinical (resource_type);

-- ---------------------------------------------------------------------------
-- imports — provenance. Which file produced which rows, and when.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  file          TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  rows_added    INTEGER DEFAULT 0,
  rows_skipped  INTEGER DEFAULT 0,        -- duplicates from an overlapping export
  notes         TEXT
);

-- ---------------------------------------------------------------------------
-- routes — GPS tracks from outdoor workouts.
--
-- Stored as computed aggregates rather than as points. A single route is
-- thousands of samples at 1 Hz and 122 of them is millions of rows, to answer
-- questions ("how far, how much climb") that are three numbers. The GPX files
-- stay on disk; `file` says which one, so a map can be drawn later without
-- having put a coordinate stream in the database first.
--
-- Deliberately not linked by foreign key to `workouts`. Route files are matched
-- to workouts by overlapping time, which is a heuristic — it can miss, and a
-- constraint would turn a near-miss into a failed import.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  id               INTEGER PRIMARY KEY,
  workout_id       INTEGER,
  start_time       TEXT NOT NULL,
  end_time         TEXT,
  distance_km      REAL,
  elevation_gain_m REAL,
  point_count      INTEGER,
  file             TEXT,
  dedupe_key       TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS routes_time_idx ON routes (start_time);

-- ---------------------------------------------------------------------------
-- ecg — single-lead electrocardiograms from the watch.
--
-- The classification is the point: "Sinus Rhythm", "Atrial Fibrillation",
-- "Inconclusive". That is a clinical finding and belongs in the record whether
-- or not anything ever plots the waveform.
--
-- The waveform itself is ~15,000 microvolt readings per recording. Kept as JSON
-- in one column rather than 15,000 rows, because nothing queries an individual
-- reading — it is drawn as a whole or not at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ecg (
  id             INTEGER PRIMARY KEY,
  recorded_at    TEXT NOT NULL,
  classification TEXT,
  symptoms       TEXT,
  device         TEXT,
  sample_rate_hz REAL,
  duration_s     REAL,
  waveform       TEXT,
  dedupe_key     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ecg_time_idx ON ecg (recorded_at);

-- ---------------------------------------------------------------------------
-- providers — everywhere your records might be.
--
-- The hardest problem in a personal health record is not fetching the data, it
-- is knowing where to fetch it from. Nobody remembers every clinic they have
-- visited, and there is no registry of "places that hold records about me".
--
-- Two things fill this table. Insurance claims name every provider who billed
-- for you, which is the closest thing to a definitive list and includes private
-- practices. The CMS NPI registry then turns a name into an identity.
--
-- `fhir_base` is null until a provider is matched to a known endpoint. Null does
-- not mean unreachable — it means no API was found, and the records are still
-- obtainable by written request under HIPAA's right of access.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY,
  npi         TEXT UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT,                       -- "organization" or "individual"
  specialty   TEXT,
  city        TEXT,
  state       TEXT,
  fhir_base   TEXT,                       -- null when no API is known
  auth_base   TEXT,
  status      TEXT NOT NULL DEFAULT 'known',  -- known | connectable | connected | manual
  source      TEXT,                       -- how you learned about them
  notes       TEXT,
  added_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS providers_status_idx ON providers (status);

-- ---------------------------------------------------------------------------
-- documents — everything that is not structured data.
--
-- Twelve of the twenty-one retrievable sources arrive as PDF. Four arrive as
-- FHIR. An infrastructure built only for FHIR handles the minority of what
-- actually exists, which is how a record ends up "complete" while missing every
-- visit note, every radiology report and every letter.
--
-- The original bytes are never discarded. Extraction is lossy and will improve;
-- a scanned page that yields nothing today is a page that OCR reads next year,
-- and re-requesting it from a hospital is a month of waiting.
--
-- `text` is null when nothing could be extracted, which is different from an
-- empty document. A null here means "we hold bytes we cannot yet read" and is
-- meant to be visible, not swallowed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,          -- note, report, ccda, imaging, lab, letter
  title         TEXT,
  doc_date      TEXT,                   -- clinical date, not when it was filed
  custodian     TEXT,                   -- who it came from
  source        TEXT,                   -- catalog key, e.g. provider-notes
  format        TEXT NOT NULL,          -- pdf, ccda, dicom, text, rtf, html
  bytes         INTEGER,
  /** Where the original lives. Kept on disk; the database stays portable. */
  path          TEXT NOT NULL,
  /** Extracted text, or null when extraction failed or is not yet possible. */
  text          TEXT,
  /** Why text is null, so the gap is actionable rather than mysterious. */
  extract_note  TEXT,
  /** Structured findings pulled out of the document, as JSON. */
  meta          TEXT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  added_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_date_idx ON documents (doc_date);
CREATE INDEX IF NOT EXISTS documents_kind_idx ON documents (kind);

-- Full-text search over everything extracted, so a note from 2019 is findable
-- by what it says rather than by remembering when it happened.
--
-- External content: the index stores no copy of the text, only the terms, and
-- reads the originals back from `documents`. That halves the storage and means
-- there is exactly one copy of the truth.
--
-- The cost is that it cannot be written to directly. Inserting or deleting rows
-- in `documents_fts` by hand desynchronises it from the table and SQLite then
-- reports SQLITE_CORRUPT_VTAB — which is what a manual DELETE produced here.
-- The triggers below are the supported way to keep them together, and mean no
-- caller has to remember to.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, text, content='documents', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;

-- Deletes and updates use the 'delete' command with the *old* values, which is
-- how FTS5 finds the terms it needs to remove.
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, text)
    VALUES ('delete', old.id, old.title, old.text);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, text)
    VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO documents_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;

-- ---------------------------------------------------------------------------
-- labs — results, normalised out of wherever they arrived.
--
-- A lab value reaches you three ways: as a FHIR Observation from a provider or
-- payer, as a row in a C-CDA table, or as text in a PDF. All three are the same
-- fact and none of them is queryable in the form it arrives — a JSON blob in
-- `clinical` cannot be charted, and neither can a sentence in a discharge
-- summary.
--
-- This is the table that makes the crossover possible. Putting an A1c next to
-- the resting heart rate of the six weeks before it needs both to be rows with
-- a value and a date, not a document and a sample stream.
--
-- `loinc` is nullable on purpose. A PDF says "Sodium 141 mmol/L" and carries no
-- code at all; refusing the value for want of a code would discard most of what
-- is actually retrievable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labs (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,           -- as reported: "Hemoglobin A1c"
  slug         TEXT NOT NULL,           -- normalised for grouping: hemoglobin_a1c
  loinc        TEXT,
  value        REAL,
  value_text   TEXT,                    -- when the result is not a number
  unit         TEXT,
  ref_low      REAL,
  ref_high     REAL,
  abnormal     TEXT,                    -- H, L, or null
  taken_at     TEXT NOT NULL,
  /** Where it came from, so a disagreement between sources can be traced. */
  origin       TEXT NOT NULL,           -- fhir, ccda, document
  source       TEXT,                    -- the provider or payer
  document_id  INTEGER,
  dedupe_key   TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS labs_slug_time_idx ON labs (slug, taken_at);
CREATE INDEX IF NOT EXISTS labs_time_idx ON labs (taken_at);
