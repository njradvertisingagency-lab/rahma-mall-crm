PRAGMA foreign_keys = ON;

-- علامة منفصلة تحدد أن حساب ما (role='team_leader') هو حساب HR مخصّص، بدل
-- إضافة قيمة جديدة لعمود users.role نفسه (الذي له CHECK constraint لا يمكن
-- تعديله بدون ALTER TABLE، وهو محظور). حساب HR يبقى فنيًا role='team_leader'
-- في قاعدة البيانات، لكن هذا العلم يفصل صلاحياته عمليًا عن قائد الفريق
-- الفعلي (المبيعات) في الواجهة والـ API معًا.
CREATE TABLE IF NOT EXISTS user_role_flags (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_hr       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
