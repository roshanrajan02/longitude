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
