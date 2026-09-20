import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';
import { getWhatsappTemplateSettings, generateMessage, buildWhatsAppUrl } from '../lib/whatsapp.js';
import { normalizeEgyptPhone } from '../lib/phone.js';

export const whatsappRoutes = new Hono();
whatsappRoutes.use('*', requireAuth);

async function loadCustomerForContact(db, user, customerId) {
  const customer = await db
    .prepare(`SELECT c.*, e.name AS employee_name, e.name_ar AS employee_name_ar FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id WHERE c.id = ?`)
    .bind(customerId)
    .first();
  if (!customer) return { error: jsonError2(404, 'Customer not found', 'NOT_FOUND') };
  if (user.role === 'employee' && customer.assigned_employee_id !== user.employeeId) {
    return { error: jsonError2(403, 'Not your customer', 'FORBIDDEN_OWNERSHIP') };
  }
  return { customer };
}
function jsonError2(status, message, code) {
  return { status, message, code };
}

// Generate the preview message — no side effects, no DB writes.
whatsappRoutes.get('/customers/:id/preview', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const { customer, error } = await loadCustomerForContact(db, user, id);
  if (error) return jsonError(c, error.status, error.message, error.code);

  const { valid, normalized } = normalizeEgyptPhone(customer.phone);
  const { template, companyName } = await getWhatsappTemplateSettings(db);

  // The employee actually contacting is the acting user (an employee) or,
  // when the Team Leader initiates, the customer's assigned employee if any
  // — falling back to the Team Leader's own display name.
  const actingEmployeeNameAr = user.role === 'employee' ? (await db.prepare(`SELECT name_ar, name FROM employees WHERE id = ?`).bind(user.employeeId).first()) : null;
  const employeeNameAr = actingEmployeeNameAr ? actingEmployeeNameAr.name_ar || actingEmployeeNameAr.name : customer.employee_name_ar || customer.employee_name || user.displayName;

  const message = generateMessage({ customerName: customer.name, employeeName: employeeNameAr, companyName, template });

  return c.json({
    phoneValid: valid,
    normalizedPhone: valid ? normalized : null,
    message,
    contactStatus: customer.whatsapp_contact_status,
    contactedAt: customer.whatsapp_contacted_at,
  });
});

// Record CONTACT_INITIATED and return the wa.me URL for the browser to open.
whatsappRoutes.post('/customers/:id/initiate', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { customer, error } = await loadCustomerForContact(db, user, id);
  if (error) return jsonError(c, error.status, error.message, error.code);

  const { valid, normalized } = normalizeEgyptPhone(customer.phone);
  if (!valid) return jsonError(c, 400, 'لا يمكن التواصل عبر واتساب — رقم الهاتف غير صالح.', 'INVALID_PHONE');
  if (!body.message || !String(body.message).trim()) return jsonError(c, 400, 'الرسالة مطلوبة', 'EMPTY_MESSAGE');

  const employeeId = customer.assigned_employee_id ?? (user.role === 'employee' ? user.employeeId : null);
  const ts = nowIso();
  const message = String(body.message).trim();

  const res = await db
    .prepare(`INSERT INTO whatsapp_interactions (customer_id, employee_id, initiated_by, phone, message, status, initiated_at) VALUES (?, ?, ?, ?, ?, 'CONTACT_INITIATED', ?) RETURNING id`)
    .bind(id, employeeId, user.id, normalized, message, ts)
    .first();
  await db
    .prepare(`UPDATE customers SET whatsapp_contact_status = 'CONTACT_INITIATED', whatsapp_contacted_at = ?, whatsapp_contacted_by = ?, updated_at = ? WHERE id = ?`)
    .bind(ts, user.id, ts, id)
    .run();

  await logActivity(db, {
    actor: user,
    action: 'WHATSAPP_CONTACT_INITIATED',
    entityType: 'customer',
    entityId: id,
    metadata: { phone: normalized, message, interactionId: res.id },
  });

  await broadcast(
    c.env,
    'WHATSAPP_CONTACT_INITIATED',
    { customerId: id, employeeName: user.displayName, contactedAt: ts },
    { scope: 'role', role: 'team_leader' }
  );

  return c.json({
    interactionId: res.id,
    status: 'CONTACT_INITIATED',
    contactedAt: ts,
    url: buildWhatsAppUrl(normalized, message),
  });
});

whatsappRoutes.get('/customers/:id/history', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const { customer, error } = await loadCustomerForContact(db, user, id);
  if (error) return jsonError(c, error.status, error.message, error.code);
  const rows = await db.prepare(`SELECT * FROM whatsapp_interactions WHERE customer_id = ? ORDER BY created_at ASC`).bind(id).all();
  return c.json({ interactions: rows.results });
});
