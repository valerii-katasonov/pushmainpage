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
import { ref, get, child, push, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, subjKey } from './common.js';

export const ACCESS_SRC = {
  manual:   'вручну',
  homeroom: 'класний керівник',
  schedule: 'розклад',
  catalog:  'каталог предметів',
  club:     'гурток',
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
  const hits = parts(subject).map(n => c.subj.get(n)).filter(Boolean);
  if(!hits.length) return { level: 'bad', why: 'предмета немає в розкладі класу' };
  if(hits.some(e => e.owners.has(se))) return { level: 'ok', why: 'за цією людиною в розкладі/каталозі' };
  if(hits.some(e => e.open)) return { level: 'weak', why: 'у розкладі класу, учителя не вказано' };
  const others = [...new Set(hits.flatMap(e => [...e.owners]))];
  return { level: 'bad', why: 'закріплено за іншим учителем', others };
}
