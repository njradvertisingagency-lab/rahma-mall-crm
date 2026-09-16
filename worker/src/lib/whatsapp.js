// WhatsAppService — an isolated service layer for customer WhatsApp contact.
//
// Today this only prepares a message and hands back a wa.me deep link for
// the browser to open (openWhatsApp()); we have no way to know whether the
// employee actually pressed Send inside WhatsApp, so we only ever record
// CONTACT_INITIATED — never SENT/DELIVERED/READ. Those three statuses (plus
// FAILED) are reserved for a future WhatsApp Business Cloud API integration:
// sendMessage() and getMessageStatus() are stubbed here specifically so that
// swap-in doesn't touch any call site — routes/whatsapp.js only ever calls
// generateMessage() and buildWhatsAppUrl() today.

const DEFAULT_TEMPLATE = [
  'أهلاً بحضرتك {{customer_name}} 🌷',
  'مع حضرتك {{employee_name}} من {{company_name}}.',
  'حاولنا التواصل مع حضرتك هاتفيًا، ويسعدنا تواصلك معنا عند رؤيتك للرسالة.',
  'يسعدنا تواصلك معنا في الوقت المناسب لحضرتك.',
  'نتمنى لحضرتك يومًا سعيدًا 🌷',
  '{{company_name}}',
].join('\n');
const DEFAULT_COMPANY_NAME = 'رحمة مول';

export async function getWhatsappTemplateSettings(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'whatsapp_template'`).first();
  if (!row) return { template: DEFAULT_TEMPLATE, companyName: DEFAULT_COMPANY_NAME };
  try {
    const parsed = JSON.parse(row.value);
    return { template: parsed.template || DEFAULT_TEMPLATE, companyName: parsed.companyName || DEFAULT_COMPANY_NAME };
  } catch {
    return { template: DEFAULT_TEMPLATE, companyName: DEFAULT_COMPANY_NAME };
  }
}

/**
 * Fills {{customer_name}} / {{employee_name}} / {{company_name}} into the
 * template. A missing customer name is substituted with an empty string and
 * the surrounding whitespace is collapsed — we never render "undefined",
 * "null", or an invented placeholder name.
 */
export function renderTemplate(template, { customerName, employeeName, companyName }) {
  let out = template
    .split('{{customer_name}}').join(customerName ? customerName.trim() : '')
    .split('{{employee_name}}').join(employeeName || '')
    .split('{{company_name}}').join(companyName || DEFAULT_COMPANY_NAME);
  // Collapse doubled spaces left behind by an empty substitution (e.g. "بحضرتك  🌷" -> "بحضرتك 🌷").
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n');
  return out;
}

export function generateMessage({ customerName, employeeName, companyName, template }) {
  return renderTemplate(template || DEFAULT_TEMPLATE, { customerName, employeeName, companyName });
}

/** Egyptian local 01XXXXXXXXX -> international 20XXXXXXXXXX (no leading 0, no +). */
export function toInternational(normalizedEgyptPhone) {
  return '20' + normalizedEgyptPhone.slice(1);
}

/** The link the frontend opens — WhatsApp itself decides app vs. Web/Desktop based on the device. */
export function buildWhatsAppUrl(normalizedEgyptPhone, message) {
  const intl = toInternational(normalizedEgyptPhone);
  return `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
}

// ---------------------------------------------------------------------------
// Reserved for a future WhatsApp Business Cloud API integration. Calling
// these today throws on purpose — nothing in this codebase calls them yet,
// and no status this build sets ever implies delivery/read receipts it
// cannot actually verify.
// ---------------------------------------------------------------------------
export async function sendMessage() {
  throw new Error('sendMessage() requires a configured WhatsApp Business API integration (not enabled in this build).');
}

export async function getMessageStatus() {
  throw new Error('getMessageStatus() requires a configured WhatsApp Business API integration (not enabled in this build).');
}

export { DEFAULT_TEMPLATE, DEFAULT_COMPANY_NAME };
