#!/bin/bash
#
# Set one credential, and prove it landed.
#
# Separate from set-credentials.sh because a script that asks four questions
# fails four ways, and the only one that matters is the secret. This asks one
# thing, writes one key, and shows a fingerprint so you can see it took.
#
# Reads from /dev/tty rather than stdin. `read -rs` on plain stdin silently
# returns empty when stdin is not a terminal — which is how the last attempt
# appeared to work and changed nothing.
#
#   ./scripts/set-secret.sh cigna
#   ./scripts/set-secret.sh cigna PAYER_CLIENT_ID    # any key, not just secrets
#
set -uo pipefail

PROFILE="${1:-}"
KEY="${2:-PAYER_CLIENT_SECRET}"

if [ -z "$PROFILE" ]; then
  echo "usage: $0 <profile> [KEY]     e.g. $0 cigna" >&2
  exit 1
fi

FILE="$HOME/.longitude/$PROFILE.env"
mkdir -p "$HOME/.longitude"
chmod 700 "$HOME/.longitude"
[ -f "$FILE" ] || : > "$FILE"
chmod 600 "$FILE"

# A terminal is required for a hidden prompt. Saying so beats writing an empty
# value and reporting success.
if [ ! -r /dev/tty ]; then
  echo "No terminal available — run this directly in a shell." >&2
  exit 1
fi

SECRETISH=0
case "$KEY" in *SECRET*|*TOKEN*|*PASSWORD*) SECRETISH=1 ;; esac

echo "Setting $KEY in $FILE"

if [ "$SECRETISH" -eq 1 ]; then
  printf 'Paste the value (hidden, then press Enter): '
  IFS= read -rs VALUE < /dev/tty
  echo
else
  printf 'Value: '
  IFS= read -r VALUE < /dev/tty
fi

# Paste often carries a trailing newline or a stray space from the clipboard,
# and a secret with whitespace on the end fails authentication in a way that
# looks like a wrong secret rather than a wrong paste.
VALUE="$(printf '%s' "$VALUE" | tr -d '[:space:]')"

if [ -z "$VALUE" ]; then
  echo "Nothing entered — the file is unchanged." >&2
  exit 1
fi

# Rewrite the one line, keep everything else. Done with a temp file in the same
# directory so the replace is atomic and never leaves a half-written credential.
TMP="$(mktemp "$FILE.XXXXXX")"
chmod 600 "$TMP"

if grep -q "^export $KEY=" "$FILE" 2>/dev/null; then
  # awk rather than sed: a secret can contain characters sed would treat as
  # part of the replacement expression.
  awk -v k="$KEY" -v v="$VALUE" '
    $0 ~ "^export " k "=" { print "export " k "=\"" v "\""; next }
    { print }
  ' "$FILE" > "$TMP"
else
  cat "$FILE" > "$TMP"
  printf 'export %s="%s"\n' "$KEY" "$VALUE" >> "$TMP"
fi

mv "$TMP" "$FILE"
chmod 600 "$FILE"

HASH=$(printf '%s' "$VALUE" | shasum -a 256 | cut -c1-12)
echo
if [ "$SECRETISH" -eq 1 ]; then
  echo "  $KEY set — ${#VALUE} chars, ${VALUE:0:2}…${VALUE: -2}, sha256 $HASH"
else
  echo "  $KEY = $VALUE"
fi

# Read it back from the file rather than trusting the variable, so this
# confirms what was stored rather than what was typed.
STORED=$(sed -n "s/^export $KEY=\"\(.*\)\"$/\1/p" "$FILE" | head -1)
if [ "$STORED" = "$VALUE" ]; then
  echo "  verified in the file"
else
  echo "  WARNING: what is in the file does not match what was entered" >&2
  exit 1
fi

echo
echo "  source $FILE"
