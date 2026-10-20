// موظفة جديدة (مهرة) — في فترة تدريب بطلب صاحب الشغل:
//  - مفيش أي سحب تلقائي من أرقامها.h
//  - أولوية في التوزيع (ترتيبها الأول، فتاخد أول/أحسن الأرقام).
//  - مستثناة من تقصير التأخير (حضور) وخصم تأخير كتابة الملاحظة.
export const PROTECTED_EMPLOYEE_IDS = [4];
export const PROTECTED_USER_IDS = [5];
export const PROTECTED_SQL = PROTECTED_EMPLOYEE_IDS.join(',');

// شيفت مسائي (أشرقت + هناء ٧م–١٠:٣٠م): مش بيشتغلوا وقت الشيفت الصبح،
// فمفيش سحب أرقام منهم في الـ reclaim أو الـ redistribute — لازم يلاقوا
// كل أرقامهم زي ما هي لما ييجوا يكملوا بالليل.
export const EVENING_SHIFT_EMPLOYEE_IDS = [1, 7];
export const EVENING_SHIFT_SQL = EVENING_SHIFT_EMPLOYEE_IDS.join(',');
// Combined SQL for reclaim/redistribute exclusion (protected + evening shift)
export const NO_RECLAIM_SQL = [...PROTECTED_EMPLOYEE_IDS, ...EVENING_SHIFT_EMPLOYEE_IDS].join(',');

export const isProtectedEmployee = (id) => PROTECTED_EMPLOYEE_IDS.includes(Number(id));
export const isProtectedUser = (id) => PROTECTED_USER_IDS.includes(Number(id));

// بيرجّع نسخة مترتبة: المحميين الأول، وباقي الترتيب زي ما هو (sort ثابت).
// getId: دالة بتجيب employee id من العنصر (افتراضي: العنصر نفسه لو رقم، أو item.id).
export function protectedFirst(list, getId = (x) => (typeof x === 'object' ? x.id : x)) {
  return [...list].sort((a, b) => Number(isProtectedEmployee(getId(b))) - Number(isProtectedEmployee(getId(a))));
}

// حصص التوزيع: الكل بالتساوي — مفيش أي موظف بياخد أكتر من زمايله.
// لو في باقي قسمة (مثلاً ١٦١ رقم على ٤ موظفين) → أول كام موظف ياخدوا +١.
// بيرجّع Map(employeeId → count) مجموعها = total بالظبط.
export function computeQuotas(total, employeeIds) {
  const ids = employeeIds.map(Number);
  const q = new Map(ids.map((id) => [id, 0]));
  const n = ids.length;
  const base = Math.floor(total / n);
  const rem = total % n;
  ids.forEach((id, i) => q.set(id, base + (i < rem ? 1 : 0)));
  return q;
}
