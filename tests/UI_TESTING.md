# Testing the running GNOME UI

Run `./tests/validate.sh` for syntax, history regression tests, schema checks,
and packaging. Pointer interactions also need testing inside GNOME Shell:
Node tests do not exercise Clutter's event delivery or modal grabs.

## Reload edited code without logging out

1. Run `./install.sh` to update the installed extension.
2. Open Looking Glass with **Alt+F2**, `lg`, **Enter**.
3. In Evaluator, run the following, replacing the repository path:

   ```javascript
   await (await import('file:///absolute/path/to/winv/tests/reload-live.js')).reload()
   ```

4. Confirm `WinV UI reloaded`, close Looking Glass, and open **Super+V**.

The development helper imports a uniquely named temporary copy of the installed
JavaScript to bypass GJS's module cache, then replaces the running instance's
prototype and rebuilds its UI. History, settings, and clipboard monitoring stay
on the same instance. This is for UI/method edits; changes to enable-time setup,
schemas, or stylesheets need their own reload steps. The helper is not shipped
in the extension bundle.

## Desktop automation setup

Install [Cua Driver](https://cua.ai/docs/how-to-guides/driver/install), then run
`cua-driver doctor`. On GNOME Wayland, install its bundled helper:

```sh
~/.cua-driver/packages/current/wayland-helper/install.sh
```

After GNOME has loaded it, verify:

```sh
gnome-extensions info winrects@cua
```

It must show `State: ACTIVE`. Cua Driver 0.36 also requires the native Wayland
backend to be explicitly enabled when starting its daemon:

```sh
CUA_DRIVER_RS_ENABLE_WAYLAND=1 cua-driver serve
```

Use a named driver session and end it after testing. WinV is a Shell actor,
not an application window, so use desktop captures for the popup. For the
paste target, use an exact Text Editor window and its accessibility tree.
Take a fresh capture after each pointer action and verify the resulting state.

### Fractional-scaling caveat (Cua Driver 0.36)

On the tested multi-monitor setup, desktop capture dimensions were physical
pixels, while injected pointer positions used logical stage coordinates.
Passing screenshot coordinates unchanged caused clicks to miss the popup.
Inspect `[global.stage.width, global.stage.height]` in Looking Glass and compare
them with the capture's `screenshot_original_width/height`.

When that mismatch occurs, calculate the intended logical position as:

```text
logical x = screenshot x × stage width / screenshot width
logical y = screenshot y × stage height / screenshot height
```

The driver's capture mapping already multiplies input coordinates by
`original size / screenshot size`. Compensate its arguments by
`stage size / original size`, independently for each axis. Recheck the mapping
after changing the monitor setup. Confirm the pointer reaches the intended
control before treating an injected click as a test result.

## Interaction checks

Use uniquely named disposable entries such as `WINV-UI-TEST-delete-<run>`.
Filter to those entries when testing deletion; do not clear existing history.
Verify saved state after the 800 ms save debounce without printing unrelated
clipboard text. Restore any settings changed during testing.

| Check | Expected result |
| --- | --- |
| Copy text | New text appears, including when history is full |
| Search | Only matching entries are shown |
| Delete a filtered entry | Entry disappears, count updates, popup stays open |
| Delete an unfiltered entry | Only that entry disappears; no paste occurs |
| Reopen after deletion | Deleted entry remains absent |
| Pin, then unpin | Star and saved pin state change; popup stays open |
| Select a row with auto-paste off | Popup closes and clipboard contains the row text |
| Select a row with auto-paste on | Popup closes and text reaches a scratch editor |
| Click outside | Popup closes and modal input is released |
| Escape / arrows / Enter / Delete | Each keyboard action works in the popup |

The 2026-10-17 GNOME 50.5 Wayland session verified the mouse flows above,
including saved deletion/pin state and text arriving in a scratch editor.
Synthetic Escape events through the driver were inconclusive; keyboard behavior
must also be checked with physical input. Image capture/paste was not exercised
in that live session.
