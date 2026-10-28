'use strict';
const path = require('path');
const { open } = require('../src/db');
const { importCsv } = require('../src/importFacilities');
const schedule = require('../src/schedule');

function freshDb() {
  const db = open(':memory:');
  importCsv(db, path.join(__dirname, '..', 'data', 'facilities.sample.csv'));
  return db;
}

// "DDMMYY" for a last period that began `daysAgo` days ago (local service time).
function ddmmyy(daysAgo) {
  const d = schedule.addDays(schedule.localToday(), -daysAgo);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(2);
}
const isoAgo = (daysAgo) => schedule.fmt(schedule.addDays(schedule.localToday(), -daysAgo));

const outbox = (db) => db.prepare('SELECT * FROM outbox ORDER BY id').all();

module.exports = { freshDb, ddmmyy, isoAgo, outbox };
