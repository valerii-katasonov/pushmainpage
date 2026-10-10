// ═══════════════════════════════════════════════════════════════
// staff-today.js — блок «Зараз» на «Сьогодні» вчителя.
//
// Той самий компонент, що в батьків (ui-today.js → renderNowCard), але
// про СВОЇ уроки: який іде, скільки до кінця, що далі. Під ним — дві
// дії, заради яких учитель і відкриває портал на уроці.
//
// УСІ КЛАСИ, А НЕ ВИБРАНИЙ. Предметник веде уроки в кількох класах, а
// вгорі вибраний один. Якщо брати лише його, картка бреше: о 9:10 учитель
// стоїть у 5-му, а картка (вибрано 3-й) пише «перерва, далі о 11:00».
// Тому читаємо розклад дня всіх класів зі списку вчителя (+ класи, де він
// сьогодні на заміні) і показуємо клас біля назви уроку. Майстер-роль
// бачить усі 11 класів — для неї лишаємо вибраний клас.
//
// «Мій урок» — те саме правило, що в myLessonsForDay (teacher.js): заміна
// на слот → лише в того, кого призначили; інакше — матриця доступу.
// Показуємо лише коли дата вгорі — сьогодні.
// ═══════════════════════════════════════════════════════════════
import { ref, get } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, parseTimeRange, localDateString, escHtml, dayKeys, getClassNum, isMasterTeacher } from './common.js';

const TTL = 10 * 60 * 1000;            // заміни можуть зʼявитися вдень — перечитуємо раз на 10 хв
let cache = { key: '', at: 0, items: [] };
let loading = null;

const lower = s => String(s || '').trim().toLowerCase();
const slotItems = slot => Array.isArray(slot) ? slot : ((slot && typeof slot === 'object' && Object.keys(slot).length) ? [slot] : []);
const subjNames = item => (window.expandAltSubjects ? window.expandAltSubjects(item)
  : [window.getValidSubjectName && window.getValidSubjectName(item)]).filter(Boolean);

// Уроки одного класу за день → мої уроки {subject, time, number, viaSub, cls}
export function classLessons(cls, slots, subs, me, allowed){
  const out = [];
  const any = subs && subs.any;
  // Firebase віддає «дірявий» масив як обʼєкт {0:…, 2:…} — індекс слота
  // беремо з ключа, бо саме за ним лежать заміни
  Object.keys(slots || {}).forEach(kk => {
    const slotIdx = Number(kk), slot = slots[kk];
    if(!Number.isInteger(slotIdx)) return;
    slotItems(slot).forEach(item => {
      subjNames(item).forEach(sn => {
        const sub = subs && subs[slotIdx];
        let mine, viaSub = false;
        if(sub){ mine = lower(sub.subEmail) === me; viaSub = true; }
        else if(any && lower(any.subject) === lower(sn)){ mine = lower(any.subEmail) === me; viaSub = true; }
        else mine = !!allowed(cls, sn);
        out.push({ subject: sn, time: item.time || '', number: item.number || (slotIdx + 1), mine, viaSub, cls });
      });
    });
  });
  return out;
}

// Уроки вчителя → елементи для nowState (ui-today.js). Клас — у назві,
// якщо сьогодні уроки більше ніж в одному класі.
export function teacherNowItems(lessons){
  const seen = new Set(), out = [];
  const mine = (lessons || []).filter(l => l && l.mine);
  const multi = new Set(mine.map(l => l.cls).filter(Boolean)).size > 1;
  mine.forEach(l => {
    const { start, end } = parseTimeRange(l.time);
    if(start == null || end == null) return;
    const k = `${start}|${l.subject}|${l.cls || ''}`; if(seen.has(k)) return; seen.add(k);
    const subj = multi && l.cls ? `${l.subject} · ${getClassNum(l.cls)} кл.` : l.subject;
    out.push({ subj, start, end, num: Number(l.number) || 0, sub: l.viaSub ? 'заміна' : '' });
  });
  return out.sort((a, b) => a.start - b.start);
}

export function actionsHtml(){
  return `<div class="ui-row t-now-acts">
    <button type="button" class="ui-btn ui-btn-2" onclick="goTeacherTab('lesson')">📝 Урок</button>
    <button type="button" class="ui-btn ui-btn-2" onclick="goTeacherAttendance()">✓ Присутні</button></div>`;
}

