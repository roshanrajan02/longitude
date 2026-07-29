# Longitude

Your health data is scattered across a watch, a phone, and every provider you've
ever seen — and nothing holds the longitudinal view. Longitude unifies Apple
Health and Epic clinical records into one store and streams it to a live
dashboard.

**Status: in development.** Schema only; nothing runs yet.

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
| `src/` — ingest API, SQLite, SSE | TypeScript (Bun) | schema only |
| `ios/` — HealthKit reader, workout session | Swift | not started |
| `epic/` — FHIR patient-access poller | TypeScript | not started |
| `web/` — live dashboard | TypeScript | not started |

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
