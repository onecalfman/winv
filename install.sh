#!/bin/sh
# WinV Clipboard installer: copy files, compile schemas, free Super+V, enable.
# Re-run after editing the source in ~/dev/winv, then either log out/in
# (Wayland) or toggle the extension off/on to reload the code.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
UUID="winv@onecalfman"
LEGACY_UUID="winv@jonas.dev"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "→ installing $SRC to $DEST"
mkdir -p "$DEST/schemas"
cp "$SRC/extension.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$SRC/prefs.js" "$DEST/"
cp "$SRC/schemas/org.gnome.shell.extensions.winv.gschema.xml" "$DEST/schemas/"

echo "→ compiling schemas"
glib-compile-schemas "$DEST/schemas/"

echo "→ freeing Super+V (message tray keeps Super+M)"
cur="$(gsettings get org.gnome.shell.keybindings toggle-message-tray || echo "@as []")"
case "$cur" in
  *"<Super>v"*)
    gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
    echo "  toggle-message-tray is now ['<Super>m']"
    ;;
  *)
    echo "  already free ($cur)"
    ;;
esac

echo "→ enabling $UUID"
gnome-extensions enable "$UUID" || true

if gnome-extensions show "$LEGACY_UUID" >/dev/null 2>&1; then
  echo "→ disabling legacy $LEGACY_UUID"
  gnome-extensions disable "$LEGACY_UUID" || true
fi

echo "done. Press Super+V. On Wayland, log out/in the first time so the"
echo "Shell discovers the new extension."
