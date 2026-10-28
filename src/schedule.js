'use strict';
const config = require('./config');

// Eight antenatal contacts (WHO 2016 model), at these gestational weeks. Contact 1 is "by 12 weeks".
// Confirm against the national antenatal care guidelines before launch.
const CONTACT_WEEKS = [12, 20, 26, 30, 34, 36, 38, 40];
const DAY = 86400000;

// Dates are handled as UTC-midnight Date objects and 'YYYY-MM-DD' strings.
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);

// "Today" in the service's local time zone as a UTC-midnight Date.
function localToday(now = new Date()) {
  const shifted = new Date(now.getTime() + config.utcOffsetHours * 3600000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
function localHour(now = new Date()) {
  return new Date(now.getTime() + config.utcOffsetHours * 3600000).getUTCHours();
}

// Validates a last-menstrual-period date: not in the future, not more than 280 days ago.
function validateLmp(dt, today) {
  if (!dt) return false;
  const days = Math.round((today - dt) / DAY);
  return days >= 0 && days <= 280;
}

// "120426" (DDMMYY) -> 'YYYY-MM-DD' or null.
function parseDdmmyy(s, today = localToday()) {
  if (!/^\d{6}$/.test(String(s))) return null;
  const d = s.slice(0, 2), m = s.slice(2, 4), y = '20' + s.slice(4, 6);
  const dt = parseDate(`${y}-${m}-${d}`);
  return validateLmp(dt, today) ? fmt(dt) : null;
}

function gestation(lmp, today = localToday()) {
  const total = Math.round((today - parseDate(lmp)) / DAY);
  return { weeks: Math.floor(total / 7), days: total % 7, totalDays: total };
}

const edd = (lmp) => fmt(addDays(parseDate(lmp), 280));

// status: 'past' (date has gone), 'next' (first one still ahead or today), 'upcoming'.
function visits(lmp, today = localToday()) {
  const start = parseDate(lmp);
  let nextFound = false;
  return CONTACT_WEEKS.map((week, i) => {
    const date = addDays(start, week * 7);
    let status = 'past';
    if (date >= today) { status = nextFound ? 'upcoming' : 'next'; nextFound = true; }
    return { no: i + 1, week, date: fmt(date), status };
  });
}

const nextVisit = (lmp, today) => visits(lmp, today).find((v) => v.status === 'next') || null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function pretty(dateStr) {
  const d = parseDate(dateStr);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

module.exports = { CONTACT_WEEKS, parseDate, fmt, addDays, localToday, localHour, validateLmp, parseDdmmyy, gestation, edd, visits, nextVisit, pretty };
