// هل الملاحظة "حقيقية"؟ — بتمنع الغش: موظف يكتب "مهتم" أو نقطتين أو حروف عشوائية
// عشان العميل ماتتسحبش منه. الملاحظة المقبولة لازم:
//  - فيها على الأقل ١٢ حرف فعلي (عربي/إنجليزي) بعد شيل الرموز والأرقام والمسافات،
//  - على الأقل ٣ كلمات (كل كلمة حرفين فأكتر)،
//  - على الأقل ٥ حروف مختلفة (يمنع "ههههههههه" أو "اااااااا")،
//  - فيها كلمتين مختلفتين على الأقل غير "مهتم/تمام/ok" (يمنع التكرار).
export const NOTE_MIN_LETTERS = 12;
export const NOTE_MIN_WORDS = 3;
export const NOTE_MIN_UNIQUE = 5;

const FILLER = new Set(['مهتم', 'مهتمة', 'مهتمين', 'interested', 'ok', 'اوك', 'تمام', 'تم']);

export function isMeaningfulNote(note) {
  const text = String(note || '').trim();
  if (!text) return false;
  // شيل التشكيل والتطويل
  const clean = text.replace(/[ً-ٟـ]/g, '');
  const words = clean.split(/[^\p{L}]+/u).filter((w) => w.length >= 2);
  const letters = [...clean].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < NOTE_MIN_LETTERS) return false;
  if (words.length < NOTE_MIN_WORDS) return false;
  if (new Set(letters.map((l) => l.toLowerCase())).size < NOTE_MIN_UNIQUE) return false;
  const meaningfulWords = words.filter((w) => !FILLER.has(w.toLowerCase())).map((w) => w.toLowerCase());
  // لازم كلمتين مختلفتين على الأقل غير "مهتم/تمام/ok" — يمنع "مهتم جدا جدا جدا جدا".
  if (new Set(meaningfulWords).size < 2) return false;
  return true;
}
