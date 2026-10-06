// ═══════════════════════════════════════════════════════════════
// access.js — доступ учителів до класів: хто, звідки і коли.
//
// ЧОМУ ОКРЕМИЙ МОДУЛЬ. Доступ (teacher_access/{пошта}/{клас} = [предмети])
// видають п'ять місць: матриця директора, призначення класного керівника,
// правка чинного розкладу, каталог предметів і каталог гуртків. Раніше
// кожне писало список саме, мовчки, і ніхто нічого не забирав: учитель,
// якого колись поставили на заміну в 10 клас, лишався там назавжди, і
// ніхто вже не міг сказати, звідки цей доступ узявся.
//
// Тепер кожен запис іде через цей модуль і лишає два сліди:
//   teacher_access_meta/{пошта}/{клас}/{ключ предмета} = {s, src, by, at}
//       — звідки взявся кожен предмет (показуємо біля нього в таблиці);
//   access_log/{id} = {at, by, t, cls, act, subj, src}
//       — журнал видач і відкликань.
// Сам teacher_access не змінює формату: його читають правила бази,
// кабінет учителя і розсилка сповіщень.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, push, update, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, subjKey } from './common.js';

export const ACCESS_SRC = {
  manual:   'вручну',
  homeroom: 'класний керівник',
  schedule: 'розклад',
  catalog:  'каталог предметів',
  club:     'гурток',
  substitute: 'заміна (тимчасово)',
  unknown:  'до журналу'
};
export const ALL_SUBJECTS = 'Всі предмети';

export function accessList(raw){
  const l = Array.isArray(raw) ? raw : Object.values(raw || {});
  return [...new Set(l.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))];
}
function who(){
  return (currentUserData && currentUserData.email) || (auth.currentUser && auth.currentUser.email) || '';
}
function logKey(){ return push(child(ref(db), 'access_log')).key; }

// Шляхи для одного багатошляхового update(ref(db), …): новий список,
// походження нових предметів і рядок журналу. Нічого не пише саме —
// так його можна вбудувати в чужий пакет записів (гуртки).
//   current — поточний список (масив) або null, якщо запису ще немає
//   next    — яким має стати список
export function accessChangePaths(se, cls, current, next, src, note){
  const cur = accessList(current), nxt = accessList(next);
  const added = nxt.filter(s => !cur.includes(s));
  const removed = cur.filter(s => !nxt.includes(s));
  const p = {};
  if(!added.length && !removed.length) return p;
  const at = Date.now(), by = who();
  p[`teacher_access/${se}/${cls}`] = nxt.length ? nxt : null;
  if(!nxt.length) p[`teacher_access_meta/${se}/${cls}`] = null;
  else {
    added.forEach(s => { p[`teacher_access_meta/${se}/${cls}/${subjKey(s)}`] = { s, src, by, at }; });
    removed.forEach(s => { p[`teacher_access_meta/${se}/${cls}/${subjKey(s)}`] = null; });
  }
  const base = { at, by, t: se, cls, src };
  if(note) base.note = String(note).slice(0, 200);
  if(added.length)   p[`access_log/${logKey()}`] = { ...base, act: 'grant',  subj: added };
  if(removed.length) p[`access_log/${logKey()}`] = { ...base, act: 'revoke', subj: removed };
  return p;
}

async function readList(se, cls){
  const s = await get(child(ref(db), `teacher_access/${se}/${cls}`));
  return s.exists() ? accessList(s.val()) : null;
}

// Додати предмети (нічого не забирає). «Всі предмети» вже покривають усе.
export async function grantAccess(se, cls, subjects, src, note){
  const cur = await readList(se, cls) || [];
  if(cur.includes(ALL_SUBJECTS)) return false;
  const next = [...new Set([...cur, ...accessList(subjects)])];
  const p = accessChangePaths(se, cls, cur, next, src, note);
  if(!Object.keys(p).length) return false;
  await update(ref(db), p);
  return true;
}
// Замінити список повністю (матриця директора)
export async function setAccess(se, cls, subjects, src, note){
  const cur = await readList(se, cls) || [];
  const p = accessChangePaths(se, cls, cur, subjects, src, note);
  if(Object.keys(p).length) await update(ref(db), p);
  return p;
}
// Забрати предмети; subjects = null — увесь клас
export async function revokeAccess(se, cls, subjects, note){
  const cur = await readList(se, cls);
  if(!cur) return false;
  const drop = subjects ? accessList(subjects) : cur;
  const p = accessChangePaths(se, cls, cur, cur.filter(s => !drop.includes(s)), 'manual', note);
  if(!Object.keys(p).length) return false;
  await update(ref(db), p);
  return true;
}
// Звільнення співробітника: усі класи разом із журналом
export function revokeAllPaths(se, access, note){
  const p = {};
  for(const [cls, raw] of Object.entries(access || {}))
    Object.assign(p, accessChangePaths(se, cls, raw, [], 'manual', note));
  p[`teacher_access/${se}`] = null;
  p[`teacher_access_meta/${se}`] = null;
  // Точкові шляхи всередині щойно видаленого вузла Firebase не прийме
  // в одному update — лишаємо тільки журнал і два корені.
  for(const k of Object.keys(p))
    if(k.startsWith(`teacher_access/${se}/`) || k.startsWith(`teacher_access_meta/${se}/`)) delete p[k];
  return p;
}

