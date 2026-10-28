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
  return /^\d{10,15}$/.test(p) ? '+' + p : null;
}

module.exports = { normalizePhone };
