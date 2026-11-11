// ═══════════════════════════════════════════════════════════════
// offdays.js — вихідні за календарем школи (свята й канікули).
//
// Директор заносить їх у «Навчальний рік» (academic_year/{рік}/holidays,
// /breaks). Розклад про них не знає — він лише про дні тижня. Тому ті, хто
// показує «сьогодні уроки» (батьки, учень — parent-student.js; учитель —
// staff-today.js), спершу питають тут, чи день навчальний.
// ═══════════════════════════════════════════════════════════════
import { ref, get } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db } from './common.js';
import { ACTIVE_YEAR } from './director.js';

export function offDaysMap(holidays, breaks, cls, calType){
  const fits = cs => !cs || cs === 'all' || (Array.isArray(cs) && cs.includes(cls))
    || (cs && typeof cs === 'object' && Object.values(cs).includes(cls));
  const out = {};
  Object.values(breaks || {}).forEach(b => {
    if(!b || !b.startDate || !b.endDate || !fits(b.classes)) return;
    for(let d = b.startDate; d <= b.endDate; d = addDays(d, 1))
      out[d] = { title: b.title || 'Канікули', until: b.endDate };
  });
  // Свято сильніше за канікули: «Різдво» точніше, ніж «Зимові канікули»
  Object.values(holidays || {}).forEach(h => {
    if(!h || !h.date || !fits(h.classes)) return;
    if(h.calendarType && h.calendarType !== calType) return;
    out[h.date] = { title: h.title || 'Свято', until: (out[h.date] && out[h.date].until) || h.date };
  });
  return out;
}
export function addDays(date, n){
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
export const ddmm = date => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
// Підпис вихідного: «Осінні канікули (до 16.11)» — «до» лише для кількох днів
export function offTitle(o, date){
  if(!o) return '';
  return o.until && o.until > date ? `${o.title} (до ${ddmm(o.until)})` : o.title;
}

// Сирі вузли календаря (кеш 10 хв): {holidays, breaks}
const TTL = 10 * 60 * 1000;
let raw = { at: 0, p: null, v: null };
export async function loadCalendarRaw(){
  if(raw.v && Date.now() - raw.at < TTL) return raw.v;
  if(raw.p) return raw.p;
  raw.p = Promise.all([
    get(ref(db, `academic_year/${ACTIVE_YEAR}/holidays`)),
    get(ref(db, `academic_year/${ACTIVE_YEAR}/breaks`))
  ]).then(([h, b]) => {
    raw = { at: Date.now(), p: null, v: { holidays: h.exists() ? h.val() : {}, breaks: b.exists() ? b.val() : {} } };
    return raw.v;
  }).catch(e => { raw.p = null; throw e; });
  return raw.p;
}
