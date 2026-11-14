#!/usr/bin/env node
'use strict';
// Usage: npm run import:transport -- path/to/drivers.csv
// Columns: name,kind,phone,area,lat,lng,radius_km,facility_code,notes
//   kind is one of ambulance, boda, taxi, volunteer, other. Only name, kind and phone are required.
// Re-running is safe: rows are matched by phone number. Only list people who agreed to be contacted.
const config = require('../src/config');
const { open } = require('../src/db');
const { importCsv } = require('../src/importTransport');

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run import:transport -- path/to/drivers.csv');
  process.exit(1);
}
const db = open(config.dbPath);
const r = importCsv(db, file);
console.log(`Added ${r.imported} and updated ${r.updated} driver(s) in ${config.dbPath}.`);
if (r.skipped.length) {
  console.warn(`Skipped ${r.skipped.length} row(s):`);
  for (const s of r.skipped.slice(0, 20)) console.warn(`  line ${s.line}: ${s.reason}`);
}
