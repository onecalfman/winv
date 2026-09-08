#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID=$(jq -r '.uuid' "$ROOT/metadata.json")
SCHEMA="$ROOT/schemas/org.gnome.shell.extensions.winv.gschema.xml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf '%s\n' 'Checking JavaScript syntax...'
node --check "$ROOT/extension.js"
node --check "$ROOT/prefs.js"

printf '%s\n' 'Checking extension metadata...'
test "$UUID" = 'winv@onecalfman'
jq -e --arg uuid "$UUID" \
    '.uuid == $uuid and (.name | length > 0) and (."shell-version" | index("50")) != null' \
    "$ROOT/metadata.json" >/dev/null

printf '%s\n' 'Checking schema keys...'
grep -q 'id="org.gnome.shell.extensions.winv"' "$SCHEMA"
for key in history-size toggle-menu private-mode capture-images paste-on-selection ignore-password-mimes strip-text show-indicator follow-caret; do
    grep -q "name=\"$key\"" "$SCHEMA"
done

printf '%s\n' 'Compiling GSettings schema...'
cp "$SCHEMA" "$TMP/"
glib-compile-schemas --strict "$TMP"
test -s "$TMP/gschemas.compiled"

printf '%s\n' 'Building extension bundle...'
mkdir "$TMP/dist"
gnome-extensions pack "$ROOT" --force --out-dir "$TMP/dist" >/dev/null
BUNDLE="$TMP/dist/$UUID.shell-extension.zip"
test -s "$BUNDLE"
unzip -t "$BUNDLE" >/dev/null
unzip -Z1 "$BUNDLE" | grep -q '^extension.js$'
unzip -Z1 "$BUNDLE" | grep -q '^schemas/org.gnome.shell.extensions.winv.gschema.xml$'

printf '%s\n' 'Validation passed.'
