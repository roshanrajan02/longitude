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
  Apple Watch ──┐
                │  live: ~5s during workouts
                ├──▶ watchOS/iOS app ──▶ ingest API ──▶ SQLite ──▶ SSE ──▶ site
                │  ambient: ~4x/hour
  Epic FHIR ────┘  polled every few hours
```

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

One-time setup, all free:

1. Register a patient-facing app at <https://fhir.epic.com>
2. Set its redirect URI to `http://localhost:4000/epic/callback`
3. `export EPIC_CLIENT_ID=<client id>` and, for a real provider,
   `EPIC_FHIR_BASE` / `EPIC_AUTH_BASE`
4. `bun run src/cli.ts epic login`

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
