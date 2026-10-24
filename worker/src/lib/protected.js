// كل الموظفين متساوين — مفيش أي موظف له أولوية أو حماية خاصة.
// المصفوفات فاضية عن قصد: الأرقام تتوزع بالتساوي على الجميع.
export const PROTECTED_EMPLOYEE_IDS = [];
export const PROTECTED_USER_IDS = [];

// '0' كـ placeholder آمن في جمل SQL IN — مفيش موظف بـ id = 0
export const PROTECTED_SQL = '0';

export const EVENING_SHIFT_EMPLOYEE_IDS = [];
export const EVENING_SHIFT_SQL = '0';
// Combined SQL for reclaim/redistribute exclusion — no exempt employees
export const NO_RECLAIM_SQL = '0';

export const isProtectedEmployee = (_id) => false;
export const isProtectedUser = (_id) => false;

// كل الموظفين بنفس الترتيب — مفيش أولوية لحد.
export function protectedFirst(list, _getId) {
  return [...list];
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