// ── ПІДСТАВИ ─────────────────────────────────────────────────────
// Чи має людина підставу на предмет у класі — за чинними даними школи.
//
// ЧОМУ НЕ ЛИШЕ «УЧИТЕЛЬ У КЛІТИНЦІ РОЗКЛАДУ». Розклад, завантажений з
// файлу, приходить без пошт учителів, а портал потім показує вчителя
// уроку саме з матриці доступу (getDefaultTeacher). Тобто для більшості
// уроків доступ і Є призначенням. Якби «немає пошти в клітинці» вважалося
// «немає підстав», звірка запропонувала б зняти майже всіх.
//
// Тому три рівні:
//   ok   — класний керівник; або предмет закріплено за ЦІЄЮ людиною в
//          клітинці розкладу чи в каталозі предметів/гуртків;
//   weak — предмет у класі є, але вчителя ніде явно не вказано (доступ і є
//          призначенням); а також «Всі предмети» без класного керівництва —
//          це рішення директора, не наше;
//   bad  — предмета в класі немає зовсім, або він явно закріплений лише за
//          ІНШИМИ людьми.
// Звірка пропонує знімати тільки bad.
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Чи це той самий предмет. Назви приходять із різних місць — матриця
// доступу, розклад із файлу, каталог — і пишуться по-різному: «Укр. мова» і
// «Українська мова», «Англ. мова» і «Англійська мова», чергування «Музика /
// Фізкультура». Точне порівняння тихо відрізало вчителя від сповіщень.
// Правило: однакові після нормалізації; або є спільна частина чергування;
// або слова попарно збігаються, де скорочення (від 3 літер) — початок слова.
export function sameSubj(a, b){
  const nz = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const A = nz(a), B = nz(b);
  if(!A || !B) return false;
  if(A === B) return true;
  const pa = A.split(/\s*\/\s*/).filter(x => x.length >= 3), pb = B.split(/\s*\/\s*/).filter(x => x.length >= 3);
  if(pa.length > 1 || pb.length > 1) return pa.some(x => pb.some(y => sameSubj(x, y)));
  const ta = A.split(/[\s.,()\-]+/).filter(Boolean), tb = B.split(/[\s.,()\-]+/).filter(Boolean);
  if(!ta.length || ta.length !== tb.length) return false;
  return ta.every((x, i) => { const y = tb[i]; if(x === y) return true; const s = x.length < y.length ? x : y, l = x.length < y.length ? y : x; return s.length >= 3 && l.startsWith(s); });
}

const parts = s => { const n = norm(s); const p = n.split(/\s*\/\s*/).filter(x => x.length >= 3); return p.length > 1 ? [n, ...p] : [n]; };