const WD = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
const MON = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
export function calmHtml(items, now){
  const head = `${WD[now.getDay()]}, ${now.getDate()} ${MON[now.getMonth()]}`;
  const msg = (items && items.length) ? 'Уроки на сьогодні закінчилися' : 'Сьогодні у вас уроків немає';
  const sub = (items && items.length) ? `Було уроків: ${items.length}` : 'Гарного дня!';
  return `<div class="ui-now ui-now-calm" role="status"><small>${escHtml(head)}</small>`
    + `<div class="ui-now-l">${escHtml(msg)}</div><div class="ui-now-m">${escHtml(sub)}</div></div>`;
}

// Класи вчителя: ті, що у випадайці (з матриці доступу, разом із тимчасовими)
function myClasses(){
  const sel = document.getElementById('t-class-selector');
  const role = currentUserData && currentUserData.role;
  if(!sel || isMasterTeacher(role)) return [getActiveClass()].filter(Boolean);
  return [...sel.options].map(o => o.value).filter(Boolean);
}

async function loadLessons(date){
  const classes = myClasses();
  const key = `${date}|${classes.join(',')}`;
  if(cache.key === key && Date.now() - cache.at < TTL) return cache.items;
  if(loading && loading.key === key) return loading.p;
  const p = (async () => {
    const me = lower(currentUserData && currentUserData.email);
    const [y, m, d] = date.split('-').map(Number);
    const dn = dayKeys[new Date(y, m - 1, d).getDay()];
    const read = path => get(ref(db, path)).then(s => s.exists() ? s.val() : null).catch(() => null);
    const subsAll = (await read(`substitutions/${date}`)) || {};
    // Класи, де я сьогодні на заміні, хоч їх і немає в моєму списку
    const extra = Object.keys(subsAll).filter(c => !classes.includes(c)
      && Object.values(subsAll[c] || {}).some(s => s && lower(s.subEmail) === me));
    const all = [...classes, ...extra];
    const scheds = await Promise.all(all.map(c => read(`schedules/${c}/lessons/${dn}`)));
    const allowed = (c, sn) => extra.includes(c) ? false : (window.isSubjectAllowed ? window.isSubjectAllowed(c, sn) : false);
    const items = teacherNowItems(all.flatMap((c, i) => classLessons(c, scheds[i], subsAll[c], me, allowed)));
    cache = { key, at: Date.now(), items };
    return items;
  })();
  loading = { key, p };
  try{ return await p; } finally { if(loading && loading.p === p) loading = null; }
}

export async function renderTeacherNow(){
  const box = document.getElementById('t-now');
  if(!box || !window.renderNowCard) return;
  const date = (document.getElementById('global-date') || {}).value;
  if(date !== localDateString){ box.style.display = 'none'; box.innerHTML = ''; return; }
  let items = [];
  try{ items = await loadLessons(date); }catch(e){ items = []; }
  // Поки читали, дату могли змінити
  if((document.getElementById('global-date') || {}).value !== date) return;
  const now = new Date();
  window.renderNowCard('t', items, now.getHours() * 60 + now.getMinutes());
  // Уроків немає або вже скінчилися — спокійна картка з датою, а не порожнеча:
  // верх екрана завжди відповідає на «що в мене сьогодні»
  if(!box.innerHTML) box.innerHTML = calmHtml(items, now);
  box.style.display = '';
  box.insertAdjacentHTML('beforeend', actionsHtml());
}
window.goTeacherTab = function(t){
  const b = document.querySelector(`#teacher-screen-tabs .dtab[data-t="${t}"]`);
  if(b) b.click();
  try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(e){}
};
window.goTeacherAttendance = function(){
  const card = document.querySelector('.t-att-card') || document.getElementById('t-att-header');
  if(card && card.scrollIntoView){ try{ card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){ card.scrollIntoView(); } }
};
window.renderTeacherNow = renderTeacherNow;
// Зміна контексту (вихід, інша роль) — кеш чужий
window.addEventListener('push:context', () => { cache = { key: '', at: 0, items: [] }; });
// Хвилина минула — оновлюємо «ще N хв» (лише коли вкладку видно)
setInterval(() => { if(document.visibilityState === 'visible' && document.getElementById('t-now')?.offsetParent) renderTeacherNow(); }, 60000);
