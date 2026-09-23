-- نظام التحفيز — يعيد استخدام reward_transactions الموجود (reason='MANUAL_ADJUSTMENT'
-- لكل الأنواع الجديدة، مع تفاصيل النوع داخل notes) بدل تعديل الجدول، تفاديًا
-- لأي ALTER/DROP على قاعدة بيانات حية. motivation_events هو الوحيد الجديد،
-- ودوره فقط منع تكرار صرف نفس المكافأة/الخصم مرتين (first-deal-of-day،
-- خصم تأخير الملاحظة، ترتيب المبيعات الشهري) — مصدر الحقيقة للرصيد يبقى
-- reward_transactions فقط.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO settings (key, value) VALUES ('motivation_settings', '{"monthlySalesTarget":8,"firstDealOfDay":{"enabled":true,"amount":50},"lateNotePenalty":{"enabled":true,"amount":20,"deadlineHours":24},"monthlyTop3":{"enabled":true,"amounts":[500,300,150]}}');

CREATE TABLE IF NOT EXISTS motivation_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id            INTEGER NOT NULL REFERENCES employees(id),
  bonus_type             TEXT NOT NULL,
  ref_key                TEXT NOT NULL,
  amount                 REAL NOT NULL,
  reward_transaction_id  INTEGER REFERENCES reward_transactions(id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ref_key يحمل كل معنى التفرّد (تاريخ اليوم لأول صفقة، شهر+ترتيب للأعلى ٣
-- مبيعات، عميل+وقت الرؤية لخصم تأخير الملاحظة) — فهرس واحد يكفي لمنع
-- الازدواجية لكل الأنواع دفعة واحدة.
CREATE UNIQUE INDEX IF NOT EXISTS idx_motivation_dedup ON motivation_events(bonus_type, ref_key);
CREATE INDEX IF NOT EXISTS idx_motivation_employee ON motivation_events(employee_id);
