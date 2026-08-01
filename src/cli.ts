import { connect, DEFAULT_DB } from "./db";
import { importExport } from "./import";
import { serve } from "./serve";
import { summary, recent, trend } from "./query";
import { buildRows, sync, drain, PUBLISHED_METRICS } from "./sync";
import { importClinical, importEcgs, importRoutes } from "./assets";
import { addProvider, listProviders, matchEndpoints, searchNpi } from "./providers";
import { timeline, type EventKind } from "./timeline";
import { documentStats, ingestDirectory, ingestFile, searchDocuments } from "./documents";
import { SOURCES, GROUPS as CATALOG_GROUPS, formatsNeeded } from "./catalog";
import { PAYERS, PAYER_RESOURCES, recordProviders } from "./claims";
import {
  authUrl,
  exchangeCode,
  loadToken,
  pkce,
  poll,
  saveToken,
  RESOURCES,
  storeResources,
  findProviders,
  authBaseFor,
  SANDBOX_AUTH,
  SANDBOX_BASE,
} from "./epic";
import { dirname } from "node:path";

/**
 * The command line.
 *
 * Three verbs, matching the three things you actually do: put data in, look at
 * what is there, and serve it.
 */

const [, , cmd, ...args] = process.argv;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const bar = (done: number, total: number, width = 28): string => {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return `[${"█".repeat(filled)}${"·".repeat(width - filled)}]`;
};

const human = (n: number): string => n.toLocaleString("en-US");

