// ═══════════════════════════════════════════════════════════════
// school-events.js — календар подій школи і кабінет педагога-організатора.
//
// ЩО ТУТ
//   • «📅 Події цього місяця» — блок поруч із днями народження в кабінетах
//     учителя, батьків і учня: свята, канікули й культурно-виховні заходи
//     від сьогодні до кінця місяця.
//   • Редактор календаря: свята (вихідні) і культурно-виховні заходи.
//     Ним користуються педагог-організатор і директор.
//   • Перегляд розкладу будь-якого класу (для організатора — лише читання).
//   • Кабінет педагога-організатора (роль 'organizer').
//
// МОДЕЛЬ ДАНИХ
//   academic_year/{рік}/holidays/{id} = {title, date, classes, calendarType}
//       — СВЯТО = вихідний: його враховують навантаження й журнал.
//   academic_year/{рік}/events/{id}   = {title, date, time?, place?, note?,
//                                        classes, by, byName, ts}
//       — ЗАХІД не скасовує уроків, тому окремий вузол: інакше навантаження
//         (workload.js) рахувало б день заходу вихідним.
//   classes = 'all' | ['class_3', ...]
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, push, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, escJs, showToast, localDateString, getClassNum, dayNamesUA,
         isBreakItem, logAction } from './common.js';
import { ACTIVE_YEAR } from './director.js';

const CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
const MONTHS = ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'];
const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const KIND = {
  event:   { icon: '🎭', label: 'Культурно-виховний захід' },
  holiday: { icon: '🎉', label: 'Свято' },
  brk:     { icon: '🏖️', label: 'Канікули' }
};
const clsLabel = c => String(c || '').replace('class_', '') + ' клас';
const classesLabel = cs => cs === 'all' ? 'усі класи'
  : (Array.isArray(cs) ? cs : Object.values(cs || {})).slice().sort((a, b) => getClassNum(a) - getClassNum(b))
      .map(c => String(c).replace('class_', '')).join(', ') + ' кл.';
export function dayLabel(ds){
  const [y, m, d] = String(ds || '').split('-').map(Number);
  if(!y || !m || !d) return String(ds || '');
  return `${d} ${MONTHS[m - 1]}, ${WD[new Date(y, m - 1, d).getDay()]}`;
}
export function canManageCalendar(role){
  return role === 'organizer' || role === 'director' || role === 'administrator';
}

// Клас у переліку класів запису; cls='' — без фільтра (персонал школи)
export function classMatches(classes, cls){
  if(!cls) return true;
  if(classes === 'all') return true;
  const list = Array.isArray(classes) ? classes : Object.values(classes || {});
  return list.includes(cls);
}

export async function loadCalendar(){
  const base = `academic_year/${ACTIVE_YEAR}`;
  const g = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : {});
  const [holidays, events, breaks] = await Promise.all([g(`${base}/holidays`), g(`${base}/events`), g(`${base}/breaks`)]);
  const withId = o => Object.entries(o || {}).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => ({ id, ...v }));
  return { holidays: withId(holidays), events: withId(events), breaks: withId(breaks) };
}