//   schedules      — schedules/{клас}/{lessons|clubs}/{день}/[слоти]
//   heads          — class_teachers/{клас}.teacherEmail
//   catalog, clubs — {клас: {ключ: {name, teacherEmail}}} поточного року
export function accessBasis({ schedules, heads, catalog, clubs }, emailKeyFn){
  // classes[cls] = { heads:Set(se), subj: Map(назва → {owners:Set(se), open:bool}) }
  const classes = {};
  const C = cls => (classes[cls] ||= { heads: new Set(), subj: new Map() });
  const note = (cls, name, email) => {
    for(const n of parts(name)){
      if(!n) continue;
      const m = C(cls).subj;
      const e = m.get(n) || { owners: new Set(), open: false };
      if(email) e.owners.add(emailKeyFn(email)); else e.open = true;
      m.set(n, e);
    }
  };
  for(const [cls, sch] of Object.entries(schedules || {})){
    for(const days of [sch && sch.lessons, sch && sch.clubs]){
      for(const slots of Object.values(days || {})){
        (Array.isArray(slots) ? slots : Object.values(slots || {})).forEach(slot => {
          const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : Object.values(slot || {}));
          items.forEach(l => {
            if(!l || l.type === 'break') return;
            const name = typeof l.subject === 'string' ? l.subject : (l.subject && (l.subject.ua || l.subject.name)) || '';
            if(name) note(cls, name, l.teacherEmail || '');
          });
        });
      }
    }
  }
  for(const src of [catalog, clubs])
    for(const [cls, node] of Object.entries(src || {}))
      for(const e of Object.values(node || {})){
        if(typeof e === 'string') note(cls, e, '');
        else if(e && e.name) note(cls, e.name, e.teacherEmail || '');
      }
  for(const [cls, h] of Object.entries(heads || {}))
    if(h && h.teacherEmail) C(cls).heads.add(emailKeyFn(h.teacherEmail));
  return classes;
}

// → { level: 'ok'|'weak'|'bad', why: 'текст', others: [se] }
export function judgeSubject(classes, se, cls, subject){
  const c = classes && classes[cls];
  if(c && c.heads.has(se)) return { level: 'ok', why: 'класний керівник' };
  if(subject === ALL_SUBJECTS) return { level: 'weak', why: 'на всі предмети, але не класний керівник' };
  if(!c) return { level: 'bad', why: 'у класу немає розкладу' };
  const hits = [...c.subj.entries()].filter(([k]) => sameSubj(k, subject)).map(([, e]) => e);
  if(!hits.length) return { level: 'bad', why: 'предмета немає в розкладі класу' };
  if(hits.some(e => e.owners.has(se))) return { level: 'ok', why: 'за цією людиною в розкладі/каталозі' };
  if(hits.some(e => e.open)) return { level: 'weak', why: 'у розкладі класу, учителя не вказано' };
  const others = [...new Set(hits.flatMap(e => [...e.owners]))];
  return { level: 'bad', why: 'закріплено за іншим учителем', others };
}

// ── ХТО ВЕДЕ УРОКИ В КЛАСІ В КОНКРЕТНИЙ ДЕНЬ ─────────────────────
// Кому з учителів слати «учень відсутній / запізнюється». Раніше —
// усім, хто має доступ до класу, щодня: учитель з одним уроком у пʼятницю
// отримував сповіщення про клас щоранку, а супровід на басейн — теж.
//
// Тепер: класний керівник — завжди; решта — лише ті, хто цього дня веде
// в класі урок (за розкладом, з урахуванням замін). Басейн/плавання не
// рахуємо: це супровід, а не урок, і відсутність там нічого не змінює.
//
// ТА САМА ФУНКЦІЯ продубльована в netlify/functions/notify.js (сервер не
// може імпортувати модуль браузера). Тести звіряють обидві копії на
// однакових даних — див. tests-access.mjs.
export const NO_NOTIFY_RE = /басейн|плаванн/i;
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function itemNames(item){
  const alt = item && item.alt ? (Array.isArray(item.alt) ? item.alt : Object.values(item.alt))
    .map(x => typeof x === 'string' ? x : (x && x.ua) || '').map(s => String(s).trim()).filter(Boolean) : [];
  if(alt.length > 1) return alt;
  const raw = item && (typeof item.subject === 'object' ? (item.subject && item.subject.ua) : item.subject);
  const s = String(raw || '').trim();
  if(!s) return [];
  const p = s.split(/\s+\/\s+/).map(x => x.trim()).filter(Boolean);
  return p.length > 1 ? p : [s];
}
//   lessons — schedules/{клас}/lessons; subs — substitutions/{дата}/{клас}
//   weekday — 0 неділя … 6 субота; keyOf — emailKey
// → { keys: Set(ключів пошт), known: чи є розклад класу взагалі }
export function lessonTeachersOn({ lessons, access, heads, subs, cls, weekday, keyOf }){
  const out = new Set();
  const head = heads && heads[cls] && heads[cls].teacherEmail;
  if(head) out.add(keyOf(head));
  if(!lessons || typeof lessons !== 'object' || !Object.keys(lessons).length) return { keys: out, known: false };
  const raw = lessons[WEEK[weekday]] || [];
  // Array.from, а не map: Firebase віддає «дірявий» масив, коли якийсь
  // номер уроку пропущено, а map дірки зберігає — і перебір падав.
  const slots = Array.isArray(raw) ? Array.from(raw, (s, i) => [String(i), s]) : (raw && typeof raw === 'object' ? Object.entries(raw) : []);
  const nm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const holders = name => Object.entries(access || {}).filter(([, row]) => {
    const l = row && row[cls];
    return (Array.isArray(l) ? l : Object.values(l || {})).some(v => typeof v === 'string' && (v.trim() === ALL_SUBJECTS || sameSubj(v, name)));
  }).map(([k]) => k);
  for(const [idx, slot] of slots){
    const items = Array.isArray(slot) ? slot : (slot && typeof slot === 'object' && Object.keys(slot).length ? [slot] : []);
    for(const it of items){
      if(!it || typeof it !== 'object' || it.type === 'break' || it.type === 'extra') continue;
      for(const name of itemNames(it)){
        if(NO_NOTIFY_RE.test(name)) continue;
        const s = subs || {};
        const cover = (s[idx] && sameSubj(s[idx].subject, name)) ? s[idx] : (s.any && sameSubj(s.any.subject, name)) ? s.any : null;
        if(cover && cover.subEmail){ out.add(keyOf(cover.subEmail)); continue; }
        if(it.teacherEmail){ out.add(keyOf(it.teacherEmail)); continue; }
        holders(name).forEach(k => out.add(k));
      }
    }
  }
  return { keys: out, known: true };
}
// У які дні тижня (1–5) людина отримує сповіщення про клас — для таблиці доступу
export function notifyWeekdays(se, cls, { schedules, access, heads, keyOf }){
  const lessons = schedules && schedules[cls] && schedules[cls].lessons;
  const days = [];
  for(let wd = 1; wd <= 5; wd++){
    const r = lessonTeachersOn({ lessons, access, heads, subs: null, cls, weekday: wd, keyOf });
    if(!r.known) return null;              // розкладу немає — працює старе правило «усім з доступом»
    if(r.keys.has(se)) days.push(wd);
  }
  return days;
}

