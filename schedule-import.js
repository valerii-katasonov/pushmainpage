// ═══════════════════════════════════════════════════════════════
// schedule-import.js — розклад класу з файлу Word.
//
// ЩО ЧИТАЄМО. Школа веде розклад у .docx однією таблицею:
//     №  | Понеділок | Вівторок | Середа | Четвер | Пʼятниця
//     1  | English   | ...
// Перший рядок — заголовок із назвами днів, перша колонка — номер уроку,
// решта клітинок — предмети. Порожня клітинка означає, що уроку немає.
//
// ЧОМУ ДВІ ФУНКЦІЇ, А НЕ ОДНА. Розбір таблиці — чиста логіка, її можна
// перевірити тестами без браузера. Читання самого .docx потребує
// сторонньої бібліотеки й DOM, тож воно окремо.
//
// ЧАС УРОКІВ У ФАЙЛІ НЕМАЄ. Беремо його з розкладу дзвінків класу. Це не
// дрібниця: кабінет батьків пропускає уроки без часу — вони просто не
// показуються. Тому без дзвінків імпорт зупиняється й каже про це.
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, logAction, getClassNum } from './common.js';

export const IMPORT_BUILD = '2026-09-02 · docx v1';

// Назви днів у заголовку → ключі, якими користується портал
const DAY_KEYS = {
  'понеділок':'Monday', 'пн':'Monday', 'poniedziałek':'Monday', 'poniedzialek':'Monday',
  'вівторок':'Tuesday', 'вт':'Tuesday', 'wtorek':'Tuesday',
  'середа':'Wednesday', 'ср':'Wednesday', 'środa':'Wednesday', 'sroda':'Wednesday',
  'четвер':'Thursday', 'чт':'Thursday', 'czwartek':'Thursday',
  'пʼятниця':'Friday', 'п’ятниця':'Friday', "п'ятниця":'Friday', 'пт':'Friday',
  'piątek':'Friday', 'piatek':'Friday',
  'субота':'Saturday', 'сб':'Saturday', 'sobota':'Saturday'
};

function dayKey(text){
  const t = String(text || '').trim().toLowerCase().replace(/[.\s]+$/,'');
  return DAY_KEYS[t] || null;
}

// «3 клас», «РОЗКЛАД УРОКІВ 3 клас», «3 klasa» → 3
export function classFromTitle(text){
  const m = /(\d{1,2})\s*(?:-?\s*[a-zа-яіїєґ]{0,3})?\s*(?:клас|klas)/i.exec(String(text || ''));
  if(!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 11) ? n : null;
}