// Усе, що припадає на [from; to], — одним відсортованим списком.
//   cls      — клас родини/вчителя ('' — усі)
//   calType  — 'general' | 'art_school' | '' (без фільтра) для свят
export function itemsBetween(cal, from, to, cls, calType){
  const out = [];
  for(const e of cal.events || [])
    if(e.date && e.date >= from && e.date <= to && classMatches(e.classes, cls))
      out.push({ kind: 'event', id: e.id, date: e.date, title: e.title || 'Захід', time: e.time || '', place: e.place || '', note: e.note || '', classes: e.classes });
  for(const h of cal.holidays || [])
    if(h.date && h.date >= from && h.date <= to && classMatches(h.classes, cls) && (!calType || !h.calendarType || h.calendarType === calType))
      out.push({ kind: 'holiday', id: h.id, date: h.date, title: h.title || 'Свято', classes: h.classes, calendarType: h.calendarType || '' });
  for(const b of cal.breaks || [])
    if(b.startDate && b.endDate && b.endDate >= from && b.startDate <= to && classMatches(b.classes, cls))
      out.push({ kind: 'brk', id: b.id, date: b.startDate < from ? from : b.startDate, dateTo: b.endDate, title: b.title || 'Канікули', classes: b.classes });
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
}
export function monthEnd(ds){
  const [y, m] = ds.split('-').map(Number);
  return `${ds.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

function itemRow(it, opts = {}){
  const k = KIND[it.kind];
  const when = it.kind === 'brk'
    ? `${escHtml(dayLabel(it.date))} – ${escHtml(dayLabel(it.dateTo))}`
    : escHtml(dayLabel(it.date)) + (it.time ? ` · ${escHtml(it.time)}` : '');
  const extra = [it.place && `📍 ${escHtml(it.place)}`, opts.showClasses && escHtml(classesLabel(it.classes))].filter(Boolean).join(' · ');
  return `<div class="ev-row ev-${it.kind}${it.date === localDateString ? ' ev-today' : ''}">
    <span class="ev-ico" title="${escHtml(k.label)}" aria-label="${escHtml(k.label)}">${k.icon}</span>
    <span class="ev-body"><b class="ev-name">${escHtml(it.title)}</b>
      <span class="ev-when">${it.date === localDateString ? '<i class="ev-now">сьогодні</i> ' : ''}${when}</span>
      ${extra ? `<span class="ev-extra">${extra}</span>` : ''}
      ${opts.showNote && it.note ? `<span class="ev-extra">${escHtml(it.note)}</span>` : ''}</span>
    ${opts.actions ? opts.actions(it) : ''}
  </div>`;
}

// ── «📅 Події цього місяця» поруч із днями народження ──
// Від сьогодні до кінця місяця. Нема подій — блок ховаємо: порожня рамка
// щодня нагорі кабінету — шум, а не інформація.
export async function renderMonthEvents(containerId, cls){
  const box = document.getElementById(containerId);
  if(!box) return;
  try{
    const cal = await loadCalendar();
    // Родині — лише її календар (загальна школа або школа мистецтв), як у
    // календарі кабінету. Персоналу — усі свята.
    const fam = currentUserData && (currentUserData.role === 'parent' || currentUserData.role === 'student');
    const calType = fam ? (currentUserData.isArtSchool ? 'art_school' : 'general') : '';
    const list = itemsBetween(cal, localDateString, monthEnd(localDateString), cls || '', calType);
    if(!list.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = `<div class="ev-title">📅 Події цього місяця</div>`
      + list.map(it => itemRow(it, { showClasses: !cls })).join('');
  }catch(e){
    console.warn('[Push School] події місяця:', e.message);
    box.style.display = 'none';
  }
}
window.renderMonthEvents = renderMonthEvents;

// ══════════ РЕДАКТОР КАЛЕНДАРЯ ══════════
// Один компонент на два кабінети (організатор, директор): prefix робить id
// унікальними, бо обидва кабінети лежать у сторінці одночасно.
const CM = {};
export async function renderCalendarManager(containerId, prefix){
  const box = document.getElementById(containerId);
  if(!box) return;
  const p = prefix || containerId;
  CM[p] = { containerId };
  const opts = CLASSES.map(c => `<option value="${c}">${escHtml(clsLabel(c))}</option>`).join('');
  box.innerHTML = `
    <div class="cm-form">
      <label for="${p}-type">Що додаємо</label>
      <select id="${p}-type" onchange="calFormType('${escJs(p)}')">
        <option value="event">🎭 Культурно-виховний захід</option>
        <option value="holiday">🎉 Свято (вихідний день)</option>
      </select>
      <input type="text" id="${p}-title" maxlength="120" placeholder="Назва (напр. Осінній ярмарок)">
      <div class="cm-row">
        <input type="date" id="${p}-date" aria-label="Дата">
        <input type="time" id="${p}-time" aria-label="Час (необовʼязково)" class="cm-ev-only">
      </div>
      <input type="text" id="${p}-place" maxlength="120" placeholder="Місце (необовʼязково)" class="cm-ev-only">
      <textarea id="${p}-note" rows="2" maxlength="400" placeholder="Опис (необовʼязково)" class="cm-ev-only"></textarea>
      <select id="${p}-caltype" class="cm-hol-only" style="display:none;" aria-label="Календар">
        <option value="general">🏫 Загальна школа</option>
        <option value="art_school">🎵 Школа мистецтв</option>
      </select>
      <label class="cm-all"><input type="checkbox" id="${p}-all" checked onchange="calFormType('${escJs(p)}')"> Усі класи</label>
      <select id="${p}-classes" multiple size="6" disabled aria-label="Класи">${opts}</select>
      <p class="cm-hint" id="${p}-hint">Захід зʼявиться в календарі батьків і в блоці «Події цього місяця». Уроки в цей день не скасовуються.</p>
      <button type="button" id="${p}-add" class="cm-add" onclick="calAdd('${escJs(p)}')">+ Додати</button>
    </div>
    <div id="${p}-list" class="cm-list"><p class="empty-msg">Завантаження...</p></div>`;
  await refreshCalendarList(p);
}
window.renderCalendarManager = renderCalendarManager;

window.calFormType = function(p){
  const hol = document.getElementById(`${p}-type`).value === 'holiday';
  const box = document.getElementById(CM[p].containerId);
  box.querySelectorAll('.cm-ev-only').forEach(el => { el.style.display = hol ? 'none' : ''; });
  box.querySelectorAll('.cm-hol-only').forEach(el => { el.style.display = hol ? '' : 'none'; });
  document.getElementById(`${p}-classes`).disabled = document.getElementById(`${p}-all`).checked;
  document.getElementById(`${p}-hint`).textContent = hol
    ? 'Свято — це вихідний: у цей день немає уроків, і його враховують журнал та навантаження.'
    : 'Захід зʼявиться в календарі батьків і в блоці «Події цього місяця». Уроки в цей день не скасовуються.';
};

async function refreshCalendarList(p){
  const box = document.getElementById(`${p}-list`);
  if(!box) return;
  try{
    const cal = await loadCalendar();
    CM[p].cal = cal;
    const all = itemsBetween({ events: cal.events, holidays: cal.holidays }, '0000-01-01', '9999-12-31', '', '');
    const next = all.filter(it => it.date >= localDateString), past = all.filter(it => it.date < localDateString).reverse();
    const del = it => `<button type="button" class="cm-del" aria-label="Видалити" title="Видалити" onclick="calDelete('${escJs(p)}','${it.kind}','${escJs(it.id)}')">✕</button>`;
    const row = it => itemRow(it, { showClasses: true, showNote: true, actions: del });
    box.innerHTML = `<div class="cm-sub">Найближчі (${next.length})</div>`
      + (next.length ? next.map(row).join('') : '<p class="empty-msg">Запланованих подій немає.</p>')
      + (past.length ? `<details class="cm-past"><summary>Минулі цього навчального року (${past.length})</summary>${past.map(row).join('')}</details>` : '');
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити календар: ${escHtml(e.message)}</p>`;
  }
}

