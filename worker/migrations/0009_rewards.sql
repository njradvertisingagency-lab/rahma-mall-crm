-- RAHMA MALL — نظام مكافآت المبيعات (Sales Reward Wallet)
-- كل صفقة (purchase_transactions) منسوبة لموظف ومُسجَّلة من قِبل قائد الفريق
-- (تمت الصفقة) تمنح الموظف مكافأة نقدية ثابتة تُضاف لمحفظته. المحفظة سجل
-- حركات (ledger) وليست عمود رصيد يُعدَّل مباشرة — نفس مبدأ "لا شيء يظل بايت
-- عرضة للانحراف عن مصدر الحقيقة" المستخدم في بقية النظام: الرصيد دائمًا
-- SUM(amount) من هذا الجدول. أي إبطال/استرجاع كامل لصفقة أو تغيير نسبها لموظف
-- آخر يعكس المكافأة بحركة سالبة جديدة (append-only) بدل حذف/تعديل الحركة
-- الأصلية، فيبقى للمكافأة تاريخ تدقيق كامل دائمًا.

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO settings (key, value) VALUES ('rewards_settings', '{"amountPerSale":200}');

CREATE TABLE IF NOT EXISTS reward_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  purchase_id  INTEGER REFERENCES purchase_transactions(id) ON DELETE SET NULL,
  customer_id  TEXT REFERENCES customers(id),
  amount       REAL NOT NULL,   -- موجب = مكافأة مُضافة، سالب = عكس/خصم
  reason       TEXT NOT NULL CHECK (reason IN ('SALE_BONUS','SALE_CANCELLED','SALE_REFUNDED','ATTRIBUTION_MOVED_OUT','ATTRIBUTION_MOVED_IN','MANUAL_ADJUSTMENT')),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rewardtx_employee ON reward_transactions(employee_id);
CREATE INDEX IF NOT EXISTS idx_rewardtx_purchase ON reward_transactions(purchase_id);
CREATE INDEX IF NOT EXISTS idx_rewardtx_created ON reward_transactions(created_at);