// ── УТОЧНЕННЯ ПІДСТАВ ────────────────────────────────────────────
// judgeSubject бачить лише розклад і каталоги. Але розклад, завантажений із
// файлу, не знає вчителів, тож «предмет є в розкладі» — це «weak» для всіх,
// хто колись отримав доступ: і для того, хто справді веде, і для того, хто
// раз був на заміні, і для того, кого помилково поставили не в той клас.
// Тут додаємо те, що відрізняє їх:
//   • підтвердження директора (teacher_access_meta…ok) → ok;
//   • той самий предмет у класі має ще хтось → 'dup' («хто веде?»);
//   • людина була в цьому класі на заміні з цього предмета, а предмет має
//     ще хтось → bad («лишилося після заміни»).
// subHist — subHistory(substitutions)
export function subHistory(substitutions, keyOf){
  const out = {};
  const nm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for(const [date, byCls] of Object.entries(substitutions || {}))
    for(const [cls, slots] of Object.entries(byCls || {}))
      for(const s of Object.values(slots || {})){
        if(!s || !s.subEmail || !s.subject) continue;
        (out[`${keyOf(s.subEmail)}|${cls}|${nm(s.subject)}`] ||= []).push(date);
      }
  for(const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}
// Дати замін людини в класі з цього предмета (назви — гнучко, див. sameSubj)
export function subDatesFor(subHist, se, cls, subject){
  const pre = `${se}|${cls}|`, out = [];
  for(const [k, v] of Object.entries(subHist || {}))
    if(k.startsWith(pre) && sameSubj(k.slice(pre.length), subject)) out.push(...v);
  return [...new Set(out)].sort();
}
export function refineJudge(base, { se, cls, subject, acc, meta, subHist }){
  if(meta && meta.ok) return { level: 'ok', why: 'підтверджено директором' };
  if(base.level !== 'weak' || subject === ALL_SUBJECTS) return base;
  const nm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const others = Object.keys(acc || {}).filter(k => k !== se && accessList(acc[k] && acc[k][cls]).some(s => sameSubj(s, subject)));
  const dates = subDatesFor(subHist, se, cls, subject);
  const dm = d => d.slice(8, 10) + '.' + d.slice(5, 7);
  const when = dates.length ? dates.slice(-3).map(dm).join(', ') : '';
  if(others.length && dates.length) return { level: 'bad', why: `лишилося після заміни (${when}); предмет має`, others, kind: 'sub' };
  // Ті, хто сам лише заміняв, не роблять предмет «спірним» для основного вчителя
  const real = others.filter(k => !subDatesFor(subHist, k, cls, subject).length);
  if(real.length) return { level: 'dup', why: 'цей предмет у класі має також', others: real };
  if(dates.length) return { ...base, why: `${base.why}; була заміна ${when}` };
  return base;
}

// ── ТИМЧАСОВИЙ ДОСТУП НА ЗАМІНУ ──────────────────────────────────
// temp_access/{пошта}/{клас} = {until, subj, date, by, at}. Діє до кінця дня
// заміни + TEMP_GRACE_DAYS (дописати тему й оцінки). Постійний доступ на
// заміну більше не видаємо — саме з нього бралися «вічні» доступи.
export const TEMP_GRACE_DAYS = 3;
export function tempUntil(date, grace = TEMP_GRACE_DAYS){
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d + grace, 23, 59, 59).getTime();
}
// current — наявний запис temp_access/{пошта}/{клас} або null
export function tempAccessPaths(se, cls, subject, date, current, by){
  const cur = current && typeof current === 'object' ? current : {};
  const until = Math.max(Number(cur.until) || 0, tempUntil(date));
  const subj = { ...(cur.subj || {}) };
  if(subject) subj[subjKey(subject)] = String(subject).slice(0, 80);
  const at = Date.now();
  const lastDate = [String(cur.date || ''), String(date).slice(0, 10)].sort().pop();
  const p = { [`temp_access/${se}/${cls}`]: { until, subj, date: lastDate, by: by || '', at } };
  p[`access_log/${logKey()}`] = { at, by: by || '', t: se, cls, src: 'substitute', act: 'grant', subj: subject ? [subject] : ['заміна'],
                                  note: `тимчасово до ${new Date(until).toLocaleDateString('uk-UA')}` };
  return p;
}
export async function grantTempAccess(se, cls, subject, date){
  const s = await get(child(ref(db), `temp_access/${se}/${cls}`)).catch(() => null);
  const p = tempAccessPaths(se, cls, subject, date, s && s.exists() ? s.val() : null, who());
  await update(ref(db), p);
  return p;
}
// Злиття для кабінету вчителя: постійні предмети + чинні тимчасові
export function mergeTempAccess(matrix, temp, now = Date.now()){
  const out = { ...(matrix || {}) };
  for(const [cls, t] of Object.entries(temp || {})){
    if(!t || !(Number(t.until) > now)) continue;
    const add = Object.values(t.subj || {}).filter(x => typeof x === 'string');
    out[cls] = [...new Set([...accessList(out[cls]), ...add])];
  }
  return out;
}

