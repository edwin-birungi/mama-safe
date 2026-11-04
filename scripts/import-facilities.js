#!/usr/bin/env node
'use strict';
// Usage:
//   npm run import:facilities -- path/to/facilities.csv        (Ministry of Health list, district list, or your own)
//   npm run import:facilities -- --osm path/to/overpass.json   (OpenStreetMap export, see README)
// Re-running is safe: rows are matched by facility code.
const config = require('../src/config');
const { open } = require('../src/db');
const { importCsv, importOsm } = require('../src/importFacilities');

const args = process.argv.slice(2);
const osm = args.includes('--osm');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run import:facilities -- [--osm] path/to/file');
  process.exit(1);
}
const db = open(config.dbPath);
if (osm) {
  const r = importOsm(db, file);
  console.log(`Imported ${r.imported} facilities from OpenStreetMap into ${config.dbPath}.`);
  console.log('Skipped:', JSON.stringify(r.skipped));
} else {
  const { imported, skipped } = importCsv(db, file);
  console.log(`Imported ${imported} facilities into ${config.dbPath}.`);
  if (skipped.length) console.warn(`Skipped ${skipped.length} rows missing a name or district:\n` + skipped.join('\n'));
}
const n = db.prepare('SELECT COUNT(*) AS n FROM facilities').get().n;
console.log(`The database now holds ${n} facilities.`);
