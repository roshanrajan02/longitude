#!/bin/bash
#
# Store payer or provider credentials without them touching a screen, a chat,
# or a shell history file.
#
# `read -rsp` keeps the secret off the terminal and out of ~/.bash_history,
# which the obvious alternative — `export SECRET=...` typed at a prompt — does
# not. The file is written 0600 and lives outside every git repository, so
# there is no path by which it reaches a commit.
#
# Nothing here ever prints a secret back. Confirmation is a length and a hash
# prefix, which is enough to tell a typo from a correct paste and useless to
# anyone reading over your shoulder.
#
#   ./scripts/set-credentials.sh cigna
#   ./scripts/set-credentials.sh aetna
#
set -uo pipefail

PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  echo "usage: $0 <profile>      e.g. cigna, aetna, epic" >&2
  exit 1
fi

DIR="$HOME/.longitude"
FILE="$DIR/$PROFILE.env"
mkdir -p "$DIR"
chmod 700 "$DIR"

# Keep whatever is already set, so re-running to change one value does not
# silently blank the others.
existing() {
  [ -f "$FILE" ] || return 0
  sed -n "s/^export $1=\"\(.*\)\"$/\1/p" "$FILE" | head -1
}

CUR_BASE="$(existing PAYER_FHIR_BASE)"

# Known production bases, so the common case is a keypress rather than a hunt
# through a portal that may not list it. Cigna's is not documented anywhere a
# patient would look; it was found by probing and confirmed by its OAuth host
# differing from the sandbox one (p-hi2 rather than r-hi2).
case "$PROFILE" in
  cigna) SUGGESTED="https://fhir.cigna.com/PatientAccess/v1" ;;
  aetna) SUGGESTED="https://vteapif1.aetna.com/fhirdemo/v1/patientaccess" ;;
  *)     SUGGESTED="" ;;
esac
CUR_ID="$(existing PAYER_CLIENT_ID)"
CUR_REDIRECT="$(existing PAYER_REDIRECT_URI)"

fingerprint() {
  local v="$1"
  if [ -z "$v" ]; then echo "(empty)"; return; fi
  local h
  h=$(printf '%s' "$v" | shasum -a 256 | cut -c1-12)
  echo "${#v} chars, ${v:0:2}…${v: -2}, sha256 $h"
}

echo "Credentials for: $PROFILE"
echo "Stored in:       $FILE"
echo

# --- FHIR base ---------------------------------------------------------------
# Skippable. The base can be filled in later, and refusing to store a secret
# until an unrelated field is known just means the secret gets pasted somewhere
# worse in the meantime.
DEFAULT_BASE="${CUR_BASE:-$SUGGESTED}"
printf 'FHIR base URL%s\n  (Enter to accept, "-" to leave blank): ' \
  "$([ -n "$DEFAULT_BASE" ] && echo " [$DEFAULT_BASE]")"
read -r BASE
if [ "$BASE" = "-" ]; then
  BASE=""
else
  BASE="${BASE:-$DEFAULT_BASE}"
fi
# A trailing slash doubles up when a resource path is appended, and a trailing
# period is what got the first redirect URI rejected. Strip both.
[ -n "$BASE" ] && BASE="$(printf '%s' "$BASE" | sed 's#[/.]*$##')"

# --- client id ---------------------------------------------------------------
printf 'Client ID%s: ' "$([ -n "$CUR_ID" ] && echo " [$CUR_ID]")"
read -r CLIENT_ID
CLIENT_ID="${CLIENT_ID:-$CUR_ID}"

# --- client secret -----------------------------------------------------------
# -s so it is never displayed; -p so the prompt still appears.
printf 'Client secret (input hidden, Enter to keep existing): '
read -rs SECRET
echo
if [ -z "$SECRET" ]; then
  SECRET="$(existing PAYER_CLIENT_SECRET)"
  [ -n "$SECRET" ] && echo "  keeping the existing secret"
fi

# --- redirect ----------------------------------------------------------------
DEFAULT_REDIRECT="${CUR_REDIRECT:-https://roshanrajan.com/callback}"
printf 'Redirect URI [%s]: ' "$DEFAULT_REDIRECT"
read -r REDIRECT
REDIRECT="${REDIRECT:-$DEFAULT_REDIRECT}"
# Must match the registration character for character; a trailing period or
# slash is a different URL to an OAuth server, rejected without explanation.
REDIRECT="$(printf '%s' "$REDIRECT" | sed 's#[.]*$##')"

# --- write -------------------------------------------------------------------
# umask first, so the file is never briefly world-readable between creation and
# chmod. A race nobody would notice and which costs nothing to avoid.
OLD_UMASK=$(umask)
umask 077

cat > "$FILE" <<ENV
# $PROFILE — written by scripts/set-credentials.sh
# Contains a secret. Mode 0600, outside every git repository.
# Load with:  source $FILE

export PAYER_FHIR_BASE="$BASE"
export PAYER_CLIENT_ID="$CLIENT_ID"
export PAYER_CLIENT_SECRET="$SECRET"
export PAYER_REDIRECT_URI="$REDIRECT"

# The redirect points at a website rather than this machine, so the code comes
# back by hand. The exchange has to happen locally because it needs the secret.
export PAYER_PASTE_CODE=1
ENV

umask "$OLD_UMASK"
chmod 600 "$FILE"

echo
echo "Written."
echo "  base     ${BASE:-(not set — add it before payer login)}"
echo "  client   $CLIENT_ID"
echo "  secret   $(fingerprint "$SECRET")"
echo "  redirect $REDIRECT"
echo "  mode     $(stat -f '%Lp' "$FILE")"
echo
echo "Next:"
echo "  source $FILE"
if [ -z "$BASE" ]; then
  echo "  # then re-run this script to add the FHIR base when you have it"
else
  echo "  bun run src/cli.ts payer check"
  echo "  bun run src/cli.ts payer login"
fi
