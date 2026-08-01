#!/bin/bash
#
# Nightly publish.
#
# The export itself is manual — Apple gives no way to trigger one from a Mac, so
# the import stays a thing you run after generating a fresh export on the phone.
# What can be automated is everything after that: republish the aggregates, and
# pull clinical records if a provider is connected.
#
# Reads DATABASE_URL and any EPIC_* variables from ~/.longitude/env, so no
# credential is written into this file or into the plist.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# launchd runs with a minimal PATH that has no bun in it. Absolute, with a
# lookup fallback for anyone whose install lives elsewhere.
BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || BUN="$(command -v bun 2>/dev/null)"
if [ -z "${BUN:-}" ] || [ ! -x "$BUN" ]; then
  echo "$(date -u +%FT%TZ) bun not found; cannot run" >&2
  exit 1
fi
[ -f "$HOME/.longitude/env" ] && set -a && . "$HOME/.longitude/env" && set +a

stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

if [ -n "${DATABASE_URL:-}${DIRECT_URL:-}" ]; then
  # Drain first. Anything the watch posted becomes part of the archive before
  # the aggregates are recomputed, so today's numbers include today's workout.
  echo "$(stamp) drain: $("$BUN" run src/cli.ts drain 2>&1 | tail -1)"
  echo "$(stamp) sync:  $("$BUN" run src/cli.ts sync --days 120 2>&1 | tail -1)"
else
  echo "$(stamp) skipped, no database URL"
fi

# Only when a provider is actually configured. Absence is the normal case until
# an app is registered at fhir.epic.com.
if [ -n "${EPIC_CLIENT_ID:-}" ]; then
  echo "$(stamp) epic: $("$BUN" run src/cli.ts epic pull 2>&1 | tail -1)"
fi
