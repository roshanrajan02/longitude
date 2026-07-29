# Longitude

Your health data is scattered across an iPhone, a watch, and every provider you've
ever seen — and none of them hold the longitudinal view. Longitude pulls it into
one local SQLite database and serves it as JSON your dashboard can read.

**Everything stays on your machine.** No account, no cloud, no telemetry. The
privacy story is the architecture, not a policy.

## Requirements

[Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

Chosen because it bundles SQLite and an HTTP server with no native dependencies
to compile. One install and the project runs.

## Quick start

1. On your iPhone: **Health app → your photo (top right) → Export All Health Data**.
   It produces `export.zip`. Expect it to take a few minutes and be large — years
   of Apple Watch data is often several hundred MB, because heart rate alone
   samples every few minutes.

2. Unzip it and point Longitude at the folder:

   ```bash
   bun run import ~/Downloads/apple_health_export
   ```

3. Serve it:

   ```bash
   bun run serve
   ```

   JSON API on `http://localhost:4000`, with a plain UI at the root.

## Why the Apple Health export, and not APIs

Whoop, Fitbit, and Garmin all require a registered developer app with a client
secret. An open-source tool can't ship one, so every user would have to register
their own developer app before anything worked — a detour most people abandon.

The Apple Health export needs no registration, no OAuth, and no approval, and it
already contains everything the Watch records. If you've linked providers in
Health Records, it contains your **clinical records as FHIR resources** too.

Sources that issue personal access tokens (Oura) can be pulled directly. See
`src/adapters/` for the interface if you want to add one.
