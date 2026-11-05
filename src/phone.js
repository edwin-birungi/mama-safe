'use strict';
const config = require('./config');

// Returns "+<digits>" or null. "0712345678" and "712345678" both become +256712345678 for cc=256.
function normalizePhone(raw, cc = config.countryCode) {
  let p = String(raw == null ? '' : raw).replace(/[\s\-().]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else if (p.startsWith('0')) p = cc + p.slice(1);
  else if (p.length <= 9) p = cc + p;
  // "+256-0800..." is a common mistake: a local 0 after the country code.
  if (p.startsWith(cc + '0')) p = cc + p.slice(cc.length + 1);
  return /^\d{10,15}$/.test(p) ? '+' + p : null;
}

// Uganda toll-free numbers are 0800 xxx xxx and 0801 xxx xxx (+256 800/801 ...).
const isTollFree = (p, cc = config.countryCode) => new RegExp(`^\\+${cc}80[01]\\d{6}$`).test(p || '');

// "+256712345678" -> "0712345678" for showing to people in the home country.
function local(p, cc = config.countryCode) {
  if (!p) return '';
  return p.startsWith('+' + cc) ? '0' + p.slice(cc.length + 1) : p;
}

// Splits "0414554001; 0414554002 / 0800100036" into normalised numbers.
function splitPhones(raw, cc = config.countryCode) {
  return String(raw == null ? '' : raw)
    .split(/[;,/]|\bor\b/i)
    .map((s) => normalizePhone(s, cc))
    .filter(Boolean);
}

module.exports = { normalizePhone, isTollFree, local, splitPhones };
