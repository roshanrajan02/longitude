import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * The database.
 *
 * SQLite via `bun:sqlite`, which is built into the runtime — no native module to
 * compile, no server to run, and the whole store is one file you can copy. That
 * matters more here than it usually would: this file holds clinical records, and
 * the privacy story is "it is a file on your machine" rather than a paragraph
 * about someone's access controls.
 */

/** Where the database lives unless told otherwise. */
export const DEFAULT_DB = join(
  process.env.LONGITUDE_HOME ?? join(process.env.HOME ?? ".", ".longitude"),
  "longitude.db",
);

export function open(path: string = DEFAULT_DB): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });

  /**
   * WAL, and the rest of these are not cargo cult.
   *
   * An import writes ~2 million rows in one pass. Under the default rollback
   * journal with `synchronous=FULL`, SQLite fsyncs on every commit and the
   * import takes tens of minutes. WAL plus `synchronous=NORMAL` fsyncs at
   * checkpoints instead, which for a local file that can be rebuilt from the
   * export in minutes is the right trade.
   */
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Give the page cache real memory — the default 2 MB thrashes on a big index.
  db.exec("PRAGMA cache_size = -64000"); // 64 MB
  db.exec("PRAGMA foreign_keys = ON");

  return db;
}

/**
 * Apply the schema.
 *
 * `schema.sql` is entirely `CREATE ... IF NOT EXISTS`, so this is safe to run on
 * every open and doubles as the migration story for now: adding a table means
 * adding it to the file. When a real migration is needed — renaming a column,
 * backfilling — that will need versioning, and this comment is the marker for
 * where it goes.
 */
export function migrate(db: Database, schemaPath?: string): void {
  const path = schemaPath ?? new URL("./schema.sql", import.meta.url).pathname;
  const sql = require("node:fs").readFileSync(path, "utf8");
  db.exec(sql);
}

/** Open and migrate in one step, which is what every caller actually wants. */
export function connect(path?: string): Database {
  const db = open(path);
  migrate(db);
  return db;
}
