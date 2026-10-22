// ═══════════════════════════════════════════════════════════════
// group-grades.js — 📝 «Оцінки за роботу»: одна робота — весь клас.
//
// НАВІЩО. Після самостійної чи контрольної вчитель виставляє 20 оцінок
// одного типу за один день. У сітці журналу це 20 окремих вікон. Тут —
// обрав предмет, дату й вид роботи → список класу → у кожного свій
// рядок → «Зберегти». Вийде окремий стовпець журналу з цим типом.
//
// ЧИМ ВІДРІЗНЯЄТЬСЯ ВІД «⚡ Швидкого журналу». Швидкий журнал — це урок:
// відвідуваність + оцінки в ПЕРШИЙ стовпець дня. Якщо там уже стояла
// усна відповідь, контрольна її замінила б. «Оцінки за роботу» за
// замовчуванням беруть ВІЛЬНИЙ стовпець (або новий), тож нічого з уже
// виставленого не губиться; можна й обрати наявний стовпець, щоб
// дописати або виправити оцінки цієї роботи.
//
// ДАНІ — ті самі, що в журналі, нічого нового:
//   grades / grade_types / student_grades (gradeWritePaths) — оцінки;
//   journal_columns/{клас}/{місяць}/{предмет}/{дата}/count — щоб новий
//     стовпець лишився в сітці й після видалення оцінок;
//   journal_column_types/{…}/{ключ} — тип стовпця в шапці журналу.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, getActiveClass, gradeTypesCache, gradeWritePaths, journalGradeKey, journalBaseDate, journalSlot,
         getClassNum, LEVEL_MAX_CLASS, LEVEL_LETTERS, validDailyGrade, displayGrade, notifyEvent, logAction,
         escHtml, showToast, THEMATIC, dayKeys, mondayOf, localDateString } from './common.js';
import { fillActionSubject, actionSubject } from './teacher.js';
import { scheduledSubjectCount } from './journal.js';

