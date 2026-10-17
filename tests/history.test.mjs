import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the extension's history logic without requiring GNOME Shell.
const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class WinVExtension', 'class WinVExtension');
let timestamp = 1000;
const context = vm.createContext({
    Date: class extends Date {
        static now() { return ++timestamp; }
    },
    Extension: class {},
    St: { Clipboard: { get_default: () => ({}) } },
});
vm.runInContext(`${source}\nglobalThis.WinVExtension = WinVExtension;`, context);

function textEntry(id, pinned = false) {
    return { id, type: 'text', text: `copy ${id}`, pinned, ts: id };
}

function history(entries, limit = 5) {
    const extension = new context.WinVExtension();
    extension._entries = entries;
    extension._nextId = 100;
    extension._settings = {
        get_int: () => limit,
        get_boolean: () => false,
    };
    extension._scheduleSave = () => {};
    extension._deletedImages = [];
    extension._deleteImageFile = file => extension._deletedImages.push(file);
    return extension;
}

test('new copies replace the oldest item when history is full', () => {
    const extension = history([5, 4, 3, 2, 1].map(id => textEntry(id)));

    for (let i = 0; i < 10; i++) {
        const text = `new copy ${i}`;
        const oldest = extension._entries.at(-1);
        extension._addText(text);

        assert.equal(extension._entries.length, 5);
        assert.ok(extension._entries.some(entry => entry.text === text));
        assert.ok(!extension._entries.includes(oldest));
    }
});

test('pinned items survive eviction without using the unpinned limit', () => {
    const pinned = textEntry(0, true);
    const extension = history([pinned, ...[5, 4, 3, 2, 1].map(id => textEntry(id))]);

    extension._addText('new copy');

    assert.equal(extension._entries.length, 6);
    assert.equal(extension._entries[0], pinned);
    assert.equal(extension._entries[1].text, 'new copy');
    assert.ok(!extension._entries.some(entry => entry.id === 1));
});

test('trimming keeps a newly appended image and removes only an evicted image file', () => {
    const oldest = { id: 1, type: 'image', file: 'old.png', pinned: false, ts: 1 };
    const newest = { id: 6, type: 'image', file: 'new.png', pinned: false, ts: 6 };
    const extension = history([
        ...[5, 4, 3, 2].map(id => textEntry(id)), oldest, newest,
    ]);

    extension._trim();

    assert.equal(extension._entries.length, 5);
    assert.equal(extension._entries[0], newest);
    assert.deepEqual(extension._deletedImages, ['old.png']);
});
