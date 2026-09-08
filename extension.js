/* WinV Clipboard — a Windows-style Super+V panel for GNOME.
 *
 * Floating Adwaita-native card, searchable, text + image thumbnails,
 * pin / delete / clear / private mode, auto-paste via virtual keyboard.
 * Wayland-safe: uses St.Clipboard + Meta.Selection like stock GNOME does.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

const Clipboard = St.Clipboard.get_default();

const UUID = 'winv@onecalfman';
const LEGACY_UUID = 'winv@jonas.dev';
const PANEL_WIDTH = 560;
const SEARCH_PLACEHOLDER = 'Type to search clipboard…';
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PASTE_DELAY_MS = 220;
const SAVE_DELAY_MS = 800;
const PREVIEW_CHARS = 240;

// evdev keycodes (match Clutter virtual device expectations)
const KEY_LEFTCTRL = 29;
const KEY_V = 47;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/bmp', 'image/tiff'];
const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};

let _virtKeyboard = null;
function virtKeyboard() {
    if (!_virtKeyboard) {
        _virtKeyboard = Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    return _virtKeyboard;
}

function timeAgo(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : `${d}d ago`;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function looksLikeCode(text) {
    return /[{};]/.test(text) && text.includes('\n');
}

function isUrl(text) {
    const t = text.trim();
    return /^https?:\/\/\S+$/i.test(t);
}

export default class WinVExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), UUID]);
        this._historyFile = GLib.build_filenamev([this._cacheDir, 'history.json']);
        this._imagesDir = GLib.build_filenamev([this._cacheDir, 'images']);
        GLib.mkdir_with_parents(this._cacheDir, 0o700);
        GLib.mkdir_with_parents(this._imagesDir, 0o700);
        this._migrateLegacyCache();

        this._entries = []; // sorted: pinned first, then newest first
        this._nextId = 1;
        this._ignoreCopies = 0;
        this._filtered = [];
        this._selected = 0;
        this._open = false;
        this._modalGrab = null;
        this._saveId = 0;
        this._settingsIds = [];
        this._a11yAlive = true;
        this._Atspi = null;
        this._focusListener = null;
        this._a11yFocus = null;

        console.log('[winv] enable build 20260908-modal-fix');
        this._loadHistory();
        this._buildUi();
        this._refreshIndicator();
        this._watchClipboard();
        this._bindShortcut();
        this._initA11y();

        this._settingsIds.push(
            this._settings.connect('changed::private-mode', () => this._refreshFooter()),
            this._settings.connect('changed::show-indicator', () => this._refreshIndicator()),
            this._settings.connect('changed::history-size', () => {
                this._trim();
                this._render();
            }),
        );
    }

    disable() {
        for (const id of this._settingsIds) this._settings.disconnect(id);
        this._settingsIds = [];

        if (this._keybound) {
            Main.wm.removeKeybinding('toggle-menu');
            this._keybound = false;
        }
        if (this._selection && this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._selection = null;
            this._ownerChangedId = 0;
        }
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._a11yAlive = false;
        this._shutdownA11y();
        this._saveNow();
        this._destroyUi();
        this._settings = null;
    }

    // ---------- persistence ----------

    _migrateLegacyCache() {
        const legacyDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), LEGACY_UUID]),
        );
        const newHistory = Gio.File.new_for_path(this._historyFile);
        const oldHistory = legacyDir.get_child('history.json');
        if (newHistory.query_exists(null) || !oldHistory.query_exists(null)) return;

        try {
            oldHistory.copy(newHistory, Gio.FileCopyFlags.NONE, null, null);
            const oldImages = legacyDir.get_child('images');
            if (!oldImages.query_exists(null)) return;
            const imageEnum = oldImages.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            let info;
            while ((info = imageEnum.next_file(null))) {
                const source = oldImages.get_child(info.get_name());
                const target = Gio.File.new_for_path(
                    GLib.build_filenamev([this._imagesDir, info.get_name()]),
                );
                source.copy(target, Gio.FileCopyFlags.NONE, null, null);
            }
            console.log(`[${UUID}] migrated history from ${LEGACY_UUID}`);
        } catch (e) {
            console.warn(`[${UUID}] legacy history migration failed: ${e}`);
        }
    }

    _loadHistory() {
        try {
            const file = Gio.File.new_for_path(this._historyFile);
            if (!file.query_exists(null)) return;
            const [, contents] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (!Array.isArray(data.entries)) return;
            const maxSize = this._settings.get_int('history-size');
            for (const raw of data.entries.slice(0, maxSize + 100)) {
                if (!raw || typeof raw !== 'object') continue;
                if (raw.type === 'text' && typeof raw.text === 'string') {
                    this._entries.push({
                        id: raw.id ?? this._nextId++,
                        type: 'text',
                        text: raw.text.slice(0, 60000),
                        pinned: !!raw.pinned,
                        ts: raw.ts ?? Date.now(),
                    });
                } else if (raw.type === 'image' && typeof raw.file === 'string') {
                    const path = GLib.build_filenamev([this._imagesDir, raw.file]);
                    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue;
                    this._entries.push({
                        id: raw.id ?? this._nextId++,
                        type: 'image',
                        file: raw.file,
                        mime: IMAGE_MIMES.includes(raw.mime) ? raw.mime : 'image/png',
                        bytes: raw.bytes ?? 0,
                        width: raw.width ?? 0,
                        height: raw.height ?? 0,
                        pinned: !!raw.pinned,
                        ts: raw.ts ?? Date.now(),
                    });
                }
                if (typeof raw.id === 'number' && raw.id >= this._nextId)
                    this._nextId = raw.id + 1;
            }
            this._sortEntries();
        } catch (e) {
            console.warn(`[${UUID}] failed to load history: ${e}`);
        }
    }

    _scheduleSave() {
        if (this._saveId) return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveNow() {
        try {
            const maxSize = this._settings ? this._settings.get_int('history-size') : 50;
            const pinned = this._entries.filter(e => e.pinned);
            const rest = this._entries.filter(e => !e.pinned).slice(0, maxSize);
            const slim = [...pinned, ...rest].map(e => {
                if (e.type === 'text')
                    return { id: e.id, type: 'text', text: e.text, pinned: e.pinned, ts: e.ts };
                return {
                    id: e.id, type: 'image', file: e.file, mime: e.mime,
                    bytes: e.bytes, width: e.width, height: e.height,
                    pinned: e.pinned, ts: e.ts,
                };
            });
            const data = JSON.stringify({ version: 1, entries: slim });
            Gio.File.new_for_path(this._historyFile).replace_contents(
                new TextEncoder().encode(data), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            );
        } catch (e) {
            console.warn(`[${UUID}] failed to save history: ${e}`);
        }
    }

    // ---------- clipboard watching ----------

    _watchClipboard() {
        this._selection = Shell.Global.get().get_display().get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD) this._onClipboardChanged();
        });
    }

    _privateMode() {
        return this._settings.get_boolean('private-mode');
    }

    _onClipboardChanged() {
        if (this._privateMode()) return;
        if (this._ignoreCopies > 0) {
            this._ignoreCopies--;
            return;
        }
        if (
            this._settings.get_boolean('ignore-password-mimes') &&
            this._looksLikePassword()
        ) {
            return;
        }
        // Prefer text; fall back to image when there is no text.
        Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
            if (text) {
                this._addText(text);
                return;
            }
            if (this._settings.get_boolean('capture-images')) this._tryCaptureImage();
        });
    }

    _looksLikePassword() {
        try {
            const mimes = Clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
            return mimes.some(m =>
                /password|secret|kde-password/i.test(m) ||
                m === 'x-kde-passwordManagerHint',
            );
        } catch {
            return false;
        }
    }

    _addText(raw) {
        let text = raw;
        if (this._settings.get_boolean('strip-text')) text = text.trim();
        if (!text || text.length > MAX_TEXT_BYTES) return;

        const existing = this._entries.find(
            e => e.type === 'text' && e.text === text,
        );
        if (existing) {
            existing.ts = Date.now();
            this._sortEntries();
            this._scheduleSave();
            if (this._open) this._render();
            return;
        }
        this._entries.push({
            id: this._nextId++,
            type: 'text',
            text,
            pinned: false,
            ts: Date.now(),
        });
        this._trim();
        this._sortEntries();
        this._scheduleSave();
        if (this._open) this._render();
    }

    _tryCaptureImage() {
        let mimes = [];
        try {
            mimes = Clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        } catch {
            return;
        }
        const mime = IMAGE_MIMES.find(m => mimes.includes(m));
        if (!mime) return;
        Clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_, bytes) => {
            try {
                if (!bytes || bytes.get_size() === 0) return;
                if (bytes.get_size() > MAX_IMAGE_BYTES) return;
                const data = bytes.get_data();
                const id = this._nextId++;
                const file = `${id}.${MIME_EXT[mime] ?? 'png'}`;
                const path = GLib.build_filenamev([this._imagesDir, file]);
                Gio.File.new_for_path(path).replace_contents(
                    data, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                );
                this._entries.push({
                    id, type: 'image', file, mime,
                    bytes: bytes.get_size(), width: 0, height: 0,
                    pinned: false, ts: Date.now(),
                });
                // Fill in dimensions lazily; failure is non-fatal.
                imports_gdkpixbuf_then(pb => {
                    try {
                        const pix = pb.Pixbuf.new_from_file(path);
                        const hit = this._entries.find(e => e.id === id);
                        if (hit && pix) {
                            hit.width = pix.get_width();
                            hit.height = pix.get_height();
                            this._scheduleSave();
                            if (this._open) this._render();
                        }
                    } catch { /* dimensions optional */ }
                });
                this._trim();
                this._sortEntries();
                this._scheduleSave();
                if (this._open) this._render();
            } catch (e) {
                console.warn(`[${UUID}] image capture failed: ${e}`);
            }
        });
    }

    _sortEntries() {
        this._entries.sort((a, b) => {
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
            return b.ts - a.ts;
        });
    }

    _trim() {
        const maxSize = this._settings.get_int('history-size');
        const pinned = this._entries.filter(e => e.pinned);
        const rest = this._entries.filter(e => !e.pinned).slice(0, maxSize);
        const keep = new Set([...pinned, ...rest].map(e => e.id));
        for (const e of this._entries) {
            if (!keep.has(e.id) && e.type === 'image') this._deleteImageFile(e.file);
        }
        this._entries = [...pinned, ...rest];
        this._sortEntries();
    }

    _deleteImageFile(file) {
        try {
            Gio.File.new_for_path(
                GLib.build_filenamev([this._imagesDir, file]),
            ).delete(null);
        } catch { /* already gone */ }
    }

    // ---------- shortcut ----------

    _bindShortcut() {
        Main.wm.addKeybinding(
            'toggle-menu',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.toggle(),
        );
        this._keybound = true;
    }

    toggle() {
        if (this._open) this.hide();
        else this.show();
    }

    // ---------- UI ----------

    _buildUi() {
        this._backdrop = new St.Widget({
            style_class: 'winv-backdrop',
            reactive: true,
            visible: false,
        });
        const dismissGesture = new Clutter.ClickGesture();
        dismissGesture.connect('recognize', () => {
            const event = dismissGesture.get_point_event(0);
            if (!event || event.get_button() === Clutter.BUTTON_PRIMARY)
                this.hide();
        });
        this._backdrop.add_action(dismissGesture);
        Main.uiGroup.add_child(this._backdrop);

        this._panel = new St.BoxLayout({
            style_class: 'winv-panel',
            vertical: true,
            reactive: true,
            visible: false,
            width: PANEL_WIDTH,
        });
        Main.uiGroup.add_child(this._panel);

        // header: search
        const header = new St.BoxLayout({ style_class: 'winv-header', vertical: false });
        const searchIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'winv-search-icon',
        });
        header.add_child(searchIcon);
        this._search = new St.Entry({
            style_class: 'winv-search',
            hint_text: SEARCH_PLACEHOLDER,
            can_focus: true,
            x_expand: true,
        });
        header.add_child(this._search);
        this._countLabel = new St.Label({ style_class: 'winv-count', text: '' });
        header.add_child(this._countLabel);
        this._panel.add_child(header);

        this._search.get_clutter_text().connect('text-changed', () => {
            this._selected = 0;
            this._render();
        });
        this._search.get_clutter_text().connect('key-press-event', (_, event) =>
            this._onKey(event),
        );

        // list
        this._scroll = new St.ScrollView({
            style_class: 'winv-scroll',
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._listBox = new St.BoxLayout({
            style_class: 'winv-list',
            vertical: true,
            x_expand: true,
        });
        this._scroll.add_child(this._listBox);
        this._panel.add_child(this._scroll);

        this._emptyLabel = new St.Label({
            style_class: 'winv-empty',
            text: 'Clipboard is empty.\nCopy something and it will show up here.',
        });
        this._panel.add_child(this._emptyLabel);

        // footer
        const footer = new St.BoxLayout({ style_class: 'winv-footer', vertical: false });
        this._hints = new St.Label({
            style_class: 'winv-hints',
            text: '↑↓ navigate · Enter paste · Del delete · Ctrl+P pin · Esc close',
            x_expand: true,
        });
        footer.add_child(this._hints);

        this._privateBtn = new St.Button({
            style_class: 'winv-footer-btn',
            can_focus: true,
            toggle_mode: true,
        });
        this._privateBtn.add_child(new St.Icon({
            icon_name: 'view-conceal-symbolic',
            style_class: 'winv-footer-icon',
        }));
        this._privateBtn.connect('clicked', () => {
            this._settings.set_boolean(
                'private-mode', !this._settings.get_boolean('private-mode'),
            );
            this._refreshFooter();
            return Clutter.EVENT_STOP;
        });
        footer.add_child(this._privateBtn);

        const clearBtn = new St.Button({ style_class: 'winv-footer-btn', can_focus: true });
        clearBtn.add_child(new St.Icon({
            icon_name: 'edit-delete-symbolic',
            style_class: 'winv-footer-icon',
        }));
        clearBtn.connect('clicked', () => {
            this.clear(false);
            return Clutter.EVENT_STOP;
        });
        footer.add_child(clearBtn);

        const settingsBtn = new St.Button({ style_class: 'winv-footer-btn', can_focus: true });
        settingsBtn.add_child(new St.Icon({
            icon_name: 'emblem-system-symbolic',
            style_class: 'winv-footer-icon',
        }));
        settingsBtn.connect('clicked', () => {
            this.hide();
            try {
                Promise.resolve(this.openPreferences()).catch(e =>
                    console.warn(`[${UUID}] cannot open preferences: ${e?.message ?? e}`),
                );
            } catch (e) {
                console.warn(`[${UUID}] cannot open preferences: ${e?.message ?? e}`);
            }
            return Clutter.EVENT_STOP;
        });
        footer.add_child(settingsBtn);
        this._panel.add_child(footer);

        this._panel.connect('key-press-event', (_, event) => this._onKey(event));
    }

    /** Top-bar button next to the system icons; toggles the floating panel. */
    _refreshIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new PanelMenu.Button(0.0, 'WinV Clipboard', true);
            this._indicator.add_child(new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon',
            }));
            // GNOME 50's panel consumes pointer events with a target-phase
            // gesture, so legacy button-press-event signals never arrive.
            // Use the same gesture mechanism as GNOME's Activities button.
            const clickGesture = new Clutter.ClickGesture({
                recognize_on_press: true,
            });
            clickGesture.connect('recognize', () => this.toggle());
            this._indicator.add_action(clickGesture);
            this._indicator.connect('key-press-event', (_, event) => {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter ||
                    sym === Clutter.KEY_space) {
                    this.toggle();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            Main.panel.addToStatusArea(UUID, this._indicator, 0, 'right');
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _destroyUi() {
        if (this._open) this._releaseModal();
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._panel) {
            Main.uiGroup.remove_child(this._panel);
            this._panel.destroy();
            this._panel = null;
        }
        if (this._backdrop) {
            Main.uiGroup.remove_child(this._backdrop);
            this._backdrop.destroy();
            this._backdrop = null;
        }
    }

    // ---------- caret / anchor tracking (AT-SPI, best effort) ----------

    async _initA11y() {
        try {
            const mod = await import('gi://Atspi');
            if (!this._a11yAlive) return;
            const Atspi = mod.default ?? mod;
            try { Atspi.init(); } catch { /* already initialised */ }
            this._Atspi = Atspi;
            const listener = Atspi.EventListener.new(ev => {
                try { this._onA11yFocus(ev); } catch { /* never break focus */ }
            });
            try {
                listener.register('object:state-changed:focused');
                this._focusListener = listener;
            } catch {
                this._focusListener = null;
            }
            console.log(`[winv] atspi ready=${!!this._Atspi} listener=${!!this._focusListener}`);
        } catch {
            this._Atspi = null; // typelib missing: pointer/center fallbacks still work
        }
    }

    _onA11yFocus(ev) {
        if (this._open) return; // ignore noise while the panel itself is up
        try {
            if (!ev || ev.detail1 !== 1 || !ev.source) return;
            this._a11yFocus = { ref: ev.source, ts: Date.now() };
        } catch { /* stale source */ }
    }

    _shutdownA11y() {
        try {
            this._focusListener?.deregister('object:state-changed:focused');
        } catch { /* already gone */ }
        this._focusListener = null;
        this._a11yFocus = null;
        this._Atspi = null;
    }

    /** Screen-space point just under the text caret, or null. */
    _caretAnchor() {
        if (!this._Atspi) return null;
        return this._cachedCaretAnchor() ?? this._scanAppCaret();
    }

    _cachedCaretAnchor() {
        const slot = this._a11yFocus;
        if (!slot) return null;
        try {
            // Don't trust a caret from a different app than the focused window.
            const fw = global.display.focus_window;
            if (fw && typeof fw.get_pid === 'function') {
                try {
                    if (slot.ref.get_process_id() !== fw.get_pid()) return null;
                } catch {
                    return null; // stale object
                }
            }
            const txt = slot.ref.get_text_iface();
            if (txt) {
                const off = txt.get_caret_offset();
                if (typeof off === 'number' && off >= 0) {
                    const r = txt.get_character_extents(off, this._Atspi.CoordType.SCREEN);
                    if (r && isFinite(r.x) && isFinite(r.y) && r.height > 0)
                        return { x: r.x, y: r.y + r.height };
                }
            }
            // Fallback: anchor to the focused field itself.
            try {
                const comp = slot.ref.get_component_iface();
                if (comp) {
                    const r = comp.get_extents(this._Atspi.CoordType.SCREEN);
                    if (r && isFinite(r.x) && isFinite(r.y) && r.width > 0 && r.height > 0)
                        return { x: r.x, y: r.y + r.height };
                }
            } catch { /* no component iface */ }
        } catch { /* stale object */ }
        return null;
    }

    /**
     * The field may have been focused before the extension started tracking
     * (or the toolkit never fired a focus event). Bounded walk of the active
     * app's tree looking for a live caret. Runs only on Super+V.
     */
    _scanAppCaret() {
        const fw = global.display.focus_window;
        if (!fw || typeof fw.get_pid !== 'function') return null;
        let pid = 0;
        try { pid = fw.get_pid(); } catch { return null; }
        if (!pid) return null;
        try {
            const desktop = this._Atspi.get_desktop(0);
            const n = desktop.get_child_count();
            let app = null;
            for (let i = 0; i < n; i++) {
                try {
                    const a = desktop.get_child_at_index(i);
                    if (a && a.get_process_id() === pid) { app = a; break; }
                } catch { /* skip */ }
            }
            if (!app) return null;
            let budget = 4000;
            this._caretFallback = null;
            const hit = this._findCaret(app, 0, () => budget-- > 0);
            const best = hit ?? this._caretFallback;
            this._caretFallback = null;
            if (best) {
                this._a11yFocus = { ref: best.acc, ts: Date.now() };
                return best.rect;
            }
        } catch { /* fall through to pointer/center */ }
        return null;
    }

    _findCaret(acc, depth, spend) {
        if (depth > 30 || !spend()) return null;
        try {
            const txt = acc.get_text_iface();
            if (txt) {
                try {
                    const off = txt.get_caret_offset();
                    if (typeof off === 'number' && off >= 0) {
                        const r = txt.get_character_extents(
                            off, this._Atspi.CoordType.SCREEN);
                        if (r && isFinite(r.x) && isFinite(r.y) && r.height > 0) {
                            const found = {
                                acc, rect: { x: r.x, y: r.y + r.height },
                            };
                            if (this._isEditable(acc)) return found;
                            this._caretFallback ??= found;
                        }
                    }
                } catch { /* keep looking */ }
            }
        } catch { /* no text iface */ }
        let count = 0;
        try { count = acc.get_child_count(); } catch { return null; }
        for (let i = 0; i < count; i++) {
            let child = null;
            try { child = acc.get_child_at_index(i); } catch { continue; }
            if (!child) continue;
            const found = this._findCaret(child, depth + 1, spend);
            if (found) return found;
        }
        return null;
    }

    _isEditable(acc) {
        try {
            const states = acc.get_state_set();
            return !!states?.contains(this._Atspi.StateType.EDITABLE);
        } catch {
            return false;
        }
    }

    _pointerAnchor() {
        try {
            const [x, y] = global.get_pointer();
            if (isFinite(x) && isFinite(y)) return { x, y: y + 16 };
        } catch { /* no pointer */ }
        return null;
    }

    _monitorAt(x, y) {
        for (const mon of Main.layoutManager.monitors) {
            if (x >= mon.x && x < mon.x + mon.width && y >= mon.y && y < mon.y + mon.height)
                return mon;
        }
        return Main.layoutManager.primaryMonitor;
    }

    _placePanel() {
        const stageW = global.stage.width;
        const stageH = global.stage.height;
        this._backdrop.set_size(stageW, stageH);
        this._backdrop.set_position(0, 0);

        const follow = this._settings.get_boolean('follow-caret');
        const caret = follow ? this._caretAnchor() : null;
        const pointer = follow && !caret ? this._pointerAnchor() : null;
        const anchor = caret ?? pointer;
        let wmClass = '?';
        try { wmClass = global.display.focus_window?.get_wm_class() ?? 'none'; } catch { /* ignore */ }
        console.log(`[winv] place follow=${follow} app=${wmClass} caret=${JSON.stringify(caret)} pointer=${JSON.stringify(pointer)}`);
        const mon = anchor ? this._monitorAt(anchor.x, anchor.y)
            : Main.layoutManager.primaryMonitor;

        const w = Math.min(PANEL_WIDTH, Math.floor(mon.width * 0.92));
        this._panel.width = w;

        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        let x, y;
        if (anchor) {
            const H_EST = 500;
            x = clamp(Math.round(anchor.x - 48),
                mon.x + 12, mon.x + mon.width - w - 12);
            const below = Math.round(anchor.y + 12);
            y = below + H_EST <= mon.y + mon.height - 12
                ? below
                : Math.round(anchor.y - 12 - H_EST);
            y = clamp(y, mon.y + 12, mon.y + mon.height - 12 - 200);
        } else {
            x = mon.x + Math.floor((mon.width - w) / 2);
            y = mon.y + Math.floor(mon.height * 0.14);
        }
        this._panel.set_position(x, y);
    }

    show() {
        this._placePanel();
        this._search.set_text('');
        this._selected = 0;
        this._render();
        this._backdrop.visible = true;
        this._panel.visible = true;
        this._open = true;
        try {
            this._modalGrab = Main.pushModal(this._panel, {
                actionMode: Shell.ActionMode.NORMAL,
            });
        } catch {
            this._modalGrab = null;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            global.stage.set_key_focus(this._search.get_clutter_text());
            return GLib.SOURCE_REMOVE;
        });
    }

    hide() {
        this._releaseModal();
        if (this._backdrop) this._backdrop.visible = false;
        if (this._panel) this._panel.visible = false;
        this._open = false;
    }

    _releaseModal() {
        if (this._modalGrab) {
            const grab = this._modalGrab;
            this._modalGrab = null;
            try {
                Main.popModal(grab);
            } catch (e) {
                console.warn(`[${UUID}] failed to release modal grab: ${e?.message ?? e}`);
            }
        }
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const searchText = this._search.get_text();

        if (symbol === Clutter.KEY_Escape) {
            this.hide();
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !ctrl) {
            const entry = this._filtered[this._selected];
            if (entry) this._activate(entry);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_p || symbol === Clutter.KEY_P)) {
            const entry = this._filtered[this._selected];
            if (entry) this._togglePin(entry);
            return Clutter.EVENT_STOP;
        }
        if (
            symbol === Clutter.KEY_Delete &&
            (ctrl || searchText.length === 0)
        ) {
            const entry = this._filtered[this._selected];
            if (entry) this._delete(entry);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (this._filtered.length === 0) return;
        this._selected =
            (this._selected + delta + this._filtered.length) % this._filtered.length;
        this._highlight();
    }

    _currentFilter() {
        return this._search.get_text().trim().toLowerCase();
    }

    _computeFiltered() {
        const q = this._currentFilter();
        if (!q) return [...this._entries];
        return this._entries.filter(e => {
            if (e.type === 'text') return e.text.toLowerCase().includes(q);
            return 'image'.includes(q) || (e.mime ?? '').toLowerCase().includes(q);
        });
    }

    _render() {
        if (!this._panel) return;
        this._filtered = this._computeFiltered();
        if (this._selected >= this._filtered.length)
            this._selected = Math.max(0, this._filtered.length - 1);

        this._listBox.destroy_all_children();
        this._emptyLabel.visible = this._filtered.length === 0;

        const total = this._entries.length;
        this._countLabel.text = total === 0 ? '' : `${this._filtered.length}/${total}`;

        this._filtered.slice(0, 60).forEach((entry, idx) => {
            this._listBox.add_child(this._rowFor(entry, idx));
        });
        this._highlight();
        this._refreshFooter();
    }

    _rowFor(entry, idx) {
        const row = new St.Button({
            style_class: 'winv-row',
            can_focus: true,
            x_expand: true,
        });

        const box = new St.BoxLayout({ vertical: false, x_expand: true });
        row.add_child(box);

        // leading visual
        if (entry.type === 'image') {
            const path = GLib.build_filenamev([this._imagesDir, entry.file]);
            try {
                box.add_child(new St.Icon({
                    gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)),
                    icon_size: 52,
                    style_class: 'winv-thumb',
                }));
            } catch {
                box.add_child(new St.Icon({
                    icon_name: 'image-x-generic-symbolic',
                    icon_size: 32,
                    style_class: 'winv-type-icon',
                }));
            }
        } else {
            box.add_child(new St.Icon({
                icon_name: isUrl(entry.text)
                    ? 'web-browser-symbolic'
                    : looksLikeCode(entry.text)
                        ? 'text-x-script-symbolic'
                        : 'text-x-generic-symbolic',
                icon_size: 20,
                style_class: 'winv-type-icon',
            }));
        }

        const textCol = new St.BoxLayout({ vertical: true, x_expand: true });
        const preview = new St.Label({
            style_class: 'winv-preview' + (entry.type === 'text' && looksLikeCode(entry.text) ? ' winv-code' : ''),
            x_expand: true,
        });
        if (entry.type === 'image') {
            const dims = entry.width > 0 ? ` · ${entry.width}×${entry.height}` : '';
            preview.text = `Image (${(entry.mime ?? 'image/png').split('/')[1]})${dims}`;
        } else {
            preview.text = entry.text
                .split('\n')
                .slice(0, 3)
                .join('\n')
                .slice(0, PREVIEW_CHARS);
            preview.clutter_text.line_wrap = true;
            preview.clutter_text.line_wrap_mode = 2; // WORD_CHAR
            preview.clutter_text.max_length = 0;
            preview.clutter_text.ellipsize = 3; // END
        }
        textCol.add_child(preview);

        const meta = new St.Label({
            style_class: 'winv-meta',
            text: entry.type === 'image'
                ? `${formatSize(entry.bytes)} · ${timeAgo(entry.ts)}`
                : `${entry.text.length} chars · ${timeAgo(entry.ts)}${entry.pinned ? ' · pinned' : ''}`,
            x_expand: true,
        });
        textCol.add_child(meta);
        box.add_child(textCol);

        if (entry.pinned) {
            box.add_child(new St.Icon({
                icon_name: 'starred-symbolic',
                icon_size: 14,
                style_class: 'winv-pin-mark',
            }));
        }

        const pinBtn = new St.Button({ style_class: 'winv-mini-btn', can_focus: false });
        pinBtn.add_child(new St.Icon({
            icon_name: entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            icon_size: 15,
            style_class: 'winv-mini-icon',
        }));
        pinBtn.connect('clicked', () => this._togglePin(entry));
        box.add_child(pinBtn);

        const delBtn = new St.Button({ style_class: 'winv-mini-btn', can_focus: false });
        delBtn.add_child(new St.Icon({
            icon_name: 'edit-delete-symbolic',
            icon_size: 15,
            style_class: 'winv-mini-icon',
        }));
        delBtn.connect('clicked', () => this._delete(entry));
        box.add_child(delBtn);

        // The mini buttons live inside the row button: stop press/release
        // from bubbling up or the row would also activate (paste).
        for (const btn of [pinBtn, delBtn]) {
            btn.connect('button-press-event', () => Clutter.EVENT_STOP);
            btn.connect('button-release-event', () => Clutter.EVENT_STOP);
        }

        row.connect('clicked', () => this._activate(entry));
        row._winvIndex = idx;
        return row;
    }

    _highlight() {
        const kids = this._listBox.get_children();
        kids.forEach((kid, i) => {
            if (i === this._selected) kid.add_style_class_name('selected');
            else kid.remove_style_class_name('selected');
        });
        const sel = kids[this._selected];
        if (sel) {
            try { ensureActorVisibleInScrollView(this._scroll, sel); } catch { /* best effort */ }
        }
    }

    _refreshFooter() {
        if (!this._privateBtn) return;
        const priv = this._privateMode();
        if (priv) this._privateBtn.add_style_class_name('active');
        else this._privateBtn.remove_style_class_name('active');
    }

    // ---------- actions ----------

    _activate(entry) {
        // Move to top (MRU), copy back to clipboard, optionally auto-paste.
        entry.ts = Date.now();
        this._sortEntries();
        this._scheduleSave();
        const paste = this._settings.get_boolean('paste-on-selection');
        const isImage = entry.type === 'image';
        const mime = entry.mime ?? 'image/png';
        let payloadBytes = null;
        if (isImage) {
            try {
                const [ok, contents] = Gio.File.new_for_path(
                    GLib.build_filenamev([this._imagesDir, entry.file]),
                ).load_contents(null);
                if (ok) payloadBytes = new GLib.Bytes(contents);
            } catch { /* fall through to text-only copy */ }
        }
        const textPayload = isImage ? null : entry.text;
        this.hide();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            // Exactly one CLIPBOARD owner-change follows a set, so ignore
            // exactly one. (PRIMARY sets don't reach our handler.)
            this._ignoreCopies++;
            if (isImage && payloadBytes) {
                try {
                    Clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, payloadBytes);
                } catch {
                    this._ignoreCopies--;
                    return GLib.SOURCE_REMOVE;
                }
            } else if (textPayload !== null) {
                Clipboard.set_text(St.ClipboardType.CLIPBOARD, textPayload);
                Clipboard.set_text(St.ClipboardType.PRIMARY, textPayload);
            }
            if (paste) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
                    this._syntheticCtrlV();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _syntheticCtrlV() {
        try {
            const t = Clutter.get_current_event_time() * 1000;
            const kb = virtKeyboard();
            kb.notify_key(t, KEY_LEFTCTRL, Clutter.KeyState.PRESSED);
            kb.notify_key(t, KEY_V, Clutter.KeyState.PRESSED);
            kb.notify_key(t, KEY_V, Clutter.KeyState.RELEASED);
            kb.notify_key(t, KEY_LEFTCTRL, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.warn(`[${UUID}] paste failed: ${e}`);
        }
    }

    _togglePin(entry) {
        entry.pinned = !entry.pinned;
        entry.ts = entry.pinned ? Date.now() : entry.ts;
        this._sortEntries();
        this._scheduleSave();
        this._render();
    }

    _delete(entry) {
        this._entries = this._entries.filter(e => e.id !== entry.id);
        if (entry.type === 'image') this._deleteImageFile(entry.file);
        this._scheduleSave();
        if (this._selected >= this._filtered.length - 1)
            this._selected = Math.max(0, this._selected - 1);
        this._render();
    }

    clear(pinnedToo = false) {
        for (const e of this._entries) {
            if (e.type === 'image' && (pinnedToo || !e.pinned))
                this._deleteImageFile(e.file);
        }
        this._entries = pinnedToo ? [] : this._entries.filter(e => e.pinned);
        this._selected = 0;
        this._scheduleSave();
        this._render();
    }
}

// GdkPixbuf is optional (only used for image dimensions). Dynamic import
// keeps startup working even if the typelib is missing.
function imports_gdkpixbuf_then(cb) {
    import('gi://GdkPixbuf')
        .then(mod => cb(mod.default ?? mod))
        .catch(() => {});
}