export const MAX_SLOTS = 30;
const DEFAULT_TYPES = ['СР', 'К', 'ДК', 'ПР', 'ПЗ', 'У', 'ДЗ', 'П'];

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
// Стовпці дня: {slot, key, n (скільки оцінок), type (тип стовпця або
// найчастіший тип оцінок)} для 1…max(розклад, додані, з оцінками)
export function dayColumns(date, grades, types, colTypes, scheduled = 0, manual = 0){
  const used = {};
  for(const key in (grades || {})){
    if(journalBaseDate(key) !== date) continue;
    const vals = Object.entries(grades[key] || {}).filter(([, v]) => v !== null && v !== '');
    if(!vals.length) continue;
    const slot = journalSlot(key);
    const cnt = {};
    vals.forEach(([sid]) => { const t = (types && types[key] && types[key][sid]) || 'П'; cnt[t] = (cnt[t] || 0) + 1; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    used[slot] = { n: vals.length, gtype: top ? top[0] : '' };
  }
  const max = Math.max(scheduled || 0, manual || 0, ...Object.keys(used).map(Number), 0);
  const out = [];
  for(let slot = 1; slot <= Math.min(max, MAX_SLOTS); slot++){
    const key = journalGradeKey(date, slot);
    const u = used[slot] || { n: 0, gtype: '' };
    out.push({ slot, key, n: u.n, type: (colTypes && colTypes[key]) || u.gtype || '' });
  }
  return out;
}
// Куди писати роботу за замовчуванням: порожній стовпець без чужого типу,
// інакше — новий. Наявні оцінки так ніколи не перезаписуються самі.
// ПЕРШИЙ СТОВПЕЦЬ — НІКОЛИ за замовчуванням: це стовпець уроку, у який
// пише «⚡ Швидкий журнал». Поставили б туди контрольну — і наступна
// усна оцінка через швидкий журнал переписала б її.
export function pickSlot(cols, type){
  const free = cols.find(c => c.slot >= 2 && c.n === 0 && (!c.type || c.type === type));
  if(free) return free.slot;
  return Math.min(Math.max(cols.length ? cols[cols.length - 1].slot : 0, 1) + 1, MAX_SLOTS + 1);
}
// Перевірка однієї оцінки: рівень П/С/Д/В у 1–4 класах, бал — з 5-го
export function gradeOk(v, { junior, max = 6, modifiers = false }){
  if(!v) return true;
  if(junior) return LEVEL_LETTERS.includes(v.toUpperCase());
  return validDailyGrade(v, max) && (!/[+\-]$/.test(v) || modifiers);
}
// Що записати: rows = [{sid, v, orig, origType}] → {paths, changed:[sid]}
export function buildPatch({ cls, ym, subj, key, type, rows, setCount, setColType }){
  const paths = {}, changed = [];
  rows.forEach(r => {
    const v = r.v, o = r.orig || '';
    if(v !== o){
      Object.assign(paths, gradeWritePaths(cls, ym, subj, key, r.sid, v || null, v ? type : null));
      if(v) changed.push(r.sid);
    }else if(v && r.origType !== type){
      // Оцінка та сама, змінили лише вид роботи — без «нової оцінки» родині
      paths[`grade_types/${cls}/${ym}/${subj}/${key}/${r.sid}`] = type;
      paths[`student_grades/${cls}/${r.sid}/${ym}/${subj}/${key}/t`] = type;
    }
  });
  if(Object.keys(paths).length){
    if(setCount) paths[`journal_columns/${cls}/${ym}/${subj}/${journalBaseDate(key)}/count`] = setCount;
    if(setColType) paths[`journal_column_types/${cls}/${ym}/${subj}/${key}`] = type;
  }
  return { paths, changed };
}

// ── ВІКНО ───────────────────────────────────────────────────────
let st = null;   // {cls, subj, date, ym, cols, students, grades, types, junior, max, modifiers, numeric, manual, scheduled}
let colTouched = false, saving = false;

function overlay(){
  let o = document.getElementById('group-grades-modal');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'group-grades-modal'; o.className = 'modal-overlay'; o.style.zIndex = '1012';
  o.innerHTML = `<div class="modal-content gg-modal">
    <h2 class="gg-h">📝 Оцінки за роботу</h2>
    <p class="gg-sub">Одна робота — оцінки всьому класу. Кожна робота лягає в окремий стовпець журналу, уже виставлене не зникне.</p>
    <div class="gg-grid">
      <label>Предмет<select id="gg-subject" class="act-subj"></select></label>
      <label>Дата<input type="date" id="gg-date"></label>
      <label>Вид роботи<select id="gg-type"></select></label>
      <label>Стовпець<select id="gg-col"></select></label>
    </div>
    <div id="gg-body"></div>
    <p id="gg-msg" class="gg-msg" role="status"></p>
    <button type="button" id="gg-save" class="gg-save">💾 Зберегти оцінки</button>
    <button type="button" class="gg-cancel" onclick="closeGroupGrades()">Скасувати</button>
  </div>`;
  o.addEventListener('click', e => { if(e.target === o) closeGroupGrades(); });
  o.querySelector('#gg-subject').addEventListener('change', () => load());
  o.querySelector('#gg-date').addEventListener('change', () => load());
  o.querySelector('#gg-col').addEventListener('change', () => { colTouched = true; paintRows(true); });
  // Інший вид роботи — інший стовпець за замовчуванням (поки вчитель сам не обрав)
  o.querySelector('#gg-type').addEventListener('change', () => {
    if(!st || colTouched) return;
    const want = pickSlot(st.cols, o.querySelector('#gg-type').value);
    if(want <= MAX_SLOTS){ o.querySelector('#gg-col').value = String(want); paintRows(false); }
  });
  o.querySelector('#gg-save').addEventListener('click', () => save());
  o.querySelector('#gg-body').addEventListener('keydown', e => {
    if(e.key !== 'Enter' || !e.target.classList.contains('gg-g')) return;
    e.preventDefault();
    const all = [...o.querySelectorAll('.gg-g')], i = all.indexOf(e.target);
    if(all[i + 1]) all[i + 1].focus(); else o.querySelector('#gg-save').focus();
  });
  document.body.appendChild(o);
  return o;
}
const typeLabel = c => c === THEMATIC ? '📘 Тематична (ТО)' : ((gradeTypesCache[c] && gradeTypesCache[c].label) || c);

export async function openGroupGrades(){
  const o = overlay();
  const subj = await fillActionSubject('gg-subject', actionSubject('gg-subject'));
  if(!subj){ showToast('⚠️ Предметів класу не задано. Директор заповнює їх у «📗 Предмети класу й учителі»'); return; }
  o.querySelector('#gg-date').value = document.getElementById('global-date')?.value || new Date().toISOString().slice(0, 10);
  const codes = [...new Set([...(Object.keys(gradeTypesCache).length ? Object.keys(gradeTypesCache) : DEFAULT_TYPES).filter(c => c !== THEMATIC), THEMATIC])];
  const sel = o.querySelector('#gg-type');
  sel.innerHTML = codes.map(c => `<option value="${escHtml(c)}">${escHtml(typeLabel(c))}</option>`).join('');
  sel.value = codes.includes('СР') ? 'СР' : codes[0];
  o.querySelector('#gg-msg').textContent = '';
  o.style.display = 'flex';
  load();
}
window.closeGroupGrades = function(){ const o = document.getElementById('group-grades-modal'); if(o) o.style.display = 'none'; };

let seq = 0;
async function load(){
  if(saving) return;
  const o = overlay(), my = ++seq;
  colTouched = false;
  const cls = getActiveClass(), subj = actionSubject('gg-subject'), date = o.querySelector('#gg-date').value;
  const body = o.querySelector('#gg-body');
  if(!cls || !subj || !/^\d{4}-\d{2}-\d{2}$/.test(date)){ body.innerHTML = ''; return; }
  body.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  const ym = date.slice(0, 7);
  try{
    const [stSnap, gSnap, tSnap, ctSnap, cntSnap, aSnap, scSnap] = await Promise.all([
      get(child(ref(db), `students_list/${cls}`)),
      get(child(ref(db), `grades/${cls}/${ym}/${subj}`)),
      get(child(ref(db), `grade_types/${cls}/${ym}/${subj}`)),
      get(child(ref(db), `journal_column_types/${cls}/${ym}/${subj}`)).catch(() => null),
      get(child(ref(db), `journal_columns/${cls}/${ym}/${subj}/${date}/count`)).catch(() => null),
      get(child(ref(db), `attendance/${cls}/${date}`)).catch(() => null),
      get(child(ref(db), `grade_scales/${cls}/${subj}`)).catch(() => null)
    ]);
    if(my !== seq) return;
    const junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
    const numeric = !junior && !!(scSnap && scSnap.exists());
    let max = numeric ? Number(scSnap.val().max || scSnap.val()) : 6;
    if(!Number.isInteger(max) || max < 2 || max > 2000) max = 6;      // як у журналі
    const dow = new Date(date + 'T12:00:00').getDay();
    let scheduled = 0;
    try{ if(dow % 6 && window.schedule) scheduled = scheduledSubjectCount(window.schedule, dayKeys[dow], subj, (window.altChoices || {})[mondayOf(date)] || {}); }catch(e){}
    const manual = Number(cntSnap && cntSnap.exists() ? cntSnap.val() : 0) || 0;
    const grades = gSnap.exists() ? gSnap.val() : {}, types = tSnap.exists() ? tSnap.val() : {};
    const colTypes = ctSnap && ctSnap.exists() ? ctSnap.val() : {};
    const cols = dayColumns(date, grades, types, colTypes, scheduled, manual);
    const students = stSnap.exists() ? Object.entries(stSnap.val()).map(([sid, nm]) => ({ sid, nm: String(nm) })).sort((a, b) => a.nm.localeCompare(b.nm, 'uk')) : [];
    const att = aSnap && aSnap.exists() ? aSnap.val() : {};
    st = { cls, subj, date, ym, cols, students, grades, types, junior, max, numeric, modifiers: max === 6 && !junior, manual, scheduled, att };
    // Стовпці: наявні + «новий»
    const type = o.querySelector('#gg-type').value;
    const colSel = o.querySelector('#gg-col');
    const next = Math.max(cols.length, 1) + 1;
    colSel.innerHTML = cols.map(c => `<option value="${c.slot}">Стовпець ${c.slot}${c.type ? ` · ${escHtml(c.type)}` : ''} · ${c.n ? `оцінок: ${c.n}` : 'порожній'}</option>`).join('')
      + (next <= MAX_SLOTS ? `<option value="${next}">➕ Новий стовпець ${next}</option>` : '');
    const want = pickSlot(cols, type);
    // 30 стовпців на день уже зайнято — нового немає. Не підставляємо тихо
    // перший (там чужі оцінки): лишаємо останній і кажемо про це прямо.
    colSel.value = String(want <= MAX_SLOTS ? want : cols[cols.length - 1].slot);
    const m = o.querySelector('#gg-msg');
    m.textContent = want > MAX_SLOTS ? `⚠️ На цей день уже ${MAX_SLOTS} стовпців — нового не додати. Оберіть наявний або інший день.` : '';
    m.classList.toggle('bad', want > MAX_SLOTS);
    paintRows(false);
  }catch(e){ if(my === seq) body.innerHTML = `<p class="empty-msg">Помилка: ${escHtml(e.message || '')}</p>`; }
}

// adoptType — підставити вид стовпця, коли вчитель сам перейшов на наявний
// стовпець (дописати/виправити ту роботу). Свій обраний вид не чіпаємо.
function paintRows(adoptType){
  const o = overlay(), body = o.querySelector('#gg-body');
  if(!st) return;
  if(!st.students.length){ body.innerHTML = '<p class="empty-msg">У класі немає учнів.</p>'; return; }
  const slot = Number(o.querySelector('#gg-col').value) || 1;
  const key = journalGradeKey(st.date, slot);
  const cell = st.grades[key] || {}, ctype = st.types[key] || {};
  const col = st.cols.find(c => c.slot === slot);
  if(adoptType && col && col.type) o.querySelector('#gg-type').value = col.type;
  body.innerHTML = `<div class="gg-list">` + st.students.map((s, i) => {
    const cur = String(cell[s.sid] ?? '');
    const shown = st.junior ? displayGrade(cur, st.cls, false) : cur;
    const a = st.att[s.sid] || st.att[s.nm] || {};
    const absent = Object.values(a).some(r => r && r.status === 'absent');
    const late = !absent && Object.values(a).some(r => r && r.status === 'late');
    const ctl = st.junior
      // Стара оцінка не рівнем (до переходу на П/С/Д/В) — лишаємо її окремим
      // пунктом. Без нього список показав би «—», і незаймана оцінка
      // видалилася б при збереженні.
      ? `<select class="gg-g" aria-label="Рівень: ${escHtml(s.nm)}"><option value="">—</option>${cur && !LEVEL_LETTERS.includes(shown) ? `<option value="${escHtml(shown)}" selected>${escHtml(shown)}</option>` : ''}${LEVEL_LETTERS.map(l => `<option${shown === l ? ' selected' : ''}>${l}</option>`).join('')}</select>`
      : `<input type="text" class="gg-g" inputmode="numeric" autocomplete="off" maxlength="${String(st.max).length + (st.modifiers ? 1 : 0)}" value="${escHtml(cur)}" placeholder="${st.modifiers ? '1–6 ±' : `1–${st.max}`}" aria-label="Оцінка: ${escHtml(s.nm)}">`;
    return `<div class="gg-row" data-sid="${escHtml(s.sid)}" data-name="${escHtml(s.nm)}" data-orig="${escHtml(st.junior ? shown : cur)}" data-otype="${escHtml(ctype[s.sid] || '')}">
      <span class="gg-n">${i + 1}</span><span class="gg-name">${escHtml(s.nm)}${absent ? ' <em class="gg-abs">Н</em>' : late ? ' <em class="gg-late">З</em>' : ''}</span>${ctl}</div>`;
  }).join('') + `</div>`;
  const first = body.querySelector('.gg-g'); if(first) setTimeout(() => first.focus(), 30);
}

async function save(){
  const o = overlay(), btn = o.querySelector('#gg-save'), msg = o.querySelector('#gg-msg');
  if(!st) return;
  const type = o.querySelector('#gg-type').value;
  const slot = Number(o.querySelector('#gg-col').value) || 1;
  const key = journalGradeKey(st.date, slot);
  const rows = [...o.querySelectorAll('.gg-row')].map(r => {
    const raw = r.querySelector('.gg-g').value.trim().replace('−', '-');
    return { sid: r.dataset.sid, name: r.dataset.name, v: st.junior ? raw.toUpperCase() : raw, orig: r.dataset.orig || '', origType: r.dataset.otype || '' };
  });
  // Майбутній день журнал не показує — оцінки «зникли б» до того дня
  if(st.date > localDateString){ msg.textContent = '⚠️ Дата ще не настала — оберіть сьогодні або минулий день.'; msg.classList.add('bad'); return; }
  const bad = rows.find(r => r.v !== r.orig && !gradeOk(r.v, st));
  if(bad){
    msg.textContent = `⚠️ ${bad.name}: ${st.junior ? 'оберіть рівень П, С, Д або В' : st.modifiers ? 'оцінка від 1 до 6, можна + або −' : `оцінка від 1 до ${st.max}`}`;
    msg.classList.add('bad'); return;
  }
  // Стовпець понад розклад і вже додані — закріплюємо лічильник, щоб він
  // лишився в сітці журналу навіть після видалення оцінок
  const { paths, changed } = buildPatch({ cls: st.cls, ym: st.ym, subj: st.subj, key, type, rows,
    setCount: slot > Math.max(st.scheduled, st.manual) ? slot : 0, setColType: true });
  if(!Object.keys(paths).length){ msg.textContent = 'Нічого не змінено.'; msg.classList.remove('bad'); return; }
  // Обрали наявний стовпець і інший вид — це змінить вид і вже стоячим оцінкам
  const retype = rows.filter(r => r.v && r.v === r.orig && r.origType && r.origType !== type).length;
  if(retype && !confirm(`У стовпці вже є оцінки іншого виду: ${retype}. Змінити їм вид на «${typeLabel(type)}»?\n\nСкасувати — нічого не збережеться; оберіть «Новий стовпець».`)) return;
  // Знімок того, що зберігаємо: поки йде запис, поля заблоковані, а
  // сповіщення й журнал дій беруть саме ці значення, не поточні з вікна
  const snap = { cls: st.cls, subj: st.subj, date: st.date, numeric: st.numeric };
  const ctrls = [...o.querySelectorAll('#gg-subject, #gg-date, #gg-type, #gg-col')];
  saving = true; ctrls.forEach(c => { c.disabled = true; });
  btn.disabled = true; btn.textContent = '⏳ Збереження...';
  try{
    await update(ref(db), paths);
    const shown = v => displayGrade(v, snap.cls, snap.numeric) + (type === THEMATIC ? ' (тематична)' : '');
    rows.filter(r => changed.includes(r.sid)).forEach(r =>
      notifyEvent('grade', { class: snap.cls, studentName: r.name, subject: snap.subj, value: shown(r.v) }));
    logAction('group_grades', { cls: snap.cls, subject: snap.subj, date: snap.date, value: `${type}: оцінок ${changed.length} (стовпець ${slot})` });
    showToast(`✅ ${typeLabel(type)}: збережено оцінок — ${changed.length}`);
    window.closeGroupGrades();
    const jm = document.getElementById('journal-modal');
    if(typeof window.renderJournalTable === 'function' && jm && getComputedStyle(jm).display !== 'none') window.renderJournalTable();
  }catch(e){
    msg.textContent = /permission[_ ]denied/i.test(e.message || '') ? '⛔ Немає прав виставляти оцінки в цьому класі' : '❌ Не збережено: ' + (e.message || '');
    msg.classList.add('bad');
  }finally{ saving = false; ctrls.forEach(c => { c.disabled = false; }); btn.disabled = false; btn.textContent = '💾 Зберегти оцінки'; }
}
window.openGroupGrades = openGroupGrades;
