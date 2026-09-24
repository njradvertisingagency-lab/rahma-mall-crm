-- RAHMA MALL — ملفات الموظفين HR (HR Employee Profiles)
-- المرحلة الأولى من قسم "HR" الخاص بقائد الفريق: بيانات أساسية لكل موظف
-- (رقم قومي، عنوان، جهة اتصال طوارئ، مسمى وظيفي، قسم، تاريخ تعيين، حالة
-- التوظيف) غير موجودة في جدول employees الأساسي.
--
-- تم استخدام جدول منفصل 1:1 مع employees بدل ALTER TABLE على الجدول
-- الأصلي — نفس السبب دايمًا: ALTER TABLE محظور صراحةً على قاعدة بيانات
-- الإنتاج هنا (classifier reason: Cloud Storage Mass Delete)، وأيضًا هذا
-- يفصل بيانات الـHR الحساسة عن جدول employees التشغيلي (المستخدم في كل
-- استعلامات الأداء/التوزيع)، فقراءة صفحات كتير (الموظفين، الأداء، التوزيع)
-- لا تتأثر بحجم هذا الجدول أو تحتاج تعديل.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_hr_profiles (
  employee_id             INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  national_id             TEXT,
  phone                   TEXT,
  address                 TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  job_title               TEXT,
  department              TEXT,
  employment_status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (employment_status IN ('ACTIVE','ON_LEAVE','TERMINATED')),
  hire_date               TEXT,
  termination_date        TEXT,
  termination_reason      TEXT,
  notes                   TEXT,
  updated_by              INTEGER REFERENCES users(id),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
