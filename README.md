# WinV Clipboard

Windows-style **Super+V** clipboard history for GNOME — designed fresh, not
another clunky top-bar menu.

- **Floating card panel** (Adwaita-native, dimmed backdrop) that opens next to
  your text caret — falling back to the mouse pointer, then screen center
  (toggle with *Open near text caret* in preferences)
- **Top bar button** next to the system icons for mouse-driven access
  (toggle with *Top bar icon* in preferences)
- **Text + image thumbnails**, inline previews
- **Type to search**, ↑↓ navigate, Enter paste
- **Auto-paste** into the focused app via virtual keyboard (Ctrl+V)
- **Pin** (`Ctrl+P`), **delete** (`Del`), clear, private mode
- **Password-manager aware** — skips content marked sensitive
- No top-bar icon. It stays out of the way until Super+V.

## Layout

```
winv/
├── extension.js      # panel UI, clipboard watching, auto-paste
├── prefs.js          # libadwaita preferences (GTK4)
├── metadata.json
├── stylesheet.css
├── schemas/org.gnome.shell.extensions.winv.gschema.xml
└── install.sh        # link, compile schemas, free Super+V, enable
```

History lives in `~/.cache/winv@jonas.dev/` (`history.json` + `images/`),
trimmed to your history size. Pinned items are never evicted.

## Install

```sh
./install.sh
```

The script:
1. Symlinks the source into `~/.local/share/gnome-shell/extensions/winv@jonas.dev`
2. Compiles the GSettings schema
3. Frees **Super+V** (`toggle-message-tray` keeps Super+M)
4. Enables the extension

On Wayland, log out and back in if the Shell doesn't pick it up immediately.

## Use

| Key | Action |
| --- | ------ |
| Super+V | Toggle panel |
| ↑ / ↓ | Move selection |
| Enter | Paste into focused app |
| Ctrl+P | Pin / unpin |
| Del (empty search) or Ctrl+Del | Delete entry |
| Esc | Clear search, then close |

Footer buttons: private mode (pause recording), clear history, preferences.

## Uninstall

```sh
gnome-extensions disable winv@jonas.dev
rm ~/.local/share/gnome-shell/extensions/winv@jonas.dev
gsettings reset org.gnome.shell.keybindings toggle-message-tray
```

## Notes

- GNOME Shell 46–50, Wayland-first (X11 works too).
- Images paste back as the MIME type they were copied as
  (`image/png`, `image/jpeg`, `image/bmp`, `image/tiff`). Most apps accept
  this; a few expect `text/uri-list` and won't take the paste.
- Auto-paste waits ~220 ms after setting the clipboard so the new content
  propagates before the synthetic Ctrl+V. Bump `PASTE_DELAY_MS` in
  `extension.js` if pastes land too early on your machine.
