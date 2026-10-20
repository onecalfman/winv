# WinV Clipboard

[![CI](https://github.com/onecalfman/winv/actions/workflows/test.yml/badge.svg)](https://github.com/onecalfman/winv/actions/workflows/test.yml)

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

History lives in `~/.cache/winv@onecalfman/` (`history.json` + `images/`). On
upgrade, WinV migrates the previous `~/.cache/winv@jonas.dev/` history once,
trimmed to your history size. Pinned items are never evicted.

## Install

```sh
./install.sh
```

The script:
1. Installs the source into `~/.local/share/gnome-shell/extensions/winv@onecalfman`
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
| Esc | Close panel |

Footer buttons: private mode (pause recording), clear history, preferences.
Click outside the popup to dismiss it.

## Development

Run `./tests/validate.sh` for automated checks. See
[UI testing](tests/UI_TESTING.md) for real desktop interaction checks and
reloading edited UI code without logging out.

GitHub Actions runs validation on every push and pull request with Node.js 22
and 24: JavaScript syntax, clipboard history regression tests, GSettings schema
compilation, and extension packaging. ShellCheck also checks the installer and
validation scripts. Tagging a release runs those checks before publishing the
extension ZIP.

## Uninstall

```sh
gnome-extensions disable winv@onecalfman
rm -rf ~/.local/share/gnome-shell/extensions/winv@onecalfman
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
# CI validation scope

`tests/validate.sh` still runs all local checks by default. CI runs its
`javascript` mode on both Node 22 and 24, and `package` mode plus ShellCheck
once on Ubuntu 24.04. Metadata, schema compilation, bundle creation and ZIP
content checks are unchanged; GNOME/system-tool setup is no longer duplicated
for the Node matrix. `just test-ci` checks this contract.

Local equivalent-work measurement (2026-10-20, Linux, three sequential pairs):
the former two complete validations took median 0.478s; two Node validations
plus one packaging validation took 0.410s. This small check-time difference is
not the principal benefit: it excludes system setup, which historical GitHub
jobs spent 30–61s doing **twice**. A fresh CI run must establish actual runner
savings; the additional packaging job can add pickup/checkout latency, so no
end-to-end speedup is claimed from the local timing. Revert the workflow and
mode split together to restore the original schedule. No runtime extension or
release workflow was changed.
