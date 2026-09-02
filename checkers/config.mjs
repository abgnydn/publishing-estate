// config.mjs — where a checker's surfaces come from.
//
// No checker in this directory hard-codes a surface, an account, a checkout
// path or a port; the only hostnames in the sources are the public API
// endpoints they query. Each one takes `--config <file>` and reads the shape
// documented in estate.example.json, or takes the one or two paths it needs as
// arguments. That is the whole of what "curated" means here: the mechanism
// ships, the estate it was pointed at does not.
//
// A config that cannot be read is a HARD FAILURE, never an empty sweep. The
// two are indistinguishable in the output otherwise, and a checker reporting
// "0 findings" because it had nothing to look at is the precise failure this
// fleet exists to prevent. Every loader below throws; no caller catches into a
// clean sheet.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export class ConfigError extends Error {}

// Exported separately from readConfig so a selftest can plant malformed text
// without touching the disk.
export function parseConfig(text, where) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${where}: not valid JSON — ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${where}: the top level must be a JSON object`);
  }
  return doc;
}

export function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `cannot read config ${path} (${e.code ?? e.message}).\n`
      + 'Copy checkers/estate.example.json to checkers/estate.json and point it at your own surfaces.',
    );
  }
  const doc = parseConfig(text, path);
  Object.defineProperty(doc, '_dir', { value: dirname(resolve(path)), enumerable: false });
  return doc;
}

// Paths inside a config are relative to the config FILE, not to the working
// directory, so a checker run from anywhere reads the same surfaces.
export function configPath(doc, p) {
  if (p === null || p === undefined || p === '') return null;
  const s = String(p).replace(/^~(?=\/|$)/, homedir());
  if (isAbsolute(s)) return s;
  if (!doc._dir) throw new ConfigError(`relative path "${p}" with no config directory to resolve it against`);
  return join(doc._dir, s);
}

// "Nothing configured" is a usage error, not a clean run.
export function section(doc, key) {
  const v = doc[key];
  const empty = v === null || v === undefined
    || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  if (empty) {
    throw new ConfigError(
      `the config names no "${key}" — there is nothing to check, which is not a clean result`,
    );
  }
  return v;
}

export function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// The default lives beside the checkers so `node checkers/check-x.mjs` works
// once you have written one, and fails loudly until you have.
export function configFrom(argv, hereDir) {
  return readConfig(flag(argv, '--config') ?? join(hereDir, 'estate.json'));
}

// Every checker's entry point wears this. A crash inside a checker must not be
// reported as "clean" by a runner reading the exit code, and it must not be
// reported as a finding either: exit 2 is the third outcome.
export function fatal(e) {
  console.error(e instanceof ConfigError ? `CONFIG  ${e.message}` : `BROKEN  ${e.stack ?? e.message}`);
  process.exit(2);
}
