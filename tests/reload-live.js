// Development only: call reload() from GNOME Looking Glass after editing WinV.
// Importing a uniquely named copy bypasses GJS's session-long module cache.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export async function reload() {
    const extension = Main.extensionManager.lookup('winv@onecalfman');
    if (!extension?.stateObj?._settings)
        throw new Error('Enable WinV before reloading its UI');

    const instance = extension.stateObj;
    const directory = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'winv@onecalfman', 'dev']),
    );
    GLib.mkdir_with_parents(directory.get_path(), 0o700);
    const copy = directory.get_child(`extension-${GLib.get_monotonic_time()}.js`);
    extension.dir.get_child('extension.js').copy(copy, Gio.FileCopyFlags.NONE, null, null);

    let updated;
    try {
        updated = (await import(copy.get_uri())).default;
    } finally {
        copy.delete(null);
    }

    instance.hide();
    instance._destroyUi();
    Object.setPrototypeOf(instance, updated.prototype);
    instance._buildUi();
    instance._refreshIndicator();
    return 'WinV UI reloaded';
}