// Клітинка «Музичне мистецтво / Фізичне виховання» — два уроки одночасно
// для різних підгруп. Конструктор саме так їх і зберігає: масивом у слоті.
export function splitCell(text){
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/\s*[\/|]\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

// rows — масив рядків таблиці, кожен рядок масив клітинок (рядками).
// Повертає { days:{Monday:[...]}, lessons:N, warnings:[] } або null.
export function parseScheduleTable(rows){
  if(!Array.isArray(rows) || rows.length < 2) return null;

  // Шукаємо рядок заголовка: у ньому мають бути назви днів
  let head = -1, cols = {};
  for(let i = 0; i < Math.min(rows.length, 5); i++){
    const found = {};
    (rows[i] || []).forEach((c, ci) => { const k = dayKey(c); if(k) found[ci] = k; });
    if(Object.keys(found).length >= 2){ head = i; cols = found; break; }
  }
  if(head < 0) return null;

  const days = {}, warnings = [];
  Object.values(cols).forEach(k => { days[k] = []; });
  let lessons = 0, maxNum = 0;

  for(let r = head + 1; r < rows.length; r++){
    const row = rows[r] || [];
    const numRaw = String(row[0] == null ? '' : row[0]).trim();
    const num = parseInt(numRaw, 10);
    if(!num || num < 1 || num > 20) continue;      // не рядок уроку
    maxNum = Math.max(maxNum, num);
    Object.entries(cols).forEach(([ci, key]) => {
      const parts = splitCell(row[ci]);
      if(!parts.length) return;
      if(parts.length > 1) warnings.push(`${key}, урок ${num}: «${parts.join(' / ')}» — збережемо як паралельні`);
      days[key][num - 1] = parts;
      lessons += parts.length;
    });
  }
  // Дірки в масиві днів робимо явними порожніми слотами
  Object.keys(days).forEach(k => {
    for(let i = 0; i < maxNum; i++) if(!days[k][i]) days[k][i] = [];
    days[k].length = maxNum;
  });
  return lessons ? { days, lessons, maxNum, warnings } : null;
}

// Часи з розкладу дзвінків: {1:'09:00 - 09:45', ...}
export function bellTimes(bells){
  const out = {};
  Object.values(bells || {}).forEach(s => {
    const n = parseInt(s && s.number, 10);
    if(!n || !s.start || !s.end) return;
    out[n] = `${s.start} - ${s.end}`;
  });
  return out;
}

// Розбір + часи → структура, яку розуміє портал: lessons[День][слот] = [урок]
export function toSchedule(parsed, times){
  const lessons = {}, missing = new Set();
  Object.entries(parsed.days).forEach(([day, slots]) => {
    lessons[day] = slots.map((items, i) => {
      if(!items.length) return {};
      const time = times[i + 1] || '';
      if(!time) missing.add(i + 1);
      return items.map(name => ({
        number: i + 1,
        subject: { ua: name, pl: name },
        time,
        teacherEmail: '',
        teacherName: '',
        type: 'lesson'
      }));
    });
  });
  return { lessons, missingTimes: [...missing].sort((a,b)=>a-b) };
}

// ══════════════════════════════════════════════════════════════════
//  ІНТЕРФЕЙС
// ══════════════════════════════════════════════════════════════════
// mammoth вантажимо на першу потребу, а не при завантаженні кабінету:
// бібліотека потрібна лише директору й лише коли він імпортує розклад.
let mammothPromise = null;
function loadMammoth(){
  if(window.mammoth) return Promise.resolve(window.mammoth);
  if(mammothPromise) return mammothPromise;
  mammothPromise = new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    s.onload = () => window.mammoth ? ok(window.mammoth) : bad(new Error('бібліотека не завантажилась'));
    s.onerror = () => bad(new Error('не вдалося завантажити бібліотеку читання .docx'));
    document.head.appendChild(s);
  });
  return mammothPromise;
}

let parsedSchedule = null, parsedTitle = '';

window.handleScheduleFile = async function(e){
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  const box = document.getElementById('si-preview');
  const drop = document.getElementById('si-drop-text');
  if(drop) drop.textContent = `📄 ${file.name}`;
  if(box) box.innerHTML = '<p class="empty-msg">Читаю файл...</p>';
  parsedSchedule = null;
  try{
    const mammoth = await loadMammoth();
    const buf = await file.arrayBuffer();
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: buf });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if(!table) throw new Error('у файлі немає таблиці з розкладом');
    const rows = [...table.rows].map(tr => [...tr.cells].map(td => td.textContent));
    parsedTitle = doc.body.textContent.slice(0, 200);
    parsedSchedule = parseScheduleTable(rows);
    if(!parsedSchedule) throw new Error('не вдалося впізнати таблицю: у першому рядку мають бути назви днів, у першій колонці — номери уроків');
    // Клас із заголовка — лише підказка; вирішує те, що обрано в списку
    const guess = classFromTitle(parsedTitle) || classFromTitle(file.name);
    const sel = document.getElementById('si-class');
    if(guess && sel && !sel.dataset.touched) sel.value = `class_${guess}`;
    await renderSchedulePreview(guess);
  }catch(err){
    if(box) box.innerHTML = `<p class="empty-msg" style="color:var(--red);">${escHtml(err.message)}</p>`;
  }
};

window.onSiClassChange = function(){
  const sel = document.getElementById('si-class');
  if(sel) sel.dataset.touched = '1';
  if(parsedSchedule) renderSchedulePreview(null);
};

