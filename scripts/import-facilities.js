#!/usr/bin/env node
'use strict';
// Usage: npm run import:facilities -- path/to/facilities.csv
// Columns: code,name,level,area,phone,lat,lng,open24,services   (see data/facilities.sample.csv)
const config = require('../src/config');
const { open } = require('../src/db');
const { importCsv } = require('../src/importFacilities');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import:facilities -- path/to/facilities.csv');
  process.exit(1);
}
const db = open(config.dbPath);
const { imported, skipped } = importCsv(db, file);
console.log(`Imported ${imported} facilities into ${config.dbPath}.`);
if (skipped.length) console.warn(`Skipped ${skipped.length} rows missing code, name or area:\n` + skipped.join('\n'));
