'use strict';
//
// Local archive for messages fetched from the modem and deleted there.
// Deliberately a single JSON file: small, readable, no dependencies.
//
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, cap = 500) {
    this.file = file;
    this.cap = cap;
    this.items = null;
  }

  load() {
    if (this.items) return this.items;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(data) ? data : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  save() {
    const items = this.load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
    fs.renameSync(tmp, this.file);
  }

  // Signature against duplicates: same number/text/minute only once.
  static sig(m) {
    return `${m.number}|${m.text}|${String(m.date).slice(0, 16)}`;
  }

  // Idempotent: the same message (id + timestamp) is never stored twice.
  // The modem does not always keep a copy of sent messages — ones we archived
  // ourselves at send time are recognised here by their signature.
  merge(messages) {
    const items = this.load();
    const known = new Set(items.map((e) => `${e.id}|${e.date}`));
    const sentSigs = new Set(items.map(Store.sig));
    let added = 0;
    for (const m of messages) {
      const key = `${m.id}|${m.date}`;
      if (known.has(key)) continue;
      if (String(m.tag) === '2' && sentSigs.has(Store.sig(m))) continue;
      known.add(key);
      items.push({ ...m, archived: new Date().toISOString() });
      added++;
    }
    if (added) {
      this.sortAndSave(items);
    }
    return added;
  }

  // Record at send time, independent of what the modem stores.
  addOutgoing(number, text) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const date =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const entry = {
      id: `s${d.getTime()}`,
      tag: '2',
      date,
      number,
      text,
      archived: d.toISOString(),
    };
    const items = this.load();
    items.push(entry);
    this.sortAndSave(items);
    return entry;
  }

  sortAndSave(items) {
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (items.length > this.cap) items.length = this.cap;
    this.save();
  }

  list(limit = 10) {
    return this.load().slice(0, limit);
  }

  remove(id) {
    const items = this.load();
    const i = items.findIndex((e) => String(e.id) === String(id));
    if (i < 0) return false;
    items.splice(i, 1);
    this.save();
    return true;
  }

  get size() {
    return this.load().length;
  }
}

module.exports = { Store };
