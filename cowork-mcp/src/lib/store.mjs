/**
 * Small atomic JSON store. Every mutation is written through a temp file and
 * renamed, so a crash mid-write can never leave a half-written state file.
 */
import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} file absolute path to the JSON file
   * @param {any} initial value used when the file is missing or corrupt
   */
  constructor(file, initial) {
    this.file = file;
    this.initial = initial;
    this._cache = null;
    this._mtimeMs = -1;
  }

  read() {
    try {
      const stat = fs.statSync(this.file);
      if (this._cache !== null && stat.mtimeMs === this._mtimeMs) return this._cache;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._cache = parsed;
      this._mtimeMs = stat.mtimeMs;
      return parsed;
    } catch {
      return structuredClone(this.initial);
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this._cache = value;
    try {
      this._mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this._mtimeMs = -1;
    }
    return value;
  }

  /** Read, mutate via `fn`, write back. Returns the new value. */
  update(fn) {
    const current = this.read();
    const next = fn(current) ?? current;
    return this.write(next);
  }
}
