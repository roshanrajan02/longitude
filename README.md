# Longitude

Your health data is scattered across a watch, a phone, and every provider you've
ever seen — and nothing holds the longitudinal view. Longitude unifies Apple
Health and Epic clinical records into one store and streams it to a live
dashboard.

**Status: everything except the watch app.** An export — including its GPS routes
and ECGs — imports into SQLite and publishes daily aggregates to a dashboard.
Clinical records pull from Epic over SMART on FHIR. The watchOS app is the one
remaining piece, and it needs a paid Apple Developer account.

## The architecture, and why it looks like this

Health data arrives on three very different clocks. Pretending otherwise
produces a dashboard that lies about how fresh it is.

```
  Apple Watch ──▶ watchOS app ──▶ site /api/health/ingest ──▶ live buffer
                  live ~5s                                        │
                  ambient ~15min                    dashboard reads it live
                                                                  │
  Epic FHIR ──────────────────────▶ SQLite on the laptop ◀── nightly drain
                  polled                (permanent archive)
```

### Why the watch posts to the site and not to the laptop

The obvious design has the watch talk to a server on your Mac. It does not
work, for a reason that only shows up in use: **the laptop is asleep whenever
you are out running.** An ingest endpoint on localhost is reachable on your home
network and nowhere else, which is the exact complement of when the interesting
data is produced.

So the site takes the writes — it is the only always-on part — and holds them in
a buffer measured in days. The laptop drains that into SQLite, which stays the
permanent, complete store. The tradeoff is deliberate and worth knowing: live
workout samples sit in Postgres for up to 72 hours before being collected.
Clinical records never leave the laptop at all.

### Why an iOS app is unavoidable

There is **no server-side Apple Health API**. HealthKit lives on the device, and
the only route to a backend is an app that reads it locally and uploads. No
webhook, no cloud endpoint, no OAuth flow to Apple.

### Why "continuous" means two different things

Apple Watch **duty-cycles the heart sensor to save battery** — at rest it samples
roughly every 3–7 minutes, and that interval isn't configurable. Outside a
workout there is no continuous data to stream, regardless of permissions.

During a workout it samples about every 5 seconds, and `HKWorkoutSession` is a
recognized session type that keeps a watchOS app running in the background.
Paired with `HKLiveWorkoutBuilder`, samples flow continuously.

So there are two modes, matched to how the data is actually produced:

| Mode | When | Latency | Mechanism |
|---|---|---|---|
| **Live** | During a workout | ~5 seconds | `HKWorkoutSession` + `HKAnchoredObjectQuery` |
| **Ambient** | Otherwise | ~15 minutes | Background delivery; 4x/hour with a complication installed |
| **Clinical** | Epic records | Hours | Polled; labs land weekly at most |

A dashboard showing a live pulse mid-run and a resting summary otherwise is more
honest than one implying monitoring that isn't happening.

### Why Epic is polled, not subscribed

Epic supports FHIR Subscriptions, but coverage is limited and instance-specific,
and production access goes through App Orchard review measured in weeks to
months. Patient-access OAuth via `fhir.epic.com` is the practical route — and
since clinical data changes weekly at most, polling costs nothing.

## Components

| Piece | Language | State |
|---|---|---|
| `src/parse.ts` — streaming XML parser | TypeScript (Bun) | done, 30 tests |
| `src/import.ts` — export → SQLite | TypeScript (Bun) | done |
| `src/query.ts` — aggregates | TypeScript (Bun) | done, 10 tests |
| `src/sync.ts` — publish to the dashboard | TypeScript (Bun) | done |
| `src/assets.ts` — GPX routes, ECG CSVs | TypeScript (Bun) | done, 20 tests |
| `src/epic.ts` — SMART on FHIR poller | TypeScript (Bun) | done, needs a client id |
| `src/serve.ts` — ingest API + SSE | TypeScript (Bun) | done, untested against a device |
| `ios/` — HealthKit reader, workout session | Swift | **not started — needs the Apple Developer account** |

## Usage

```
bun run src/cli.ts import ~/Downloads/apple_health_export/export.xml
bun run src/cli.ts stats
bun run src/cli.ts trend heart_rate --days 30
bun run src/cli.ts sync --dry-run      # what would be published
DATABASE_URL=… bun run src/cli.ts sync # publish it
bun run src/cli.ts serve               # ingest API for the watch app

bun run src/cli.ts epic login          # connect to your provider
bun run src/cli.ts epic pull           # fetch clinical records
```

`import` takes the zip Apple gives you directly, and pulls the GPS routes and
ECGs that sit alongside `export.xml` — neither is referenced inside it, so an
importer reading only that file silently discards both.

## Connecting Epic

Apple will not give you this. An export contains `ClinicalRecord` elements only
if Health Records is linked to a provider, and even then it is a snapshot rather
than something that keeps up. This talks to the health system directly, as you.

One-time setup, all free:

1. **Find your provider.** Epic publishes ~480 live endpoints:

   ```
   bun run src/cli.ts epic find "kaiser"
   ```

   It prints the two environment variables for each match.

2. **Register an app** at <https://fhir.epic.com> — patient-facing, no review for
   the sandbox. Redirect URI `http://localhost:4000/epic/callback`.

3. **Set the variables** and log in:

   ```
   export EPIC_CLIENT_ID=<client id>
   export EPIC_FHIR_BASE=<from step 1>
   export EPIC_AUTH_BASE=<from step 1>
   bun run src/cli.ts epic login
   ```

Your browser opens your provider's normal patient login. Nothing here ever sees
the password — the token comes back over a one-shot local redirect and is stored
in the database.

PKCE, not a client secret — this runs on your laptop, so anything compiled into
it is not secret, which is the case PKCE exists for.

## Nightly

`scripts/com.roshanrajan.longitude.plist` republishes aggregates and pulls Epic
at 05:10 local. Credentials come from `~/.longitude/env`, so none are written
into the script or the plist.

```
cp scripts/com.roshanrajan.longitude.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.roshanrajan.longitude.plist
```

The import stays manual, because Apple gives no way to trigger an export from a
Mac.

Measured against a real export: 839 MB, 1,970,457 records, imported in 28.7
seconds with every record reconciled against the source file.

A batch importer for the Apple Health export is also planned — it needs no iOS
app and backfills years of history in one pass, which the streaming path can't
do.

## Requirements

- [Bun](https://bun.sh) for the server — bundles SQLite and an HTTP server with
  no native dependencies to compile
- Xcode and an Apple Developer account ($99/yr) for the watch app; free
  provisioning works but expires every 7 days
- An Epic-based provider, and an app registered at `fhir.epic.com`

## Not yet installable by other people

Anyone can read this code, but running it currently means building the iOS app
yourself. Making it genuinely installable is a later problem — noted, not solved.

## Privacy

Data goes to a server you run. Nothing is sent anywhere else and there is no
telemetry. If you publish a dashboard, **you choose what it exposes** — the
intent is that clinical records stay private and only summary metrics are
publishable.

MIT licensed.
