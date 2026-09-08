/* WinV Clipboard preferences — GTK4 + libadwaita. */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WinVPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        // --- Behaviour group ---
        const behaviour = new Adw.PreferencesGroup({ title: 'Behaviour' });
        page.add(behaviour);

        const historyRow = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Pinned items are always kept',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 500, step_increment: 5,
                value: settings.get_int('history-size'),
            }),
        });
        historyRow.connect('notify::value', () =>
            settings.set_int('history-size', Math.round(historyRow.value)),
        );
        behaviour.add(historyRow);

        const switchRow = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({ title, subtitle, active: settings.get_boolean(key) });
            row.connect('notify::active', () => settings.set_boolean(key, row.active));
            settings.connect(`changed::${key}`, () => {
                if (row.active !== settings.get_boolean(key))
                    row.active = settings.get_boolean(key);
            });
            behaviour.add(row);
            return row;
        };

        switchRow('Auto-paste on select', 'Paste into the focused app right away', 'paste-on-selection');
        switchRow('Top bar icon', 'Show a clipboard button in the top bar', 'show-indicator');
        switchRow('Open near text caret', 'Panel appears by the field you type in', 'follow-caret');
        switchRow('Capture images', 'Keep copied images with thumbnails', 'capture-images');
        switchRow('Private mode', 'Pause recording new copies', 'private-mode');
        switchRow('Ignore password managers', 'Skip content marked sensitive', 'ignore-password-mimes');
        switchRow('Trim whitespace', 'Strip leading/trailing space from text', 'strip-text');

        // --- Shortcut group ---
        const shortcut = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'Windows-style binding. Make sure Super+V is not used by anything else.',
        });
        page.add(shortcut);

        // ActionRow subtitles are parsed as Pango markup, so escape
        // accelerator strings like "<Super>v".
        const accelLabel = () =>
            GLib.markup_escape_text(settings.get_strv('toggle-menu')[0] ?? 'unset', -1);
        const shortcutRow = new Adw.ActionRow({
            title: 'Toggle clipboard panel',
            subtitle: accelLabel(),
        });
        const changeBtn = new Gtk.Button({ label: 'Change…', valign: Gtk.Align.CENTER });
        shortcutRow.add_suffix(changeBtn);
        shortcut.add(shortcutRow);

        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: 'Press a key combination',
            body: 'Super+V is the Windows-style default. Escape cancels.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.set_response_appearance('cancel', Adw.ResponseAppearance.SUGGESTED);

        const capture = new Gtk.EventControllerKey();
        dialog.add_controller(capture);
        capture.connect('key-pressed', (_c, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Strip caps/num lock noise.
            state &= Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name_with_keycode(
                null, keyval, keycode, state,
            );
            if (accel && accel !== '') {
                settings.set_strv('toggle-menu', [accel]);
                shortcutRow.subtitle = accelLabel();
            }
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        changeBtn.connect('clicked', () => dialog.present());

        settings.connect('changed::toggle-menu', () => {
            shortcutRow.subtitle = accelLabel();
        });

        // --- Danger zone ---
        const danger = new Adw.PreferencesGroup({ title: 'History' });
        page.add(danger);
        const clearRow = new Adw.ActionRow({
            title: 'Clear history files',
            subtitle: 'Deletes the on-disk cache under ~/.cache/winv@onecalfman',
        });
        const clearBtn = new Gtk.Button({
            label: 'Clear…', valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearRow.add_suffix(clearBtn);
        danger.add(clearRow);
        clearBtn.connect('clicked', () => {
            const confirm = new Adw.MessageDialog({
                transient_for: window,
                heading: 'Clear clipboard history?',
                body: 'This deletes all saved text and images.',
            });
            confirm.add_response('cancel', 'Cancel');
            confirm.add_response('clear', 'Clear');
            confirm.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
            confirm.connect('response', (_d, id) => {
                if (id !== 'clear') return;
                try {
                    const dir = Gio.File.new_for_path(
                        GLib.build_filenamev([GLib.get_user_cache_dir(), 'winv@onecalfman']),
                    );
                    trashRecursive(dir);
                } catch { /* best effort */ }
            });
            confirm.present();
        });

        window.set_default_size(520, 560);
    }
}

function trashRecursive(file) {
    try {
        const info = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        if (info === Gio.FileType.DIRECTORY) {
            const kids = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let child;
            while ((child = kids.next_file(null)))
                trashRecursive(kids.get_child(child));
        }
        file.trash(null);
    } catch { /* best effort */ }
}
