import { connect, DEFAULT_DB } from "./db";
import { importExport } from "./import";
import { serve } from "./serve";
import { summary, recent, trend } from "./query";
import { buildRows, sync, PUBLISHED_METRICS } from "./sync";

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
      console.log(`importing ${file}`);
      console.log(`      into ${dbPath}\n`);

      let lastLine = 0;
      const result = await importExport(db, file, (p) => {
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
      console.log(`\n  done in ${(result.ms / 1000).toFixed(1)}s`);
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
