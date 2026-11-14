'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT,                 -- hospital | health_centre | clinic | other
  level TEXT,                -- National Referral, Regional Referral, HC IV, ...
  area TEXT NOT NULL,        -- district
  phone TEXT,                -- main public number
  emergency_phone TEXT,
  toll_free TEXT,
  alert_phone TEXT,          -- a MOBILE that receives emergency SMS. Never shown publicly.
  email TEXT,
  website TEXT,
  lat REAL,
  lng REAL,
  open24 INTEGER,            -- 1 yes, 0 no, NULL unknown
  services TEXT,
  source TEXT,
  contact_confidence TEXT,   -- medium | low | none
  researched_on TEXT,
  notes TEXT                 -- internal; never shown publicly
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
CREATE TABLE IF NOT EXISTS accounts (
  phone TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT,
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
  notified INTEGER NOT NULL DEFAULT 0,   -- 1 if the facility was sent an SMS
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
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  tx_ref TEXT NOT NULL UNIQUE,
  mother_id INTEGER NOT NULL REFERENCES mothers(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,        -- flutterwave | mock | waiver
  status TEXT NOT NULL,          -- pending | successful | failed | waived
  provider_ref TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_mother ON payments(mother_id, status);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- People who can carry a mother to care: ambulances, boda riders, taxi drivers, community volunteers.
CREATE TABLE IF NOT EXISTS transport_providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- ambulance | boda | taxi | volunteer | other
  phone TEXT NOT NULL UNIQUE,    -- a MOBILE that receives pickup requests by SMS
  area TEXT,                     -- district
  lat REAL,                      -- usual base (stage, garage or home); never shown publicly
  lng REAL,
  radius_km REAL NOT NULL DEFAULT 15,
  facility_id INTEGER REFERENCES facilities(id),
  available INTEGER NOT NULL DEFAULT 1,  -- the driver switches this with BUSY / AVAILABLE by SMS
  active INTEGER NOT NULL DEFAULT 1,     -- staff switch: 0 = not listed and never contacted
  verified_on TEXT,
  notes TEXT,                    -- internal
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transport_requests (
  id INTEGER PRIMARY KEY,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  provider_id INTEGER NOT NULL REFERENCES transport_providers(id),
  status TEXT NOT NULL DEFAULT 'sent',   -- sent | accepted | taken (another driver accepted first)
  sent_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (alert_id, provider_id)
);
-- Questions the assistant could not answer, sent on to the mother's clinic.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  mother_id INTEGER NOT NULL REFERENCES mothers(id),
  facility_id INTEGER REFERENCES facilities(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',   -- new | handled
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  handled_at TEXT
);
-- One-time code sent to a mother's emergency contact so she can prove the number is real and agreed.
CREATE TABLE IF NOT EXISTS contact_codes (
  mother_id INTEGER PRIMARY KEY REFERENCES mothers(id),
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
`;

// Databases created by version 0.1 lack the newer columns; add them in place.
const ADDED = {
  facilities: {
    kind: 'TEXT', emergency_phone: 'TEXT', toll_free: 'TEXT', alert_phone: 'TEXT', email: 'TEXT', website: 'TEXT',
    source: 'TEXT', contact_confidence: 'TEXT', researched_on: 'TEXT', notes: 'TEXT'
  },
  alerts: { notified: 'INTEGER NOT NULL DEFAULT 0' },
  mothers: { contact_verified_at: 'TEXT', registration_lat: 'REAL', registration_lng: 'REAL', registration_location_at: 'TEXT' },
  accounts: { recovery_hash: 'TEXT' }
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [col, type] of Object.entries(cols)) {
      if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS facilities_area ON facilities(area); CREATE INDEX IF NOT EXISTS facilities_kind ON facilities(kind);');
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { open };
