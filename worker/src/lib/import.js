// Import parsing: pasted phone lists, CSV text, and XLSX/XLS workbooks.
import * as XLSX from 'xlsx';
import { normalizeEgyptPhone } from './phone.js';

const PHONE_HEADER_HINTS = ['phone', 'mobile', 'number', 'tel', 'رقم', 'موبايل', 'هاتف'];
const NAME_HEADER_HINTS = ['name', 'customer', 'اسم', 'العميل'];
const SOURCE_HINTS = ['source', 'مصدر'];
const CAMPAIGN_HINTS = ['campaign', 'حملة'];
const PRODUCT_HINTS = ['product', 'منتج'];

function scoreHeader(header, hints) {
  const h = String(header).trim().toLowerCase();
  return hints.some((hint) => h.includes(hint)) ? 1 : 0;
}

function detectColumns(headers) {
  const map = { phone: null, name: null, source: null, campaign: null, product: null };
  headers.forEach((h, idx) => {
    if (map.phone === null && scoreHeader(h, PHONE_HEADER_HINTS)) map.phone = idx;
    else if (map.name === null && scoreHeader(h, NAME_HEADER_HINTS)) map.name = idx;
    else if (map.source === null && scoreHeader(h, SOURCE_HINTS)) map.source = idx;
    else if (map.campaign === null && scoreHeader(h, CAMPAIGN_HINTS)) map.campaign = idx;
    else if (map.product === null && scoreHeader(h, PRODUCT_HINTS)) map.product = idx;
  });
  return map;
}

/** Minimal RFC4180-ish CSV parser (handles quoted fields, escaped quotes, CRLF). */
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Parse pasted free text: one phone per line, or comma-separated.
 * Returns raw candidate strings (no structure beyond a phone number).
 */
export function parsePastedNumbers(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Turn a 2D array of rows (first row = header) into structured candidate records. */
function rowsToRecords(rows, manualMapping) {
  if (rows.length === 0) return { records: [], columns: null };
  const header = rows[0].map((h) => String(h ?? ''));
  const looksLikeHeader = header.some((h) => PHONE_HEADER_HINTS.concat(NAME_HEADER_HINTS).some((hint) => h.toLowerCase().includes(hint)));
  const columns = manualMapping || (looksLikeHeader ? detectColumns(header) : { phone: 0, name: null, source: null, campaign: null, product: null });
  const dataRows = looksLikeHeader && !manualMapping ? rows.slice(1) : looksLikeHeader ? rows.slice(1) : rows;
  const records = dataRows.map((r) => ({
    phone: columns.phone != null ? r[columns.phone] : r[0],
    name: columns.name != null ? r[columns.name] : null,
    source: columns.source != null ? r[columns.source] : null,
    campaign: columns.campaign != null ? r[columns.campaign] : null,
    product: columns.product != null ? r[columns.product] : null,
  }));
  return { records, columns };
}

export function parseCsvToRecords(text, manualMapping) {
  const rows = parseCsvText(text);
  return rowsToRecords(rows, manualMapping);
}

export function parseXlsxToRecords(arrayBuffer, manualMapping) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false });
  return rowsToRecords(rows, manualMapping);
}

/**
 * Build the import preview: classify each candidate as valid / duplicate / invalid.
 * `existingNormalizedPhones` is a Set of normalized phones already in the DB (active).
 */
export function buildImportPreview(records, existingNormalizedPhones) {
  const seenInBatch = new Set();
  const rows = records.map((rec) => {
    const rawPhone = typeof rec === 'string' ? rec : rec.phone;
    const { valid, normalized, reason } = normalizeEgyptPhone(rawPhone);
    let status = 'INVALID';
    if (valid) {
      if (existingNormalizedPhones.has(normalized) || seenInBatch.has(normalized)) {
        status = 'DUPLICATE';
      } else {
        status = 'NEW';
        seenInBatch.add(normalized);
      }
    }
    return {
      rawPhone,
      normalizedPhone: valid ? normalized : null,
      name: typeof rec === 'string' ? null : rec.name || null,
      source: typeof rec === 'string' ? null : rec.source || null,
      campaign: typeof rec === 'string' ? null : rec.campaign || null,
      product: typeof rec === 'string' ? null : rec.product || null,
      status,
      reason: valid ? null : reason,
    };
  });
  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.status !== 'INVALID').length,
    newCustomers: rows.filter((r) => r.status === 'NEW').length,
    duplicate: rows.filter((r) => r.status === 'DUPLICATE').length,
    invalid: rows.filter((r) => r.status === 'INVALID').length,
  };
  return { rows, summary };
}
