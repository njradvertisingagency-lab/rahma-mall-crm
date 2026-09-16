// Egyptian mobile phone validation & normalization.
// Canonical stored form: 01XXXXXXXXX (11 digits, operator codes 010/011/012/015)
// The original input string is always preserved separately (`phone` column);
// this module never mutates or discards the user's original text.

const VALID_PREFIXES = ['010', '011', '012', '015'];

export function normalizeEgyptPhone(raw) {
  if (raw == null) return { valid: false, normalized: null, reason: 'EMPTY' };
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!s) return { valid: false, normalized: null, reason: 'EMPTY' };

  // Strip common international prefixes for Egypt (+20 / 0020 / bare 20).
  if (s.startsWith('+20')) s = s.slice(3);
  else if (s.startsWith('0020')) s = s.slice(4);
  else if (s.startsWith('20') && s.length === 12 && s[2] === '1') s = s.slice(2);

  // Now we expect either "01XXXXXXXXX" (11 digits) or "1XXXXXXXXX" (10 digits,
  // country code already stripped, leading 0 omitted).
  if (/^\d{10}$/.test(s) && s[0] === '1') {
    s = '0' + s;
  }

  if (!/^\d{11}$/.test(s)) {
    return { valid: false, normalized: null, reason: 'INVALID_LENGTH' };
  }
  const prefix = s.slice(0, 3);
  if (!VALID_PREFIXES.includes(prefix)) {
    return { valid: false, normalized: null, reason: 'INVALID_PREFIX' };
  }
  return { valid: true, normalized: s, reason: null };
}
