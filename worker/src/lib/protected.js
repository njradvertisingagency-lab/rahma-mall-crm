// موظفة جديدة (مهرة) — في فترة تدريب بطلب صاحب الشغل:
//  - مفيش أي سحب تلقائي من أرقامها.
//  - أولوية في التوزيع (ترتيبها الأول، فتاخد أول/أحسن الأرقام).
//  - مستثناة من تقصير التأخير (حضور) وخصم تأخير كتابة الملاحظة.
export const PROTECTED_EMPLOYEE_IDS = [4];
export const PROTECTED_USER_IDS = [5];
export const PROTECTED_SQL = PROTECTED_EMPLOYEE_IDS.join(',');

export const isProtectedEmployee = (id) => PROTECTED_EMPLOYEE_IDS.includes(Number(id));
export const isProtectedUser = (id) => PROTECTED_USER_IDS.includes(Number(id));

// بيرجّع نسخة مترتبة: المحميين الأول، وباقي الترتيب زي ما هو (sort ثابت).
// getId: دالة بتجيب employee id من العنصر (افتراضي: العنصر نفسه لو رقم، أو item.id).
export function protectedFirst(list, getId = (x) => (typeof x === 'object' ? x.id : x)) {
  return [...list].sort((a, b) => Number(isProtectedEmployee(getId(b))) - Number(isProtectedEmployee(getId(a))));
}