async function renderSchedulePreview(guess){
  const box = document.getElementById('si-preview');
  if(!box || !parsedSchedule) return;
  const cls = document.getElementById('si-class').value;

  // Час уроків беремо з дзвінків класу. Без нього урок не показується
  // батькам узагалі — тому це блокує імпорт, а не просто попереджає.
  let times = {};
  try{
    const snap = await get(child(ref(db), `bell_schedules/${cls}`));
    if(snap.exists()) times = bellTimes(snap.val());
  }catch(e){ console.warn('bell_schedules:', e.message); }

  const built = toSchedule(parsedSchedule, times);
  window._siBuilt = built;

  const DOW = { Monday:'Пн', Tuesday:'Вт', Wednesday:'Ср', Thursday:'Чт', Friday:'Пт', Saturday:'Сб' };
  const order = Object.keys(DOW).filter(d => parsedSchedule.days[d]);
  let head = '<tr><th>№</th>' + order.map(d => `<th>${DOW[d]}</th>`).join('') + '</tr>';
  let body = '';
  for(let i = 0; i < parsedSchedule.maxNum; i++){
    body += `<tr><td class="si-num">${i + 1}<span>${escHtml(times[i + 1] || 'без часу')}</span></td>`
      + order.map(d => {
          const items = parsedSchedule.days[d][i] || [];
          return `<td>${items.length ? items.map(x => escHtml(x)).join('<br><i>+ паралельно</i><br>') : ''}</td>`;
        }).join('') + '</tr>';
  }

  const problems = [];
  if(built.missingTimes.length)
    problems.push(`<b>Немає часу для уроків ${built.missingTimes.join(', ')}.</b> Заповніть розклад дзвінків `
      + `цього класу — інакше ці уроки не побачать ні батьки, ні учні.`);
  parsedSchedule.warnings.forEach(w => problems.push(escHtml(w)));
  if(guess && `class_${guess}` !== cls)
    problems.push(`У файлі згадано ${guess} клас, а обрано ${cls.replace('class_','')}. Перевірте, чи це те, що потрібно.`);

  box.innerHTML = `
    <div class="si-sum">Розпізнано: днів ${order.length}, уроків ${parsedSchedule.lessons}</div>
    <div class="si-scroll"><table class="si-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    ${problems.map(p => `<div class="si-warn">${p}</div>`).join('')}
    <button type="button" id="si-save" onclick="saveImportedSchedule()"
            ${built.missingTimes.length ? 'disabled' : ''}>💾 Зберегти розклад</button>`;
}

window.saveImportedSchedule = async function(){
  const built = window._siBuilt;
  if(!built) return;
  const cls = document.getElementById('si-class').value;
  const dest = document.getElementById('si-dest').value;   // 'live' або назва чернетки
  const btn = document.getElementById('si-save');
  const where = dest === 'live' ? 'ЧИННИЙ розклад школи' : `чернетку «${dest}»`;
  if(!confirm(`Зберегти розклад ${cls.replace('class_','')} класу у ${where}?\n\n`
    + 'Попередній розклад цього класу буде замінено повністю.'
    + (dest === 'live' ? '\n\nЗміни одразу побачать батьки та вчителі.' : ''))) return;
  btn.disabled = true; btn.textContent = '⏳ Зберігаю...';
  try{
    const path = dest === 'live' ? `schedules/${cls}` : `schedule_drafts/${dest}/${cls}`;
    await set(ref(db, path), { lessons: built.lessons });
    logAction('settings', { value: `розклад ${cls} імпортовано з Word у ${dest === 'live' ? 'чинний' : dest}` });
    showToast('✅ Розклад збережено');
    document.getElementById('si-preview').innerHTML =
      `<p class="empty-msg">Збережено у ${escHtml(where)}.</p>`;
    parsedSchedule = null;
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = '💾 Зберегти розклад';
  }
};

// Список призначень: чинний розклад і наявні чернетки
window.fillImportDest = async function(){
  const sel = document.getElementById('si-dest');
  if(!sel) return;
  let drafts = [];
  try{
    const snap = await get(child(ref(db), 'schedule_drafts'));
    if(snap.exists()) drafts = Object.keys(snap.val() || {});
  }catch(e){ console.warn('schedule_drafts:', e.message); }
  sel.innerHTML = drafts.map(d => `<option value="${escHtml(d)}">Чернетка «${escHtml(d)}»</option>`).join('')
    + '<option value="live">Чинний розклад школи</option>';
};
