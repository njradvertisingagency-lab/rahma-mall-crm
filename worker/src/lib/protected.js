// موظفة جديدة (مهرة) — في فترة تدريب بطلب صاحب الشغل:
//  - مفيش أي سحب تلقائي من أرقامها.
//  - أولوية في التوزيع (ترتيبها الأول، فتاخد أول/أحسن الأرقام).
//  - مستثناة من تقصير التأخير (حضور) وخصم تأخير كتابة الملاحظة.
export const PROTECTED_EMPLOYEE_IDS = [4];
export const PROTECTED_USER_IDS = [5];
export const PROTECTED_SQL = PROTECTED_EMPLOYEE_IDS.join(',');

// شيفت مسائي (أشرقت ٧م–١ص): مش بتشتغل وقت الشيفت الصبح، فمفيش سحب أرقام
// منها في الـ reclaim أو الـ redistribute — لازم تلاقي كل أرقامها زي ما هي
// لما تيجي تكمل بالليل.
export const EVENING_SHIFT_EMPLOYEE_IDS = [1];
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

// حصص التوزيع: زمايلها بياخدوا عدد متساوي (k، أو k+1 لو في باقي قسمة)،
// والموظفة المحمية بتاخد k + (8..10) → يعني دايمًا أكتر من كل زميلة بـ 7..10 أرقام.
// مثال: ١٦٠ رقم، ٣ زميلات → ٥٠ و٥٠ و٥٠ (والباقي +١) ومهرة ٦٠ تقريبًا.
// بيرجّع Map(employeeId → count) مجموعها = total بالظبط.
export function computeQuotas(total, employeeIds) {
  const ids = employeeIds.map(Number);
  const prot = ids.filter(isProtectedEmployee);
  const others = ids.filter((id) => !isProtectedEmployee(id));
  const q = new Map(ids.map((id) => [id, 0]));
  const even = () => {
    const n = ids.length;
    const base = Math.floor(total / n);
    const rem = total % n;
    ids.forEach((id, i) => q.set(id, base + (i < rem ? 1 : 0)));
    return q;
  };
  if (prot.length === 0 || others.length === 0) return even();
  const extra = 8 + Math.floor(Math.random() * 3); // 8..10
  const protTotalExtra = extra * prot.length;
  if (total - protTotalExtra < 0) return even();
  const slots = ids.length;
  const k = Math.floor((total - protTotalExtra) / slots);
  let rem = total - protTotalExtra - k * slots; // 0..slots-1
  prot.forEach((id) => q.set(id, k + extra));
  others.forEach((id) => q.set(id, k));
  for (const id of others) { if (rem <= 0) break; q.set(id, q.get(id) + 1); rem--; }
  for (const id of prot) { if (rem <= 0) break; q.set(id, q.get(id) + 1); rem--; }
  return q;
}
