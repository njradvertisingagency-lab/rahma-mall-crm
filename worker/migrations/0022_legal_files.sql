PRAGMA foreign_keys = ON;

-- =====================================================================
-- قسم الشئون القانونية — نظام ملفات منفصل تمامًا عن CRM/HR
-- الوصول: حساب الشئون القانونية + حساب HR فقط
-- لا حذف نهائي — أرشفة فقط (status = 'ARCHIVED')
-- كل تعديل/حركة/رفع يتسجل في legal_file_history
-- =====================================================================

-- علم is_legal على user_role_flags (نفس نمط is_hr)
-- حساب الشئون القانونية = role='team_leader' + is_legal=1
ALTER TABLE user_role_flags ADD COLUMN is_legal INTEGER NOT NULL DEFAULT 0;

-- =====================================================================
-- الملفات الرئيسية
-- =====================================================================
CREATE TABLE IF NOT EXISTS legal_files (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  file_number       TEXT NOT NULL UNIQUE,           -- رقم الملف (يدخله المستخدم)
  customer_name     TEXT NOT NULL,                   -- اسم العميل
  customer_phone    TEXT NOT NULL,                   -- رقم هاتف العميل
  guarantor_name    TEXT,                            -- اسم الضامن
  guarantor_phone   TEXT,                            -- رقم هاتف الضامن
  sales_name        TEXT,                            -- اسم السيلز
  current_section   TEXT NOT NULL DEFAULT 'HR'
                      CHECK (current_section IN ('HR','LEGAL')),
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','ARCHIVED')),
  notes             TEXT,
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_legal_files_number ON legal_files(file_number);
CREATE INDEX IF NOT EXISTS idx_legal_files_section ON legal_files(current_section);
CREATE INDEX IF NOT EXISTS idx_legal_files_status ON legal_files(status);
CREATE INDEX IF NOT EXISTS idx_legal_files_customer_phone ON legal_files(customer_phone);

-- =====================================================================
-- مستندات الملف (صور / PDF) — حد أقصى 20 لكل ملف
-- المستندات تتخزن كـ base64 data URL في D1
-- =====================================================================
CREATE TABLE IF NOT EXISTS legal_file_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES legal_files(id),
  filename      TEXT NOT NULL,                     -- اسم الملف الأصلي
  content_type  TEXT NOT NULL,                     -- image/jpeg, image/png, application/pdf
  data          TEXT NOT NULL,                     -- base64 encoded data
  file_size     INTEGER NOT NULL DEFAULT 0,        -- حجم الملف بالبايت
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_legal_docs_file ON legal_file_documents(file_id);

-- =====================================================================
-- سجل التاريخ — كل حركة أو تعديل أو رفع يتسجل هنا (immutable)
-- =====================================================================
CREATE TABLE IF NOT EXISTS legal_file_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES legal_files(id),
  action        TEXT NOT NULL CHECK (action IN (
    'CREATED',           -- إنشاء الملف
    'EDITED',            -- تعديل بيانات الملف
    'DOCUMENT_ADDED',    -- رفع مستند جديد
    'DOCUMENT_REMOVED',  -- حذف مستند (أرشفة)
    'MOVED_TO_LEGAL',    -- نقل الملف لقسم الشئون القانونية
    'MOVED_TO_HR',       -- نقل الملف لقسم HR
    'ARCHIVED',          -- أرشفة الملف
    'RESTORED',          -- استعادة من الأرشيف
    'TRANSFER_REQUESTED',-- طلب نقل
    'TRANSFER_APPROVED', -- موافقة على طلب نقل
    'TRANSFER_REJECTED'  -- رفض طلب نقل
  )),
  details       TEXT,                              -- JSON: التفاصيل (الحقول المعدلة، اسم المستند، إلخ)
  performed_by  INTEGER NOT NULL REFERENCES users(id),
  performed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_legal_history_file ON legal_file_history(file_id);
CREATE INDEX IF NOT EXISTS idx_legal_history_action ON legal_file_history(action);
CREATE INDEX IF NOT EXISTS idx_legal_history_date ON legal_file_history(performed_at);

-- =====================================================================
-- طلبات نقل الملفات بين الأقسام
-- =====================================================================
CREATE TABLE IF NOT EXISTS legal_file_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id         INTEGER NOT NULL REFERENCES legal_files(id),
  from_section    TEXT NOT NULL CHECK (from_section IN ('HR','LEGAL')),
  to_section      TEXT NOT NULL CHECK (to_section IN ('HR','LEGAL')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  note            TEXT,                            -- سبب الطلب
  requested_by    INTEGER NOT NULL REFERENCES users(id),
  requested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  responded_by    INTEGER REFERENCES users(id),
  responded_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_transfers_file ON legal_file_transfers(file_id);
CREATE INDEX IF NOT EXISTS idx_legal_transfers_status ON legal_file_transfers(status);
CREATE INDEX IF NOT EXISTS idx_legal_transfers_to ON legal_file_transfers(to_section, status);
