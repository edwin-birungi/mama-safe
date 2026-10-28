'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  level TEXT,
  area TEXT NOT NULL,
  phone TEXT,
  lat REAL,
  lng REAL,
  open24 INTEGER NOT NULL DEFAULT 0,
  services TEXT
);
CREATE TABLE IF NOT EXISTS mothers (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  lmp TEXT NOT NULL,
  facility_id INTEGER REFERENCES facilities(id),
  contact_phone TEXT,
  sms_optin INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  mother_id INTEGER NOT NULL REFERENCES mothers(id),
  facility_id INTEGER REFERENCES facilities(id),
  level TEXT NOT NULL,
  symptoms TEXT NOT NULL,
  lat REAL,
  lng REAL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  ack_at TEXT,
  ack_by TEXT
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, created_at);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS reminders_sent (
  mother_id INTEGER NOT NULL REFERENCES mothers(id),
  visit_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (mother_id, visit_no, kind)
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