let calBusy = false;
window.calAdd = async function(p){
  if(calBusy) return;
  const v = id => (document.getElementById(`${p}-${id}`)?.value || '').trim();
  const type = v('type'), title = v('title'), date = v('date');
  if(!title) return alert('Вкажіть назву.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return alert('Вкажіть дату.');
  const all = document.getElementById(`${p}-all`).checked;
  const picked = Array.from(document.getElementById(`${p}-classes`).selectedOptions).map(o => o.value);
  if(!all && !picked.length) return alert('Оберіть класи або позначте «Усі класи».');
  const classes = all ? 'all' : picked;
  const me = currentUserData || {};
  let rec, path;
  if(type === 'holiday'){
    rec = { title, date, classes, calendarType: v('caltype') || 'general' };
    path = `academic_year/${ACTIVE_YEAR}/holidays`;
  }else{
    rec = { title, date, classes, by: me.email || '', ts: Date.now(),
            byName: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email || '' };
    const time = v('time'), place = v('place'), note = v('note');
    if(time) rec.time = time;
    if(place) rec.place = place.slice(0, 120);
    if(note) rec.note = note.slice(0, 400);
    path = `academic_year/${ACTIVE_YEAR}/events`;
  }
  calBusy = true;
  const btn = document.getElementById(`${p}-add`);
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Зберігаю...'; }
  try{
    await push(ref(db, path), rec);
    logAction('settings', { value: `${type === 'holiday' ? 'свято' : 'захід'}: ${date} ${title}` });
    showToast(type === 'holiday' ? '✅ Свято додано' : '✅ Захід додано');
    ['title', 'time', 'place', 'note'].forEach(id => { const el = document.getElementById(`${p}-${id}`); if(el) el.value = ''; });
    await refreshCalendarList(p);
    refreshEverywhere();
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message + '\n\nЯкщо тут PERMISSION_DENIED — опублікуйте нові правила бази.');
  }finally{
    calBusy = false;
    if(btn){ btn.disabled = false; btn.textContent = '+ Додати'; }
  }
};

window.calDelete = async function(p, kind, id){
  if(kind !== 'event' && kind !== 'holiday') return;
  const it = [...(CM[p]?.cal?.events || []), ...(CM[p]?.cal?.holidays || [])].find(x => x.id === id);
  if(!confirm(`Видалити ${kind === 'event' ? 'захід' : 'свято'} «${it ? it.title : ''}»${it ? ' (' + dayLabel(it.date) + ')' : ''}?`)) return;
  try{
    await remove(ref(db, `academic_year/${ACTIVE_YEAR}/${kind === 'event' ? 'events' : 'holidays'}/${id}`));
    showToast('🗑️ Видалено');
    await refreshCalendarList(p);
    refreshEverywhere();
  }catch(e){ alert('Не вдалося видалити: ' + e.message); }
};

