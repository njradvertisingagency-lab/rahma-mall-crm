-- RAHMA MALL — الإجازات والغياب (Leave Management) — المرحلة الثانية من HR
-- طلب إجازة (يقدّمه الموظف أو قائد الفريق نيابة عنه) يمر بحالة PENDING ثم
-- يُقرَّر (APPROVED/REJECTED) من قائد الفريق، أو يُلغى (CANCELLED) قبل القرار.
-- الرصيد السنوي محسوب دائمًا من SUM(days_count) للإجازات "السنوية" المعتمدة
-- في نفس السنة — نفس مبدأ "لا شيء يظل رقم منفصل عرضة للانحراف" المستخدم في
-- محفظة المكافآت (reward_transactions)، فـ leave_balances هنا يخزّن فقط
-- الإعدادات (الرصيد السنوي المخصص/المرحّل من عام سابق) وليس أي رصيد متبقٍ.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leave_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type      TEXT NOT NULL CHECK (leave_type IN ('ANNUAL','SICK','EMERGENCY','UNPAID')),
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  days_count      INTEGER NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by    INTEGER REFERENCES users(id),
  decided_by      INTEGER REFERENCES users(id),
  decided_at      TEXT,
  decision_note   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_leaves_employee ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leaves_dates ON leave_requests(start_date, end_date);

CREATE TABLE IF NOT EXISTS leave_balances (
  employee_id       INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  annual_allocation INTEGER NOT NULL DEFAULT 21,
  carried_over      INTEGER NOT NULL DEFAULT 0,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