async function main() {
  const dbPath = flag("db") ?? DEFAULT_DB;

  switch (cmd) {
    case "import": {
      const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--db");
      if (!file) {
        console.error("usage: longitude import <path/to/export.xml> [--db path]");
        process.exit(1);
      }

      const db = connect(dbPath);

      /**
       * Accept the zip Apple actually hands you.
       *
       * The Health app produces `export.zip`; unzipping it first is a step that
       * exists only because the importer could not read one. Extracted to a temp
       * directory rather than streamed, because the routes and ECGs sit beside
       * export.xml inside the archive and are needed too.
       */
      let source = file;
      let temp: string | null = null;
      if (file.toLowerCase().endsWith(".zip")) {
        temp = `${require("node:os").tmpdir()}/longitude-${Date.now()}`;
        console.log(`unzipping ${file}…`);
        const unzip = Bun.spawnSync(["unzip", "-q", "-o", file, "-d", temp]);
        if (unzip.exitCode !== 0) {
          console.error(`could not unzip: ${new TextDecoder().decode(unzip.stderr)}`);
          process.exit(1);
        }
        // Apple nests everything under apple_health_export/.
        const nested = `${temp}/apple_health_export/export.xml`;
        source = (await Bun.file(nested).exists()) ? nested : `${temp}/export.xml`;
      }

      console.log(`importing ${source}`);
      console.log(`      into ${dbPath}\n`);

      let lastLine = 0;
      const result = await importExport(db, source, (p) => {
        // Throttled: writing a progress line per batch is itself measurable at
        // two million rows.
        const now = Date.now();
        if (now - lastLine < 250) return;
        lastLine = now;
        const pct = (p.bytesRead / p.totalBytes) * 100;
        process.stdout.write(
          `\r  ${bar(p.bytesRead, p.totalBytes)} ${pct.toFixed(1).padStart(5)}%  ` +
            `${human(p.samples)} samples  ${human(p.workouts)} workouts  ${human(p.skipped)} dup`,
        );
      });

      process.stdout.write("\r" + " ".repeat(100) + "\r");
      console.log(`  ${bar(1, 1)} 100.0%\n`);
      console.log(`  samples   ${human(result.samples).padStart(9)}`);
      console.log(`  sleep     ${human(result.sleep).padStart(9)}`);
      console.log(`  workouts  ${human(result.workouts).padStart(9)}`);
      console.log(`  daily     ${human(result.daily).padStart(9)}`);
      console.log(`  duplicates skipped ${human(result.skipped)}`);

      /**
       * The rest of the export directory.
       *
       * GPX routes and ECG CSVs sit beside export.xml and are referenced nowhere
       * inside it, so importing only that file quietly discards every outdoor
       * route and every cardiac recording.
       */
      const exportDir = dirname(source);
      const routes = await importRoutes(db, `${exportDir}/workout-routes`);
      const ecgs = await importEcgs(db, `${exportDir}/electrocardiograms`);
      if (routes.files > 0) {
        console.log(
          `  routes    ${human(routes.added).padStart(9)}  (${routes.linked} gave a workout its distance)`,
        );
      }
      if (ecgs.files > 0) console.log(`  ecg       ${human(ecgs.added).padStart(9)}`);

      // Present only once Health Records is linked to a provider. Silence when
      // there are none is correct — most exports have none.
      if (result.clinical.length > 0) {
        const clin = await importClinical(db, exportDir, result.clinical);
        console.log(
          `  clinical  ${human(clin.added).padStart(9)}  (${clin.files} resources` +
            `${clin.missing > 0 ? `, ${clin.missing} referenced but absent` : ""})`,
        );
      }

      console.log(`\n  done in ${(result.ms / 1000).toFixed(1)}s`);
      // The extracted copy is ~1 GB; leaving it behind would be rude.
      if (temp) require("node:fs").rmSync(temp, { recursive: true, force: true });
      db.close();
      break;
    }

    case "stats": {
      const db = connect(dbPath);
      const s = summary(db);
      if (s.samples === 0) {
        console.log("Nothing imported yet. Run: longitude import <export.xml>");
        db.close();
        break;
      }

      console.log(`${dbPath}\n`);
      console.log(`  ${human(s.samples).padStart(9)} samples`);
      console.log(`  ${human(s.sleepNights).padStart(9)} nights of sleep`);
      console.log(`  ${human(s.workouts).padStart(9)} workouts`);
      console.log(`  ${human(s.days).padStart(9)} days of activity rings`);
      console.log(`\n  covering ${s.firstDay} to ${s.lastDay}\n`);
      console.log("  top metrics");
      for (const t of s.topTypes) {
        console.log(`    ${human(t.n).padStart(9)}  ${t.type}`);
      }
      db.close();
      break;
    }

    case "trend": {
      const db = connect(dbPath);
      const type = args[0] && !args[0].startsWith("--") ? args[0] : "heart_rate";
      const days = Number(flag("days") ?? 30);
      const rows = trend(db, type, days);
      if (rows.length === 0) {
        console.log(`no ${type} in the last ${days} days`);
        db.close();
        break;
      }
      const max = Math.max(...rows.map((r) => r.avg));
      console.log(`${type}, daily average, last ${days} days\n`);
      for (const r of rows) {
        const w = Math.round((r.avg / max) * 40);
        console.log(`  ${r.day}  ${"▄".repeat(w).padEnd(40)} ${r.avg.toFixed(1)}`);
      }
      db.close();
      break;
    }

    case "sync": {
      const db = connect(dbPath);
      const days = Number(flag("days") ?? 120);
      const dry = args.includes("--dry-run");

      if (dry) {
        // Printed before anything leaves the machine, so what is published can
        // be inspected rather than trusted.
        const rows = buildRows(db, days);
        const byMetric = new Map<string, number>();
        for (const r of rows) byMetric.set(r.metric, (byMetric.get(r.metric) ?? 0) + 1);
        console.log(`would publish ${rows.length} rows across ${byMetric.size} metrics:\n`);
        for (const [m, n] of [...byMetric].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${String(n).padStart(5)} days  ${m}`);
        }
        console.log(`\nnothing else leaves this machine — see PUBLISHED_METRICS in src/sync.ts`);
        db.close();
        break;
      }

      const conn = process.env.DATABASE_URL;
      if (!conn) {
        console.error("DATABASE_URL is unset. Point it at the site's Postgres.");
        process.exit(1);
      }
      const r = await sync(db, conn, days);
      console.log(`published ${r.rows} rows, ${r.metrics} metrics, ${r.days} days in ${r.ms}ms`);
      db.close();
      break;
    }

    case "drain": {
      const db = connect(dbPath);
      // DIRECT_URL first — see the note in sync.ts about the pooler and
      // prepared statements surviving between runs.
      const conn = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
      if (!conn) {
        console.error("DIRECT_URL or DATABASE_URL must be set.");
        process.exit(1);
      }
      const r = await drain(db, conn);
      console.log(
        `drained ${r.fetched} buffered samples: ${r.added} new, ${r.deleted} removed from the buffer`,
      );
      db.close();
      break;
    }

    case "docs": {
      const db = connect(dbPath);
      const sub = args[0];

      if (sub === "add") {
        const target = args[1];
        if (!target) {
          console.error("usage: longitude docs add <file-or-directory> [--from 'Austin Regional Clinic']");
          process.exit(1);
        }
        const custodian = flag("from");
        const isDir = require("node:fs").statSync(target).isDirectory();

        if (isDir) {
          const r = await ingestDirectory(db, target, { dbPath, custodian });
          console.log(`  ${r.files} files → ${r.added} added, ${r.duplicates} already held`);
          if (r.unreadable > 0) {
            console.log(`  ${r.unreadable} stored but not readable — see: longitude docs stats`);
          }
        } else {
          const r = await ingestFile(db, target, { dbPath, custodian });
          if (r.duplicate) console.log(`  already held: ${r.title}`);
          else {
            console.log(`  ${r.format.padEnd(6)} ${r.title}`);
            console.log(`  ${r.chars.toLocaleString()} characters extracted`);
            if (r.problem) console.log(`  note: ${r.problem}`);
          }
        }
        db.close();
        break;
      }

      if (sub === "search") {
        const q = args.slice(1).join(" ");
        if (!q) {
          console.error('usage: longitude docs search "creatinine"');
          process.exit(1);
        }
        const hits = searchDocuments(db, q);
        if (hits.length === 0) {
          console.log(`nothing matching "${q}"`);
          db.close();
          break;
        }
        for (const h of hits) {
          console.log(`  ${(h.doc_date ?? "unknown").padEnd(11)} ${h.title.slice(0, 54)}`);
          console.log(`              ${h.snippet.replace(/\s+/g, " ").slice(0, 96)}`);
        }
        db.close();
        break;
      }

      if (sub === "stats") {
        const s = documentStats(db);
        if (s.byFormat.length === 0) {
          console.log("no documents held yet — longitude docs add <file>");
          db.close();
          break;
        }
        console.log("held:");
        for (const f of s.byFormat) {
          const mb = (f.bytes / 1e6).toFixed(1);
          console.log(
            `  ${String(f.n).padStart(5)}  ${f.format.padEnd(7)} ${mb.padStart(7)} MB` +
              (f.unreadable > 0 ? `   ${f.unreadable} unreadable` : ""),
          );
        }
        if (s.problems.length > 0) {
          console.log("\nheld but not readable:");
          for (const p of s.problems) console.log(`  ${String(p.n).padStart(5)}  ${p.extract_note}`);
          console.log("\n  The originals are kept. Extraction improves; a re-request does not.");
        }
        db.close();
        break;
      }

      console.log(`longitude docs add <path>       take in a file or a whole directory
longitude docs search <query>   full-text over everything extracted
longitude docs stats            what is held, and what could not be read

  Reads PDF, C-CDA, DICOM, RTF, HTML, CSV and plain text. Format is sniffed
  from the bytes, not the extension. Originals are never discarded.`);
      db.close();
      break;
    }

    case "sources": {
      const wantGroup = args[0];
      if (wantGroup === "formats") {
        console.log("formats the infrastructure must read:\n");
        for (const f of formatsNeeded()) {
          console.log(`  ${String(f.sources.length).padStart(2)}×  ${f.format}`);
        }
        break;
      }

      console.log(`${SOURCES.length} retrievable sources of your medical record.\n`);
      for (const g of CATALOG_GROUPS) {
        console.log(`${g.label.toUpperCase()}  — ${g.why}\n`);
        for (const key of g.keys) {
          const s = SOURCES.find((x) => x.key === key);
          if (!s) continue;
          const badge = s.access === "api" ? "API" : s.access === "portal" ? "web" : s.access === "request" ? "ask" : "phys";
          const cost = s.cost === "free" ? "" : ` (${s.cost})`;
          console.log(`  ${badge}  ${s.data}${cost}`);
          console.log(`       ${s.custodian} · ${s.formats.join(", ")}`);
          if (s.where) console.log(`       ${s.where}`);
          console.log(`       ${s.note}\n`);
        }
      }
      break;
    }

    case "payer": {
      const db = connect(dbPath);
      const sub = args[0];

      if (!sub || sub === "list") {
        console.log(`Insurers expose claims over FHIR. Claims name every provider who
billed for you -- including private practice -- which makes them the best
record locator an individual has.

`);
        for (const p of PAYERS) {
          console.log(`  ${p.name}`);
          console.log(`    register at ${p.portal}`);
          console.log(`    ${p.note}\n`);
        }
        console.log(`  Pulls: ${PAYER_RESOURCES.map((r) => r.type).join(", ")}\n`);
        console.log(`  Once registered:
    export PAYER_CLIENT_ID=<client id>
    export PAYER_FHIR_BASE=<from the portal>
    export PAYER_AUTH_BASE=<from the portal>
    longitude payer login
    longitude payer pull`);
        db.close();
        break;
      }

      const clientId = process.env.PAYER_CLIENT_ID;
      const fhirBase = process.env.PAYER_FHIR_BASE;
      const authBase = process.env.PAYER_AUTH_BASE;
      const redirectUri = "http://localhost:4000/epic/callback";

      if (sub === "login") {
        if (!clientId || !fhirBase || !authBase) {
          console.error("PAYER_CLIENT_ID, PAYER_FHIR_BASE and PAYER_AUTH_BASE must be set.");
          console.error("Run `longitude payer` for where to register.");
          process.exit(1);
        }
        const { verifier, challenge } = pkce();
        const state = Math.random().toString(36).slice(2);
        const url = authUrl({ authBase, clientId, redirectUri, challenge, state, aud: fhirBase });

        const done = Promise.withResolvers<string>();
        const server = Bun.serve({
          port: 4000,
          hostname: "127.0.0.1",
          fetch(req) {
            const u = new URL(req.url);
            if (u.searchParams.get("state") !== state) return new Response("state mismatch", { status: 400 });
            const code = u.searchParams.get("code");
            if (!code) return new Response("no code", { status: 400 });
            done.resolve(code);
            return new Response("<h3>Connected.</h3><p>Close this tab.</p>", {
              headers: { "content-type": "text/html" },
            });
          },
        });

        console.log(`opening your insurer's member login…\n  ${url}\n`);
        Bun.spawn(["open", url]);
        const code = await done.promise;
        server.stop();

        const token = await exchangeCode({ authBase, clientId, redirectUri, code, verifier });
        saveToken(db, fhirBase, token);
        console.log(`connected. member ${token.patient ?? "(none returned)"}`);
        db.close();
        break;
      }

      if (sub === "pull") {
        const token = loadToken(db, fhirBase ?? "");
        if (!token?.patient) {
          console.error("not connected — run: longitude payer login");
          process.exit(1);
        }

        const eobs: Record<string, unknown>[] = [];
        for (const r of PAYER_RESOURCES) {
          try {
            const got = await fetchAll(fhirBase!, token.access_token, r.type, token.patient);
            console.log(`  ${r.type.padEnd(22)} ${String(got.length).padStart(5)}`);
            if (r.type === "ExplanationOfBenefit") eobs.push(...got);
            else storeResources(db, fhirBase!, got);
          } catch (err) {
            // Payers differ in what they expose; one 404 must not lose the rest.
            console.log(`  ${r.type.padEnd(22)}     — ${String(err).slice(0, 44)}`);
          }
        }

        if (eobs.length > 0) {
          storeResources(db, fhirBase!, eobs);
          const scan = recordProviders(db, eobs, "claims");
          console.log(`\n  ${scan.claims} claims → ${scan.providers} distinct providers, ${scan.added} new`);
          if (scan.earliest) console.log(`  covering ${scan.earliest.slice(0, 10)} to ${scan.latest?.slice(0, 10)}`);
          console.log(`\n  longitude providers        see them`);
          console.log(`  longitude providers match  find which have an API`);
        }
        db.close();
        break;
      }

      console.error(`unknown: longitude payer ${sub}`);
      process.exit(1);
    }

    case "timeline": {
      const db = connect(dbPath);
      const kinds = flag("kind")?.split(",") as EventKind[] | undefined;
      const events = timeline(db, { limit: Number(flag("limit") ?? 40), kinds, since: flag("since") });

      if (events.length === 0) {
        console.log("nothing on the timeline yet");
        db.close();
        break;
      }

      const MARK: Record<string, string> = {
        clinical: "◆",
        workout: "▲",
        ecg: "♥",
        device: "○",
        gap: "·",
        milestone: "★",
      };

      let year = "";
      for (const e of events) {
        const y = e.at.slice(0, 4);
        if (y !== year) {
          console.log(`\n${y}`);
          year = y;
        }
        console.log(`  ${e.at.slice(5, 10)}  ${MARK[e.kind] ?? " "}  ${e.title.slice(0, 52)}`);
        if (e.detail) console.log(`${" ".repeat(14)}${e.detail.slice(0, 60)}`);
      }
      console.log(`\n  ◆ clinical   ▲ workout   ♥ ecg   ○ device   · gap`);
      db.close();
      break;
    }

    case "providers": {
      const db = connect(dbPath);
      const sub = args[0];

      if (sub === "find") {
        const name = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
        const rows = await searchNpi({ name, state: flag("state"), city: flag("city") });
        if (rows.length === 0) {
          console.log("no match in the NPI registry — try fewer words, or add --state");
          db.close();
          break;
        }
        for (const r of rows.slice(0, 15)) {
          console.log(`  ${r.npi}  ${r.name.slice(0, 42).padEnd(44)} ${r.city ?? ""}, ${r.state ?? ""}`);
          if (r.specialty) console.log(`${" ".repeat(14)}${r.specialty}`);
        }
        console.log(`\n  add one with: longitude providers add <npi>`);
        db.close();
        break;
      }

      if (sub === "add") {
        const npi = args[1];
        if (!npi) {
          console.error("usage: longitude providers add <npi>");
          process.exit(1);
        }
        const [found] = await searchNpi({ name: undefined, limit: 1 }).catch(() => []);
        // Looked up by number directly rather than by name.
        const res = await fetch(
          `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${encodeURIComponent(npi)}`,
        );
        const data = (await res.json()) as { results?: unknown[] };
        if (!data.results?.length) {
          console.error(`no provider with NPI ${npi}`);
          process.exit(1);
        }
        const r = data.results[0] as Record<string, any>;
        const b = r.basic ?? {};
        const addr = (r.addresses ?? [{}])[0];
        const tax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? (r.taxonomies ?? [])[0];
        const added = addProvider(db, {
          npi: r.number,
          name: (b.organization_name ?? `${b.first_name ?? ""} ${b.last_name ?? ""}`).trim(),
          kind: r.enumeration_type === "NPI-2" ? "organization" : "individual",
          specialty: tax?.desc ?? null,
          city: addr.city ?? null,
          state: addr.state ?? null,
          source: "npi",
        });
        console.log(added.added ? "added" : "already recorded");
        db.close();
        break;
      }

      if (sub === "match") {
        const r = await matchEndpoints(db);
        console.log(`checked ${r.checked}, matched ${r.matched} to a FHIR endpoint`);
        if (r.checked > r.matched) {
          console.log(
            `\n  ${r.checked - r.matched} without an API. That is normal — most small` +
              `\n  practices have none. Those records are still yours by law: send a` +
              `\n  written request under HIPAA's right of access and they must respond` +
              `\n  within 30 days.`,
          );
        }
        db.close();
        break;
      }

      const rows = listProviders(db);
      if (rows.length === 0) {
        console.log(`No providers recorded yet.

  The problem this solves: nobody remembers every clinic they have been to.

  Most complete source is your insurer — every provider who billed for you,
  private practices included. Then:

    longitude providers find "austin regional" --state TX
    longitude providers add <npi>
    longitude providers match      cross-reference against known FHIR endpoints`);
        db.close();
        break;
      }
      for (const r of rows) {
        const mark = r.fhir_base ? "API" : "  —";
        console.log(`  ${mark}  ${r.name.slice(0, 40).padEnd(42)} ${r.city ?? ""} ${r.state ?? ""}`);
      }
      console.log(`\n  ${rows.filter((r) => r.fhir_base).length} of ${rows.length} have a known API`);
      db.close();
      break;
    }

    case "epic": {
      const sub = args[0];
      const db = connect(dbPath);
      const fhirBase = process.env.EPIC_FHIR_BASE ?? SANDBOX_BASE;
      const authBase = process.env.EPIC_AUTH_BASE ?? SANDBOX_AUTH;
      const clientId = process.env.EPIC_CLIENT_ID;
      const redirectUri = "http://localhost:4000/epic/callback";

      if (sub === "login") {
        if (!clientId) {
          console.error(
            "EPIC_CLIENT_ID is unset.\n\n" +
              "  1. Register a patient-facing app at https://fhir.epic.com\n" +
              `  2. Set its redirect URI to ${redirectUri}\n` +
              "  3. export EPIC_CLIENT_ID=<the client id>",
          );
          process.exit(1);
        }

        const { verifier, challenge } = pkce();
        const state = Math.random().toString(36).slice(2);
        const url = authUrl({ authBase, clientId, redirectUri, challenge, state, aud: fhirBase });

        /**
         * A one-shot server for the redirect.
         *
         * The alternative is asking you to copy a code out of a URL bar, which
         * works and is unpleasant. This listens, takes the code, and stops.
         */
        const done = Promise.withResolvers<string>();
        const server = Bun.serve({
          port: 4000,
          hostname: "127.0.0.1",
          fetch(req) {
            const u = new URL(req.url);
            if (u.pathname !== "/epic/callback") return new Response("", { status: 404 });
            if (u.searchParams.get("state") !== state) {
              return new Response("state mismatch", { status: 400 });
            }
            const code = u.searchParams.get("code");
            if (!code) return new Response("no code", { status: 400 });
            done.resolve(code);
            return new Response(
              "<h3>Connected.</h3><p>You can close this tab and return to the terminal.</p>",
              { headers: { "content-type": "text/html" } },
            );
          },
        });

        console.log("opening your provider's login page…\n");
        console.log(`  if it does not open: ${url}\n`);
        Bun.spawn(["open", url]);

        const code = await done.promise;
        server.stop();

        const token = await exchangeCode({ authBase, clientId, redirectUri, code, verifier });
        saveToken(db, fhirBase, token);
        console.log(`connected. patient ${token.patient ?? "(none returned)"}`);
        db.close();
        break;
      }

      if (sub === "pull") {
        if (!clientId) {
          console.error("EPIC_CLIENT_ID is unset.");
          process.exit(1);
        }
        const r = await poll(db, { fhirBase, authBase, clientId });
        for (const [type, v] of Object.entries(r.byType)) {
          console.log(`  ${type.padEnd(20)} ${String(v.fetched).padStart(5)} fetched  ${v.added} new`);
        }
        console.log(`\n  ${r.total} resources, ${r.added} new`);
        db.close();
        break;
      }

      if (sub === "find") {
        const query = args.slice(1).join(" ");
        if (!query) {
          console.error('usage: longitude epic find "kaiser"');
          process.exit(1);
        }
        const found = await findProviders(query);
        if (found.length === 0) {
          console.log(`no Epic provider matching "${query}"`);
          console.log("Try a shorter search — the directory uses official names.");
          db.close();
          break;
        }
        console.log(`${found.length} match${found.length === 1 ? "" : "es"}:\n`);
        for (const p of found.slice(0, 25)) {
          console.log(`  ${p.name}`);
          console.log(`    EPIC_FHIR_BASE=${p.fhirBase}`);
          console.log(`    EPIC_AUTH_BASE=${authBaseFor(p.fhirBase)}\n`);
        }
        if (found.length > 25) console.log(`  …and ${found.length - 25} more`);
        db.close();
        break;
      }

      if (sub === "status") {
        const token = loadToken(db, fhirBase);
        const rows = db
          .prepare(`SELECT resource_type t, COUNT(*) n FROM clinical GROUP BY t ORDER BY n DESC`)
          .all() as { t: string; n: number }[];
        console.log(`endpoint  ${fhirBase}`);
        console.log(
          `connected ${token ? `yes, patient ${token.patient ?? "?"}` : "no — run: longitude epic login"}`,
        );
        if (rows.length) {
          console.log("\nstored:");
          for (const r of rows) console.log(`  ${String(r.n).padStart(5)}  ${r.t}`);
        } else {
          console.log("\nnothing pulled yet");
        }
        db.close();
        break;
      }

      console.log(`longitude epic find <q>  search Epic's directory for your provider
longitude epic login    connect to your provider
longitude epic pull     fetch clinical records
longitude epic status   what is connected and stored

  Resources pulled: ${RESOURCES.map((r) => r.type).join(", ")}

  EPIC_CLIENT_ID   from https://fhir.epic.com
  EPIC_FHIR_BASE   your provider's FHIR base (defaults to Epic's sandbox)
  EPIC_AUTH_BASE   your provider's OAuth base`);
      db.close();
      break;
    }

    case "serve": {
      const port = Number(flag("port") ?? 4000);
      serve({ dbPath, port });
      break;
    }

    default:
      console.log(`longitude — one store for your health data

  longitude import <export.xml>   load an Apple Health export
  longitude stats                 what's in the database
  longitude trend [type]          daily averages as a chart
  longitude sync [--dry-run]      publish daily aggregates to the site
  longitude drain                 pull watch samples from the site into SQLite
  longitude sources               what is retrievable, and how
  longitude docs <add|search>     take in PDFs, C-CDAs, DICOM, notes
  longitude payer <login|pull>    claims from your insurer = who you have seen
  longitude timeline              your medical history, in order
  longitude providers             work out where your records are
  longitude epic <login|pull>     clinical records from your provider
  longitude serve                 ingest API + live stream

  --db <path>    database file (default ${DEFAULT_DB})
  --port <n>     serve port (default 4000)
  --days <n>     trend window (default 30)
`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