// Після зміни календаря оновлюємо все, що з нього малюється на сторінці
function refreshEverywhere(){
  if(window.loadAcademicYear && document.getElementById('ay-holidays-list')?.offsetParent) window.loadAcademicYear();
  const om = document.getElementById('o-month-events');
  if(om && om.closest('.panel')?.style.display !== 'none') renderMonthEvents('o-month-events', '');
}

// ══════════ РОЗКЛАД КЛАСУ (лише перегляд) ══════════
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
export function scheduleTableHtml(lessons){
  const items = (d, i) => { const s = ((lessons || {})[d] || [])[i]; return Array.isArray(s) ? s : (s && s.subject ? [s] : Object.values(s || {})); };
  let max = 0;
  WEEK.forEach(d => { const a = (lessons || {})[d]; if(Array.isArray(a)) max = Math.max(max, a.length); else if(a && typeof a === 'object') max = Math.max(max, Object.keys(a).length); });
  let rows = '', num = 0;
  for(let i = 0; i < max; i++){
    const cells = WEEK.map(d => items(d, i).map(l => {
      const sn = typeof l.subject === 'string' ? l.subject : (l.subject && l.subject.ua) || '';
      if(!sn) return '';
      return `<div class="${isBreakItem(l) ? 'os-break' : ''}">${escHtml(sn)}${l.teacherName && !isBreakItem(l) ? `<small>${escHtml(l.teacherName)}</small>` : ''}</div>`;
    }).join(''));
    if(!cells.some(c => c.trim())) continue;
    const service = WEEK.every(d => { const it = items(d, i); return !it.length || it.every(l => isBreakItem(l) || l.type === 'class_hour'); });
    if(!service) num++;
    const t = WEEK.map(d => (items(d, i)[0] || {}).time).find(Boolean) || '';
    rows += `<tr><td class="os-num">${service ? '·' : num}<small>${escHtml(String(t).replace(' - ', '–'))}</small></td>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  }
  if(!rows) return '<p class="empty-msg">Розклад цього класу ще не заповнено.</p>';
  return `<div class="os-wrap"><table class="os-table"><thead><tr><th>№</th>${WEEK.map(d => `<th>${escHtml(dayNamesUA[d] || d)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
export function renderScheduleViewer(containerId){
  const box = document.getElementById(containerId);
  if(!box) return;
  box.innerHTML = `<div class="cm-row">
      <select id="${containerId}-cls" aria-label="Клас" onchange="orgShowSchedule('${escJs(containerId)}')">
        ${CLASSES.map(c => `<option value="${c}">${escHtml(clsLabel(c))}</option>`).join('')}</select>
      <button type="button" class="cm-print" onclick="printClassSchedule(document.getElementById('${escJs(containerId)}-cls').value)">🖨️ Друк</button>
    </div><div id="${containerId}-view"></div>`;
  window.orgShowSchedule(containerId);
}
window.orgShowSchedule = async function(containerId){
  const cls = document.getElementById(`${containerId}-cls`).value;
  const view = document.getElementById(`${containerId}-view`);
  view.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const s = await get(child(ref(db), `schedules/${cls}/lessons`));
    view.innerHTML = scheduleTableHtml(s.exists() ? s.val() : {});
  }catch(e){
    view.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити розклад: ${escHtml(e.message)}</p>`;
  }
};

// ══════════ КАБІНЕТ РОЛІ З КОНСТРУКТОРА ══════════
// Педагог-організатор і будь-яка роль, зібрана директором галочками.
// Показуємо лише блоки, на які є право; решта прихована. Самі дані однаково
// стережуть правила бази — сховати блок тут означає лише не плутати людину.
window.initOrganizerScreen = function(){
  const role = currentUserData && currentUserData.role;
  const has = p => !!(window.hasPerm && window.hasPerm(p, role));
  const def = window.roleDef ? window.roleDef(role) : null;
  const title = document.getElementById('o-title');
  if(title && def) title.textContent = `${def.icon || '🧩'} ${def.name}`;
  const show = (id, on) => { const el = document.getElementById(id); if(el) el.style.display = on ? '' : 'none'; };
  show('o-sec-calendar', has('calendar'));
  show('o-sec-news', has('news'));
  show('o-sec-schedule', has('schedule'));
  show('o-sec-meals', has('meals'));
  show('o-no-perms', !['calendar', 'news', 'schedule', 'meals'].some(has));
  // Події місяця бачать усі — це просто календар школи
  renderMonthEvents('o-month-events', '');
  if(has('calendar')) renderCalendarManager('o-cal-manager', 'ocm');
  if(has('schedule')) renderScheduleViewer('o-schedule');
  if(window.renderNewsFeed) window.renderNewsFeed('o-news-feed');
  if(has('meals') && window.renderStaffMeals) window.renderStaffMeals();
};