// Заміну скасували — тимчасовий доступ перераховуємо з тих замін, що
// лишилися (від 3 днів тому до 3 місяців уперед). Не лишилося жодної —
// доступ знімаємо одразу, а не чекаємо, поки мине строк.
//   subsByDate — substitutions за цей проміжок: {дата: {клас: {слот: {...}}}}
export function tempFromSubs(se, cls, subsByDate, keyOf){
  let until = 0, last = '';
  const subj = {};
  for(const [d, byCls] of Object.entries(subsByDate || {}))
    for(const s of Object.values((byCls || {})[cls] || {})){
      if(!s || !s.subEmail || keyOf(s.subEmail) !== se) continue;
      until = Math.max(until, tempUntil(d));
      if(d > last) last = d;
      if(s.subject) subj[subjKey(s.subject)] = String(s.subject).slice(0, 80);
    }
  return until ? { until, subj, date: last } : null;
}
export async function recomputeTempAccess(se, cls, today, keyOf){
  const [y, m, d] = String(today).split('-').map(Number);
  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const from = iso(new Date(y, m - 1, d - TEMP_GRACE_DAYS)), to = iso(new Date(y, m - 1, d + 92));
  const snap = await get(query(ref(db, 'substitutions'), orderByKey(), startAt(from), endAt(to)));
  const t = tempFromSubs(se, cls, snap.exists() ? snap.val() : {}, keyOf);
  const p = { [`temp_access/${se}/${cls}`]: t ? { ...t, by: who(), at: Date.now() } : null };
  await update(ref(db), p);
  return t;
}
